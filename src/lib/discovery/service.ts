import "server-only";
import type { AgentDecision, AnswerRequest, DiscoveryView, EntitySummary, FinishReason, Question, StartRequest } from "@/lib/contracts";
import type { DiscoveryAgent } from "@/lib/agent/types";
import { validateAgentDecision } from "@/lib/agent/validate";
import type { AppConfig } from "@/lib/config/env";
import type { QlooProvider } from "@/lib/qloo/provider";
import { createSessionService, type Lease, type SessionService } from "@/lib/session/service";
import { createSession, type SessionState } from "@/lib/session/state";
import type { SessionStore } from "@/lib/session/store";
import { AppError } from "@/lib/validation/errors";
import { normalizeEntity, normalizeRecommendations, normalizeSearchResults } from "./normalize";
import { applyAnswer, buildAnswer } from "./preferences";
import {
  availableQuestions,
  buildQuestionCandidates,
  selectQuestionsByBalanceHeuristic,
  type QuestionSelector,
} from "./questions";
import { orderOf, rankCandidates, sameOrder } from "./ranking";
import { evaluateStop } from "./stop";

/** G1/G2 orchestration: wires provider, normalizer, questions, agent and session. */

export type DiscoveryDeps = {
  config: AppConfig;
  provider: QlooProvider;
  agent: DiscoveryAgent;
  /** Authoritative session state (memory in dev/tests, Redis in production). */
  store: SessionStore;
  selectQuestions?: QuestionSelector;
  now?: () => number;
};

const MIN_CANDIDATES = 2;
/** Matches the live provider's own cap; on failure the full cap is charged (fail closed). */
const RETRIEVAL_ATTEMPT_CAP = 2;

/** External usage incurred by one request, kept even when the request later fails. */
type UsageLedger = { qlooCalls: number; toolCalls: number };

const sessionsOf = (deps: DiscoveryDeps): SessionService =>
  createSessionService({ store: deps.store, settings: deps.config.session, mode: deps.config.mode, now: deps.now });

function withUsage(state: SessionState, ledger: UsageLedger): SessionState {
  return {
    ...state,
    session: {
      ...state.session,
      qlooCallCount: state.session.qlooCallCount + ledger.qlooCalls,
      agentToolCallCount: state.session.agentToolCallCount + ledger.toolCalls,
    },
  };
}

export async function searchEntities(deps: DiscoveryDeps, q: string, type?: EntitySummary["entityType"]) {
  return { results: normalizeSearchResults(await deps.provider.searchEntities(q, type)) };
}

async function resolveSeed(deps: DiscoveryDeps, input: StartRequest): Promise<EntitySummary> {
  let seed: EntitySummary | null = null;
  if (input.selectedEntityId) {
    // Re-resolve the client-selected ID against provider results for the submitted query.
    // This keeps untrusted client IDs behind the server-side provider boundary.
    const result = await deps.provider.searchEntities(input.entityQuery);
    const raw = result.payload.results.find((entity) => entity.entity_id === input.selectedEntityId);
    if (raw) {
      seed = normalizeEntity(raw, result.provenance);
    } else {
      const byId = await deps.provider.getEntity(input.selectedEntityId);
      seed = byId.payload ? normalizeEntity(byId.payload, byId.provenance) : null;
    }
    if (!seed) throw new AppError("ENTITY_NOT_FOUND", 404, "Selected entity was not found");
  } else {
    const { results } = await searchEntities(deps, input.entityQuery, input.sourceType);
    const exact = results.filter((e) => e.name.toLowerCase() === input.entityQuery.trim().toLowerCase());
    if (exact.length !== 1) {
      throw new AppError("ENTITY_NOT_RESOLVED", 400, "Select an entity from search results before starting");
    }
    seed = exact[0]!;
  }
  if (seed.entityType !== input.sourceType) {
    throw new AppError("ENTITY_TYPE_MISMATCH", 400, `Selected entity is not a ${input.sourceType}`);
  }
  return seed;
}

