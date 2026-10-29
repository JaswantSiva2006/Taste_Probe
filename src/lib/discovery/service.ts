import "server-only";
import type {
  AgentDecision,
  AnswerRequest,
  DiscoveryView,
  EntitySummary,
  FinishReason,
  Question,
  RecommendationUpdate,
  StartRequest,
  TurnTrace,
} from "@/lib/contracts";
import type { AgentMode, BoundedAgent } from "@/lib/agent/bounded";
import type { QuestionGenerator } from "@/lib/agent/question-generation/proposer";
import { MAX_REQUESTS_PER_DECISION } from "@/lib/agent/gemini-agent";
import type { DiscoveryAgent } from "@/lib/agent/types";
import { validateAgentDecision } from "@/lib/agent/validate";
import type { AppConfig } from "@/lib/config/env";
import { logEvent } from "@/lib/telemetry/logger";
import type { QlooProvider } from "@/lib/qloo/provider";
import { createSessionService, type Lease, type SessionService } from "@/lib/session/service";
import { createSession, type SessionState } from "@/lib/session/state";
import type { SessionStore } from "@/lib/session/store";
import { AppError } from "@/lib/validation/errors";
import {
  applyLedger,
  countingProvider,
  decideAndExecute,
  newLedger,
  retrieve,
  traceOf,
  type LiveDeps,
  type LiveLedger,
  type LiveOutcome,
} from "./live-turn";
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
  /**
   * S6 bounded agent. Present in live mode (createDiscoveryDeps): turns then run
   * the S7 live loop. Absent in mock mode, which keeps the original S1–S5 path.
   */
  boundedAgent?: BoundedAgent;
  questionGenerator?: QuestionGenerator;
  selectQuestions?: QuestionSelector;
  now?: () => number;
};

const MIN_CANDIDATES = 2;
/** Matches the live provider's own cap; on failure the full cap is charged (fail closed). */
const RETRIEVAL_ATTEMPT_CAP = 2;

/** External usage incurred by one request, kept even when the request later fails. */
type UsageLedger = { qlooCalls: number; toolCalls: number };

/**
 * Live turns hold the S4 lease across Qloo and Gemini calls, so the lease must
 * outlive their worst case: 2 Qloo attempts plus 2 decisions x 2 Gemini requests, plus slack.
 */
const leaseTtlFor = (config: AppConfig) =>
  config.qloo.timeoutMs * 2 + config.llm.timeoutMs * (MAX_REQUESTS_PER_DECISION * 2 + 1) + 10_000;