/** Bounded agent step loop: executes `retrieve` tool calls until the agent asks or finishes. */
async function runAgent(
  deps: DiscoveryDeps,
  state: SessionState,
  ledger: UsageLedger = { qlooCalls: 0, toolCalls: 0 },
): Promise<{ state: SessionState; decision: AgentDecision; question: Question | null }> {
  const { limits } = deps.config;
  const select = deps.selectQuestions ?? selectQuestionsByBalanceHeuristic;
  let current = state;

  for (let toolCalls = 0; ; ) {
    const ranked = rankCandidates(current.candidates, current.session);
    const offered = select(
      availableQuestions(buildQuestionCandidates(current.candidates, current.session.targetType), current.session),
      ranked,
    );
    const raw = await deps.agent.decide({
      candidateCount: current.candidates.length,
      minCandidates: MIN_CANDIDATES,
      qlooCallsRemaining: limits.maxQlooCallsPerSession - current.session.qlooCallCount,
      stop: evaluateStop(current.session, offered.length),
      rankedQuestions: offered,
    });
    const decision = validateAgentDecision(raw, offered);

    if (decision.action === "ask") {
      if (current.session.questionCount >= current.session.maxQuestions) {
        throw new AppError("AGENT_DECISION_INVALID", 500, "Agent tried to exceed the question budget");
      }
      const question = offered.find((q) => q.questionId === decision.selectedQuestionId)!;
      return { state: current, decision, question };
    }
    if (decision.action === "finish") {
      return { state: current, decision, question: null };
    }
    if (decision.action === "enrich") {
      throw new AppError("AGENT_DECISION_INVALID", 500, "Enrichment is not available in this build");
    }

    // action === "retrieve"
    if (toolCalls >= limits.maxAgentToolCallsPerTurn) {
      throw new AppError("AGENT_DECISION_INVALID", 500, "Agent exceeded its tool-call budget for this turn");
    }
    if (current.session.qlooCallCount >= limits.maxQlooCallsPerSession) {
      throw new AppError("QLOO_BUDGET_EXHAUSTED", 429, "Recommendation retrieval budget exhausted");
    }
    toolCalls += 1;
    const attemptCap = Math.min(RETRIEVAL_ATTEMPT_CAP, limits.maxQlooCallsPerSession - current.session.qlooCallCount);
    ledger.toolCalls += 1;
    let result;
    try {
      result = await deps.provider.getRecommendations({
        seedEntityIds: current.session.anchorIds,
        targetType: current.session.targetType,
        take: limits.maxRecommendationCandidates,
        positiveEntityIds: current.session.positiveEntityIds,
        positiveTagIds: current.session.positiveTagIds,
        excludedEntityIds: current.session.rejectedEntityIds,
        excludedTagIds: current.session.rejectedTagIds,
        includeExplainability: deps.config.mode === "live",
        maxAttempts: attemptCap,
      });
    } catch (error) {
      // The number of upstream attempts is unknown on failure: charge the cap.
      ledger.qlooCalls += attemptCap;
      throw error;
    }
    const used = Math.max(1, result.requestCount);
    ledger.qlooCalls += used;
    const candidates = normalizeRecommendations(result, current.session.anchorIds, limits.maxRecommendationCandidates);
    current = {
      ...current,
      candidates,
      session: {
        ...current.session,
        qlooCallCount: current.session.qlooCallCount + used,
        agentToolCallCount: current.session.agentToolCallCount + 1,
      },
    };
    if (candidates.length === 0) {
      throw new AppError("NO_RECOMMENDATIONS", 422, `No ${current.session.targetType} recommendations for this entity`);
    }
  }
}

/** Applies the agent outcome: presents the next question or finishes the session. */
function applyOutcome(
  state: SessionState,
  question: Question | null,
  decision: AgentDecision,
): SessionState {
  if (question) {
    return {
      ...state,
      session: {
        ...state.session,
        currentQuestionId: question.questionId,
        askedQuestionIds: [...state.session.askedQuestionIds, question.questionId],
        questionCount: state.session.questionCount + 1,
      },
    };
  }
  const reason: FinishReason =
    decision.reasonCode === "question_budget_exhausted" ? "question_budget_exhausted" : "stable_recommendations";
  return finishState(state, reason);
}

function finishState(state: SessionState, reason: FinishReason): SessionState {
  return {
    ...state,
    finishReason: reason,
    session: { ...state.session, status: "finished", currentQuestionId: undefined },
  };
}

/** Records the ranked order the user will see, so the next transition can report movement. */
function withOrder(state: SessionState, previousOrder: string[] | null): SessionState {
  return { ...state, order: orderOf(rankCandidates(state.candidates, state.session, previousOrder)) };
}

function toView(
  deps: DiscoveryDeps,
  state: SessionState,
  previousOrder: string[] | null,
  decision: AgentDecision,
  sessionToken: string,
  revision: number,
): DiscoveryView {
  const { session } = state;
  const ranked = rankCandidates(state.candidates, session, previousOrder);
  const finished = session.status === "finished";
  const currentQuestion = session.currentQuestionId
    ? (buildQuestionCandidates(state.candidates, session.targetType).find(
        (q) => q.questionId === session.currentQuestionId,
      ) ?? null)
    : null;
  return {
    sessionToken,
    sessionId: session.sessionId,
    revision,
    status: finished ? "finished" : "asking",
    finishReason: state.finishReason,
    seed: state.seed,
    targetType: session.targetType,
    questionCount: session.questionCount,
    maxQuestions: session.maxQuestions,
    currentQuestion,
    lastAnswer: session.answers.at(-1) ?? null,
    preferences: {
      positiveTagIds: session.positiveTagIds,
      rejectedTagIds: session.rejectedTagIds,
      positiveEntityIds: session.positiveEntityIds,
      rejectedEntityIds: session.rejectedEntityIds,
    },
    recommendations: finished ? ranked.slice(0, deps.config.limits.finalRecommendationCount) : ranked,
    rankingChanged: previousOrder !== null && !sameOrder(previousOrder, orderOf(ranked)),
    agent: { name: deps.agent.name, decision },
    usage: {
      qlooCallCount: session.qlooCallCount,
      maxQlooCalls: deps.config.limits.maxQlooCallsPerSession,
      agentToolCallCount: session.agentToolCallCount,
    },
  };
}