const sessionsOf = (deps: DiscoveryDeps): SessionService =>
  createSessionService({
    store: deps.store,
    settings: deps.config.session,
    mode: deps.config.mode,
    now: deps.now,
    leaseTtlMs: deps.boundedAgent ? leaseTtlFor(deps.config) : undefined,
  });

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
    const questionCandidates = deps.config.features.adaptiveQuestioning
      ? availableQuestions(buildQuestionCandidates(current.candidates, current.session.targetType), current.session)
      : [];
    const offered = select(questionCandidates, ranked, current.session);
    const stop = deps.config.features.earlyStopping
      ? evaluateStop(current.session, offered.length)
      : evaluateStop(current.session, Math.max(1, offered.length));
    const raw = await deps.agent.decide({
      candidateCount: current.candidates.length,
      minCandidates: MIN_CANDIDATES,
      qlooCallsRemaining: limits.maxQlooCallsPerSession - current.session.qlooCallCount,
      stop,
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

type LiveExtras = {
  mode: AgentMode;
  fallbackReason: string | null;
  update: RecommendationUpdate | null;
  degraded: string | null;
  trace: TurnTrace;
};

/** Live results must be Qloo-grounded and of the target type; anything else is a server defect. */
function assertGrounded(deps: DiscoveryDeps, state: SessionState): void {
  if (deps.config.mode !== "live") return;
  for (const c of state.candidates) {
    if (c.evidence.source !== "qloo" || c.entityId.startsWith("mock:") || c.entityType !== state.session.targetType) {
      throw new AppError("INTERNAL_ERROR", 500, "Ungrounded recommendation in live session");
    }
  }
}

function toView(
  deps: DiscoveryDeps,
  state: SessionState,
  previousOrder: string[] | null,
  decision: AgentDecision,
  sessionToken: string,
  revision: number,
  live?: LiveExtras,
): DiscoveryView {
  assertGrounded(deps, state);
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
    agent: live
      ? { name: deps.boundedAgent?.name ?? deps.agent.name, decision, mode: live.mode, fallbackReason: live.fallbackReason }
      : { name: deps.agent.name, decision },
    usage: {
      qlooCallCount: session.qlooCallCount,
      maxQlooCalls: deps.config.limits.maxQlooCallsPerSession,
      agentToolCallCount: session.agentToolCallCount,
      ...(session.geminiRequestCount !== undefined ? { geminiRequestCount: session.geminiRequestCount } : {}),
    },
    ...(live ? { recommendationUpdate: live.update, degraded: live.degraded ? { reason: live.degraded } : null, trace: live.trace } : {}),
  };
}

const TOP_K = 5;
const topIds = (state: SessionState, previousOrder: string[] | null) =>
  orderOf(rankCandidates(state.candidates, state.session, previousOrder)).slice(0, TOP_K);

function liveDepsOf(deps: DiscoveryDeps, ledger: LiveLedger): LiveDeps {
  return {
    config: deps.config,
    provider: countingProvider(deps.provider, ledger),
    boundedAgent: deps.boundedAgent!,
    questionGenerator: deps.questionGenerator,
    now: deps.now ?? Date.now,
  };
}

/** Structured per-request trace: counts, decisions, cost. Never tokens, prompts or secrets. */
function logTurn(deps: DiscoveryDeps, kind: string, ledger: LiveLedger, fields: Record<string, unknown>): void {
  const t = traceOf(ledger, deps.store.kind);
  logEvent("info", "discovery.turn", {
    kind,
    sessionStore: t.sessionStore,
    turnId: t.turnId,
    qlooRequests: t.qlooRequests,
    geminiRequests: t.geminiRequests,
    geminiTokens: t.geminiTokens,
    estimatedGeminiCostUsd: t.estimatedGeminiCostUsd,
    latencyMs: t.latencyMs,
    decisions: t.decisions,
    questionGeneration: t.questionGeneration,
    degraded: ledger.degraded,
    ...fields,
  });
}

/** S7 live start: verified seed -> initial Qloo retrieval -> S5 -> S6 decision -> atomic create. */
async function startLive(deps: DiscoveryDeps, input: StartRequest): Promise<DiscoveryView> {
  const ledger = newLedger();
  const live = liveDepsOf(deps, ledger);
  const seed = await resolveSeed({ ...deps, provider: live.provider }, input);
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
  // Initial retrieval is application-driven (not an agent tool call); no session exists yet to lock.
  const retrieved = await retrieve(live, initial, ledger, { positiveTagIds: [], positiveEntityIds: [] });
  if (!retrieved) throw new AppError("NO_RECOMMENDATIONS", 422, `No ${input.targetType} recommendations for this entity`);

  const outcome = await decideAndExecute(live, retrieved, ledger, { allowRetrieval: false });
  const final = applyLedger(withOrder(applyOutcome(outcome.state, outcome.question, outcome.decision), null), ledger);
  const token = await sessionsOf(deps).create(final);
  const update: RecommendationUpdate = {
    mechanism: "INITIAL_RETRIEVAL",
    qlooRequested: true,
    internalCorrelationIds: [...ledger.correlationIds],
    previousTopIds: [],
    updatedTopIds: topIds(final, null),
    preferenceIds: [],
  };
  logTurn(deps, "start", ledger, { revision: 0, action: outcome.decision.action, selectedQuestionId: outcome.decision.selectedQuestionId ?? null, mechanism: update.mechanism });
  return toView(deps, final, null, outcome.decision, token, 0, liveExtras(deps, ledger, outcome, update));
}

function liveExtras(deps: DiscoveryDeps, ledger: LiveLedger, outcome: LiveOutcome, update: RecommendationUpdate): LiveExtras {
  return {
    mode: outcome.mode,
    fallbackReason: outcome.fallbackReason,
    update,
    degraded: ledger.degraded,
    trace: traceOf(ledger, deps.store.kind),
  };
}

/** Preference IDs newly confirmed by an answer (positive ones may justify reretrieval). */
function preferenceDelta(before: SessionState["session"], after: SessionState["session"]) {
  const added = (a: string[], b: string[]) => b.filter((id) => !a.includes(id));
  const positive = [...added(before.positiveTagIds, after.positiveTagIds), ...added(before.positiveEntityIds, after.positiveEntityIds)];
  const negative = [...added(before.rejectedTagIds, after.rejectedTagIds), ...added(before.rejectedEntityIds, after.rejectedEntityIds)];
  return { positive, all: [...positive, ...negative] };
}

const nowOf = (deps: DiscoveryDeps) => (deps.now ?? Date.now)();

export async function startDiscovery(deps: DiscoveryDeps, input: StartRequest): Promise<DiscoveryView> {
  if (deps.boundedAgent) return startLive(deps, input);
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

  // Everything above is validation against authoritative state; no paid call has happened.
  const lease: Lease = await sessions.acquire(loaded);
  if (deps.boundedAgent) return answerLive(deps, sessions, lease, state, answer);
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

/**
 * S7 live answer, holding the S4 lease: record the explicit preference, let the
 * agent decide (retrieval offered only when the answer added a confirmed positive
 * signal and budget remains), execute, then commit revision+1 atomically.
 */
async function answerLive(
  deps: DiscoveryDeps,
  sessions: SessionService,
  lease: Lease,
  state: SessionState,
  answer: ReturnType<typeof buildAnswer>,
): Promise<DiscoveryView> {
  const ledger = newLedger();
  const live = liveDepsOf(deps, ledger);
  let outcome: LiveOutcome;
  let next: SessionState;
  const updated: SessionState = { ...state, session: { ...applyAnswer(state.session, answer), currentQuestionId: undefined } };
  const delta = preferenceDelta(state.session, updated.session);
  try {
    outcome = await decideAndExecute(live, updated, ledger, { allowRetrieval: delta.positive.length > 0 });
    next = applyLedger(withOrder(applyOutcome(outcome.state, outcome.question, outcome.decision), state.order), ledger);
  } catch (error) {
    // Nothing applied; usage already consumed stays charged.
    await releaseQuietly(sessions, lease, applyLedger(state, ledger));
    throw error;
  }
  const token = await sessions.commit(lease, next);

  const previousTopIds = state.order.slice(0, TOP_K);
  const updatedTopIds = topIds(next, state.order);
  const update: RecommendationUpdate = {
    mechanism: ledger.retrieved ? "QLOO_RERETRIEVAL" : sameOrder(state.order, next.order) ? "UNCHANGED" : "LOCAL_RERANK",
    qlooRequested: ledger.retrieved,
    internalCorrelationIds: [...ledger.correlationIds],
    previousTopIds,
    updatedTopIds,
    preferenceIds: delta.all,
  };
  logTurn(deps, "answer", ledger, {
    revision: lease.revision + 1,
    action: outcome.decision.action,
    selectedQuestionId: outcome.decision.selectedQuestionId ?? null,
    response: answer.response,
    preferenceChanges: delta.all.length,
    mechanism: update.mechanism,
  });
  return toView(deps, next, state.order, outcome.decision, token, lease.revision + 1, liveExtras(deps, ledger, outcome, update));
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