const nowOf = (deps: DiscoveryDeps) => (deps.now ?? Date.now)();

export async function startDiscovery(deps: DiscoveryDeps, input: StartRequest): Promise<DiscoveryView> {
  const seed = await resolveSeed(deps, input);
  const session = createSession({
    anchorIds: [seed.entityId],
    sourceType: input.sourceType,
    targetType: input.targetType,
    maxQuestions: Math.min(input.maxQuestions, deps.config.limits.maxQuestions),
    mode: deps.config.mode,
    now: nowOf(deps),
    ttlSeconds: deps.config.session.ttlSeconds,
  });
  const initial: SessionState = { session, seed, candidates: [], order: [], finishReason: null };
  const { state, decision, question } = await runAgent(deps, initial);
  const final = withOrder(applyOutcome(state, question, decision), null);
  const token = await sessionsOf(deps).create(final);
  return toView(deps, final, null, decision, token, 0);
}

/**
 * Answer transition. Order matters for replay safety:
 * 1. load: token revision must equal the store's current revision (stale -> 409, no work done);
 * 2. validate the answer against the authoritative state (invalid -> 4xx, no side effects);
 * 3. acquire a lease by CAS so a concurrent request for the same revision gets 409
 *    before it can reach the agent or Qloo;
 * 4. commit revision+1 by CAS; on any failure release the lease, keeping consumed usage.
 */
export async function answerDiscovery(deps: DiscoveryDeps, input: AnswerRequest): Promise<DiscoveryView> {
  const sessions = sessionsOf(deps);
  const loaded = await sessions.load(input.sessionToken);
  const { state } = loaded;
  const { session } = state;

  if (session.status === "finished" || !session.currentQuestionId) {
    if (session.questionCount >= session.maxQuestions) {
      throw new AppError("QUESTION_BUDGET_EXHAUSTED", 409, `No more than ${session.maxQuestions} questions can be answered`);
    }
    throw new AppError("SESSION_FINISHED", 409, "This discovery session is already finished");
  }

  const allQuestions = buildQuestionCandidates(state.candidates, session.targetType);
  if (input.questionId !== session.currentQuestionId) {
    const known = allQuestions.some((q) => q.questionId === input.questionId);
    throw known
      ? new AppError("QUESTION_MISMATCH", 409, "That question is not the active question")
      : new AppError("INVALID_QUESTION", 400, "Unknown question ID");
  }
  const question = allQuestions.find((q) => q.questionId === input.questionId);
  if (!question) throw new AppError("INVALID_QUESTION", 400, "Unknown question ID");

  const answer = buildAnswer(question, input.response, nowOf(deps));

  const lease: Lease = await sessions.acquire(loaded);
  const ledger: UsageLedger = { qlooCalls: 0, toolCalls: 0 };
  let outcome: { next: SessionState; decision: AgentDecision };
  try {
    const updated: SessionState = {
      ...state,
      session: { ...applyAnswer(session, answer), currentQuestionId: undefined },
    };
    const { state: next, decision, question: nextQuestion } = await runAgent(deps, updated, ledger);
    outcome = { next: withOrder(applyOutcome(next, nextQuestion, decision), state.order), decision };
  } catch (error) {
    await releaseQuietly(sessions, lease, withUsage(state, ledger));
    throw error;
  }
  const token = await sessions.commit(lease, outcome.next);
  return toView(deps, outcome.next, state.order, outcome.decision, token, lease.revision + 1);
}

/** Frees the lease after a failed turn; the original error is what the client sees. */
async function releaseQuietly(sessions: SessionService, lease: Lease, state: SessionState): Promise<void> {
  try {
    await sessions.release(lease, state);
  } catch {
    // Lease expires after LEASE_TTL_MS; usage recorded so far stays in the store.
  }
}

export async function finishDiscovery(deps: DiscoveryDeps, sessionToken: string): Promise<DiscoveryView> {
  const sessions = sessionsOf(deps);
  const loaded = await sessions.load(sessionToken);
  const { state } = loaded;
  const decision: AgentDecision = {
    action: "finish",
    reasonCode:
      state.finishReason === "question_budget_exhausted" ? "question_budget_exhausted" : "stable_recommendations",
    done: true,
  };
  if (state.session.status === "finished") {
    // Idempotent for the current token only: no write, same final shortlist.
    return toView(deps, state, state.order, decision, sessions.tokenFor(loaded), loaded.revision);
  }
  // Lock-free CAS: fails with 409 if an answer holds the lease or already advanced the revision.
  const finished = withOrder(finishState(state, "user_finished"), state.order);
  const token = await sessions.commit(loaded, finished);
  return toView(deps, finished, state.order, decision, token, loaded.revision + 1);
}
