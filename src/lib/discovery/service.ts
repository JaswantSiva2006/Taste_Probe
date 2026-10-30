import "server-only";
import type {
  AgentDecision,
  AnswerRequest,
  ContinueRequest,
  DiscoveryView,
  EntitySummary,
  ExplorationState,
  FinishReason,
  ListenRequest,
  ListeningFeedbackRequest,
  ListeningState,
  SavedDiscovery,
  SongSelection,
  VerifiedSongOption,
  Question,
  RankedRecommendation,
  RecommendationFeedbackRequest,
  RecommendationUpdate,
  StartRequest,
  TurnTrace,
} from "@/lib/contracts";
import { domainLabel, enabledSourceDomains, pairAccess, type PairAccess } from "@/lib/contracts";
import type { AgentMode, BoundedAgent } from "@/lib/agent/bounded";
import type { QuestionGenerator } from "@/lib/agent/question-generation/proposer";
import type { SongSelector } from "@/lib/agent/song-selector";
import {
  deterministicSong,
  eligibleOptions,
  emptyListening,
  listeningViewOf,
  nextArtistIds,
  optionsFrom,
  recordEncounter,
  trackReactions,
  withArtistFeedback,
  withNavigation,
  withTrackFeedback,
} from "@/lib/music/listening";
import { resolveArtistVideo } from "@/lib/music/resolver";
import type { DynamicLookup } from "@/lib/music/youtube-data";
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
  retrieveAdaptive,
  traceOf,
  type AdaptiveRetrievalResult,
  type LiveDeps,
  type LiveLedger,
  type LiveOutcome,
} from "./live-turn";
import { normalizeEntity, normalizeSearchResults, normalizeTargetCandidates } from "./normalize";
import { buildDiscoveryPath } from "./path";
import { applyAnswer, buildAnswer } from "./preferences";
import {
  availableQuestions,
  buildQuestionCandidates,
  questionDimension,
  selectQuestionsByBalanceHeuristic,
  type QuestionSelector,
} from "./questions";
import { orderOf, rankCandidates, sameOrder } from "./ranking";
import { evaluateStop } from "./stop";
import { initializeAdaptivePool, synchronizeAdaptivePool } from "./adaptive-pool";

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
  /** S9.12: Gemini song-selection mode (live mode with a configured model only). */
  songSelector?: SongSelector;
  /** S9.12: optional YouTube Data API tier (with quota guard and cache); absent without a key. */
  musicLookup?: DynamicLookup;
  now?: () => number;
  requestId?: string;
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

/** Public anchor search: a typed search must name a source of an enabled pair (checked before Qloo). */
export async function searchAnchors(deps: DiscoveryDeps, q: string, type?: EntitySummary["entityType"]) {
  if (type && !enabledSourceDomains(deps.config.verification.pairs).includes(type)) {
    throw new AppError("UNSUPPORTED_DOMAIN", 400, `Searching for a ${type} anchor is not supported`);
  }
  return searchEntities(deps, q, type);
}

/**
 * Registry gate for Start. Runs before seed resolution, so a rejected pair costs
 * no provider call. Only server configuration (never the request) can admit a
 * disabled pair, and only outside production.
 */
export function assertEnabledPair(
  input: Pick<StartRequest, "sourceType" | "targetType">,
  verificationPairs: readonly string[] = [],
): PairAccess {
  const access = pairAccess(input.sourceType, input.targetType, verificationPairs);
  if (access === "disabled" || access === "unregistered") {
    throw new AppError(
      "UNSUPPORTED_DOMAIN",
      400,
      `${input.sourceType} -> ${input.targetType} discovery is ${access === "disabled" ? "not available yet" : "not supported"}`,
    );
  }
  return access;
}

async function resolveSeed(deps: DiscoveryDeps, input: StartRequest): Promise<EntitySummary> {
  let seed: EntitySummary | null = null;
  if (input.selectedEntityId) {
    // Re-resolve the client-selected ID against provider results for the submitted query,
    // filtered to the registry's source type. This keeps untrusted client IDs behind the
    // server-side provider boundary; the ID is never derived from a name.
    const result = await deps.provider.searchEntities(input.entityQuery, input.sourceType);
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
      ? availableQuestions(buildQuestionCandidates(current.candidates, current.session.targetType), current.session, current.candidates)
      : [];
    const offered = select(questionCandidates, ranked, current.session);
    const stop = deps.config.features.earlyStopping
      ? evaluateStop(current.session, offered.length)
      : evaluateStop(current.session, Math.max(1, offered.length));
    const raw = await deps.agent.decide({
      candidateCount: current.candidates.length,
      // S9.4 fix: after a retrieval this turn, re-requesting the same signals cannot add
      // candidates, so any verified result is enough to present (the live path behaves
      // the same way). Without this a one-result anchor looped until the tool budget threw.
      minCandidates: toolCalls > 0 ? 1 : MIN_CANDIDATES,
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
    const { candidates } = normalizeTargetCandidates(result, current.session.anchorIds, limits.maxRecommendationCandidates, {
      targetType: current.session.targetType,
      provenance: result.provenance,
    });
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
      throw new AppError("NO_RECOMMENDATIONS", 422, `No ${domainLabel(current.session.targetType, true)} recommendations for this entity`);
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
        // S9.6: the semantic dimension is remembered across rounds, so a rewording cannot repeat it.
        askedDimensions: [...(state.session.askedDimensions ?? []), questionDimension(question, state.candidates)],
        questionCount: state.session.questionCount + 1,
      },
    };
  }
  const reason: FinishReason =
    decision.reasonCode === "question_budget_exhausted"
      ? "question_budget_exhausted"
      : noQuestionEvidence(state)
        ? "insufficient_question_evidence"
        : "stable_recommendations";
  return finishState(state, reason);
}

/**
 * True when the verified candidates support no grounded question at all, so the
 * session finished before asking anything. Never padded with filler questions.
 */
function noQuestionEvidence(state: SessionState): boolean {
  return (
    state.session.questionCount === 0 &&
    availableQuestions(buildQuestionCandidates(state.candidates, state.session.targetType), state.session, state.candidates).length === 0
  );
}

function finishState(state: SessionState, reason: FinishReason): SessionState {
  return {
    ...state,
    finishReason: reason,
    session: { ...state.session, status: "finished", currentQuestionId: undefined },
  };
}

/** S9.6: candidates the user explicitly rejected as recommendations (entity-level, never their tags). */
const dismissedIds = (session: SessionState["session"]): Set<string> =>
  new Set((session.recommendationFeedback ?? []).filter((f) => f.action === "reject" && f.entityId).map((f) => f.entityId!));

/** Candidates still eligible to be shown: explicitly rejected recommendations are withdrawn. */
const visibleCandidates = (state: SessionState) => {
  const dismissed = dismissedIds(state.session);
  return dismissed.size ? state.candidates.filter((c) => !dismissed.has(c.entityId)) : state.candidates;
};

/** Records the ranked order the user will see, so the next transition can report movement. */
function withOrder(state: SessionState, previousOrder: string[] | null): SessionState {
  const ordered = { ...state, order: orderOf(rankCandidates(visibleCandidates(state), state.session, previousOrder)) };
  if (!ordered.adaptivePool) return ordered;
  const shared = {
    presentedIds: ordered.session.presentedEntityIds ?? [],
    // Recommendation rejects only. A question-level dislike is not an artist rejection.
    rejectedIds: [...dismissedIds(ordered.session)],
    round: roundOf(ordered.session),
    at: ordered.session.createdAt,
  };
  // Evaluate the incumbent slate first so a local replacement is auditable, then
  // persist the already-verified replacement selected by the normal ranker.
  const evaluated = synchronizeAdaptivePool(ordered.adaptivePool, {
    ...shared,
    displayedIds: ordered.adaptivePool.displayedIds,
  });
  return {
    ...ordered,
    adaptivePool: synchronizeAdaptivePool(evaluated, {
      ...shared,
      displayedIds: ordered.order.slice(0, 5),
    }),
  };
}

function enableAdaptivePool(deps: DiscoveryDeps, state: SessionState): SessionState {
  if (!deps.config.features.adaptivePool || state.adaptivePool) return state;
  return {
    ...state,
    adaptivePool: initializeAdaptivePool(state.candidates, state.session.targetType, state.order.slice(0, 5), roundOf(state.session), nowOf(deps)),
  };
}

/**
 * Final recommendations for a presenting round. Round 1 (nothing presented yet)
 * is the unchanged top N. Later rounds prefer verified candidates not presented
 * before, then fill with earlier ones; the result keeps rank order and positions.
 */
function finalRecommendations(deps: DiscoveryDeps, session: SessionState["session"], ranked: RankedRecommendation[]): RankedRecommendation[] {
  const n = deps.config.limits.finalRecommendationCount;
  const presented = new Set(session.presentedEntityIds ?? []);
  if (!presented.size) return ranked.slice(0, n);
  const unseen = ranked.filter((r) => !presented.has(r.candidate.entityId));
  const seen = ranked.filter((r) => presented.has(r.candidate.entityId));
  return [...unseen, ...seen].slice(0, n).sort((a, b) => a.position - b.position);
}

const roundOf = (session: SessionState["session"]) => session.round ?? 1;

/** Gemini requests one more decision may need (a call plus its bounded repair). */
const GEMINI_RESERVE = MAX_REQUESTS_PER_DECISION;

/** S9.6 exploration summary; every number derives from the stored state. */
function explorationOf(deps: DiscoveryDeps, state: SessionState, finalIds: string[]): ExplorationState {
  const { session } = state;
  const dismissed = dismissedIds(session);
  const presented = session.presentedEntityIds ?? [];
  const shownNow = session.status === "active" ? [] : finalIds;
  const eligible = state.candidates.filter((c) => !dismissed.has(c.entityId) && !session.rejectedEntityIds.includes(c.entityId));
  const unseen = eligible.filter((c) => !presented.includes(c.entityId) && !shownNow.includes(c.entityId)).length;
  // A new round is worthwhile only if it can surface an unseen pick or ask an unasked grounded question.
  const questionsLeft =
    eligible.length > 0 &&
    availableQuestions(buildQuestionCandidates(state.candidates, session.targetType), session, state.candidates).length > 0;
  const geminiUsed = session.geminiRequestCount ?? 0;
  const geminiMax = deps.config.limits.maxGeminiRequestsPerExploration;
  const budgetBlocked = Boolean(deps.boundedAgent) && geminiUsed + GEMINI_RESERVE > geminiMax;
  const reason =
    session.status === "active"
      ? "round_in_progress"
      : session.status === "accepted"
        ? "accepted"
        : eligible.length === 0 || (unseen === 0 && !questionsLeft)
          ? "candidates_exhausted"
          : budgetBlocked
            ? "budget_exhausted"
            : null;
  return {
    explorationId: session.sessionId,
    round: roundOf(session),
    status: session.status === "active" ? "asking" : session.status === "accepted" ? "accepted" : "presenting",
    acceptedEntityId: session.acceptedEntityId ?? null,
    rejectedRecommendationIds: [...dismissed],
    totalQuestionsAsked: session.askedQuestionIds.length,
    previouslyPresentedIds: [...presented],
    unseenCandidateCount: unseen,
    canContinue: reason === null,
    continueBlockedReason: reason,
    budget: { qlooUsed: session.qlooCallCount, qlooMax: deps.config.limits.maxQlooCallsPerSession, geminiUsed, geminiMax },
    expiresAt: session.expiresAt,
    answerHistory: answerHistoryOf(state),
  };
}

const ANSWER_HISTORY_LIMIT = 40;
/** Readable fallback for an ID whose verified name is no longer in the candidate pool. */
const lastSegment = (id: string) => (id.split(/[:/]/).filter(Boolean).at(-1) ?? id).replace(/[_-]+/g, " ").trim() || id;

/** S9.7: stored answers with labels resolved from verified candidate data only. */
function answerHistoryOf(state: SessionState): NonNullable<ExplorationState["answerHistory"]> {
  const tags = new Map(state.candidates.flatMap((c) => c.tags.map((t) => [t.id, t.name] as const)));
  const names = new Map(state.candidates.map((c) => [c.entityId, c.name] as const));
  return state.session.answers.slice(-ANSWER_HISTORY_LIMIT).map((a) => ({
    round: a.round ?? 1,
    questionId: a.questionId,
    targetType: a.targetType,
    response: a.response,
    label:
      a.targetType === "tag"
        ? (tags.get(a.targetIds[0] ?? "") ?? lastSegment(a.targetIds[0] ?? ""))
        : a.targetIds.map((id) => names.get(id) ?? lastSegment(id)).join(" vs "),
  }));
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
  const ranked = rankCandidates(visibleCandidates(state), session, previousOrder);
  // "finished" = presenting this round's results; "accepted" is the terminal choice (S9.6).
  const finished = session.status !== "active";
  const recommendations = finished ? finalRecommendations(deps, session, ranked) : ranked;
  const preferences = {
    positiveTagIds: session.positiveTagIds,
    rejectedTagIds: session.rejectedTagIds,
    positiveEntityIds: session.positiveEntityIds,
    rejectedEntityIds: session.rejectedEntityIds,
  };
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
    preferences,
    recommendations,
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
    // Pure presentation of the final list: no provider call, no ranking change, not stored in the session.
    ...(finished
      ? {
          discoveryPath: buildDiscoveryPath({
            recommendations,
            preferences,
            seed: state.seed,
            targetType: session.targetType,
            previouslyPresentedIds: session.presentedEntityIds ?? [],
          }),
        }
      : {}),
    exploration: explorationOf(deps, state, finished ? recommendations.map((r) => r.candidate.entityId) : []),
    ...(state.listening ? { listening: listeningViewOf(state.listening, (id) => candidateName(state, id)) } : {}),
  };
}

const TOP_K = 5;
const topIds = (state: SessionState, previousOrder: string[] | null) =>
  orderOf(rankCandidates(visibleCandidates(state), state.session, previousOrder)).slice(0, TOP_K);

function liveDepsOf(deps: DiscoveryDeps, ledger: LiveLedger): LiveDeps {
  return {
    config: deps.config,
    provider: countingProvider(deps.provider, ledger),
    boundedAgent: deps.boundedAgent!,
    questionGenerator: deps.questionGenerator,
    now: deps.now ?? Date.now,
  };
}

/**
 * S9.3 pair-aware fields for every turn log: which directed pair, how it was
 * admitted, and what the user got. Counts and identifiers only.
 */
function pairFields(deps: DiscoveryDeps, state: SessionState): Record<string, unknown> {
  const { session } = state;
  const finished = session.status !== "active";
  const finalCount = Math.min(state.candidates.length, deps.config.limits.finalRecommendationCount);
  return {
    sourceType: session.sourceType,
    targetType: session.targetType,
    capability: pairAccess(session.sourceType, session.targetType, deps.config.verification.pairs),
    candidateCount: state.candidates.length,
    questionCount: session.questionCount,
    finishReason: state.finishReason,
    ...(finished ? { recommendationCount: finalCount, discoveryPathCount: Math.min(3, finalCount) } : {}),
  };
}

/** Structured per-request trace: counts, decisions, cost. Never tokens, prompts or secrets. */
function logTurn(deps: DiscoveryDeps, kind: string, ledger: LiveLedger, fields: Record<string, unknown>): void {
  const t = traceOf(ledger, deps.store.kind);
  logEvent("info", "discovery.turn", {
    requestId: deps.requestId,
    kind,
    normalizationRejected: ledger.normalizationRejected,
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
async function startLive(deps: DiscoveryDeps, input: StartRequest, access: PairAccess): Promise<DiscoveryView> {
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
  if (!retrieved) {
    logEvent("info", "discovery.no_candidates", { requestId: deps.requestId, sourceType: input.sourceType, targetType: input.targetType, capability: access, qlooRequests: ledger.qlooNetwork, normalizationRejected: ledger.normalizationRejected });
    throw new AppError("NO_RECOMMENDATIONS", 422, `No ${domainLabel(input.targetType, true)} recommendations for this entity`);
  }

  const outcome = await decideAndExecute(live, retrieved, ledger, { allowRetrieval: false });
  const final = enableAdaptivePool(deps, applyLedger(withOrder(applyOutcome(outcome.state, outcome.question, outcome.decision), null), ledger));
  const token = await sessionsOf(deps).create(final);
  const update: RecommendationUpdate = {
    mechanism: "INITIAL_RETRIEVAL",
    qlooRequested: true,
    internalCorrelationIds: [...ledger.correlationIds],
    previousTopIds: [],
    updatedTopIds: topIds(final, null),
    preferenceIds: [],
  };
  logTurn(deps, "start", ledger, { revision: 0, action: outcome.decision.action, selectedQuestionId: outcome.decision.selectedQuestionId ?? null, mechanism: update.mechanism, ...pairFields(deps, final) });
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
  const positiveTagIds = added(before.positiveTagIds, after.positiveTagIds);
  const positiveEntityIds = added(before.positiveEntityIds, after.positiveEntityIds);
  const positive = [...positiveTagIds, ...positiveEntityIds];
  const negative = [...added(before.rejectedTagIds, after.rejectedTagIds), ...added(before.rejectedEntityIds, after.rejectedEntityIds)];
  return { positive, positiveTagIds, positiveEntityIds, all: [...positive, ...negative] };
}

const nowOf = (deps: DiscoveryDeps) => (deps.now ?? Date.now)();

export async function startDiscovery(deps: DiscoveryDeps, input: StartRequest): Promise<DiscoveryView> {
  let access: PairAccess;
  try {
    access = assertEnabledPair(input, deps.config.verification.pairs);
  } catch (error) {
    logEvent("info", "discovery.pair_rejected", { requestId: deps.requestId, sourceType: input.sourceType, targetType: input.targetType, capability: pairAccess(input.sourceType, input.targetType) });
    throw error;
  }
  if (deps.boundedAgent) return startLive(deps, input, access);
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
  const final = enableAdaptivePool(deps, withOrder(applyOutcome(state, question, decision), null));
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

  // A presenting or accepted round is closed to answers (S4 rule, kept in S9.6; new rounds come only from `continue`).
  if (session.status !== "active" || !session.currentQuestionId) {
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

  const built = buildAnswer(question, input.response, nowOf(deps));
  // Round 1 answers keep the original shape; later rounds are tagged for the cumulative history.
  const answer = roundOf(session) > 1 ? { ...built, round: roundOf(session) } : built;

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
  let updated: SessionState = { ...state, session: { ...applyAnswer(state.session, answer), currentQuestionId: undefined } };
  const delta = preferenceDelta(state.session, updated.session);
  let adaptive: AdaptiveRetrievalResult | null = null;
  try {
    if (deps.config.features.adaptivePool && updated.adaptivePool) {
      adaptive = await retrieveAdaptive(live, updated, ledger, {
        positiveTagIds: delta.positiveTagIds,
        positiveEntityIds: delta.positiveEntityIds,
      });
      updated = adaptive.state;
    }
    // With ACPC enabled, the deterministic controller owns the single retrieval
    // opportunity; Gemini cannot spend a second request for the same action.
    outcome = await decideAndExecute(live, updated, ledger, { allowRetrieval: !deps.config.features.adaptivePool && delta.positive.length > 0 });
    next = applyLedger(withOrder(applyOutcome(outcome.state, outcome.question, outcome.decision), state.order), ledger);
  } catch (error) {
    // Nothing applied; usage already consumed stays charged.
    await releaseQuietly(sessions, lease, applyLedger(state, ledger));
    throw error;
  }
  const token = await sessions.commit(lease, next);

  const previousTopIds = state.order.slice(0, TOP_K);
  const updatedTopIds = topIds(next, state.order);
  const previousSet = new Set(previousTopIds);
  const updatedSet = new Set(updatedTopIds);
  const localIdentityChange = previousTopIds.some((id) => !updatedSet.has(id)) || updatedTopIds.some((id) => !previousSet.has(id));
  const poolDecision = adaptive
    ? adaptive.outcome === "merged" ? "FETCH_AND_MERGE"
      : adaptive.outcome === "failed" || adaptive.outcome === "budget_exhausted" || adaptive.outcome === "duplicate" ? "DEGRADED_KEEP"
        : localIdentityChange ? "LOCAL_REPLACE" : adaptive.decision
    : null;
  const update: RecommendationUpdate = {
    mechanism: ledger.retrieved ? "QLOO_RERETRIEVAL" : sameOrder(state.order, next.order) ? "UNCHANGED" : "LOCAL_RERANK",
    qlooRequested: ledger.retrieved,
    internalCorrelationIds: [...ledger.correlationIds],
    previousTopIds,
    updatedTopIds,
    preferenceIds: delta.all,
    ...(adaptive && poolDecision ? {
      poolTransition: {
        decision: poolDecision,
        reasonCodes: adaptive.reasons,
        previousDisplayedIds: previousTopIds,
        currentDisplayedIds: updatedTopIds,
        newReservoirIds: adaptive.addedIds,
        newlyDisplayedIds: updatedTopIds.filter((id) => !previousSet.has(id)),
        removedDisplayedIds: previousTopIds.filter((id) => !updatedSet.has(id)),
        qlooCallsMade: adaptive.calls,
        queryFamily: adaptive.plan?.family ?? null,
        retrievalOutcome: adaptive.outcome,
        sessionRevision: lease.revision + 1,
      },
    } : {}),
  };
  logTurn(deps, "answer", ledger, {
    revision: lease.revision + 1,
    action: outcome.decision.action,
    selectedQuestionId: outcome.decision.selectedQuestionId ?? null,
    response: answer.response,
    preferenceChanges: delta.all.length,
    mechanism: update.mechanism,
    ...pairFields(deps, next),
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
  const startedAt = performance.now();
  const sessions = sessionsOf(deps);
  const loaded = await sessions.load(sessionToken);
  const { state } = loaded;
  const decision: AgentDecision = {
    action: "finish",
    reasonCode:
      state.finishReason === "question_budget_exhausted" ? "question_budget_exhausted" : "stable_recommendations",
    done: true,
  };
  if (state.session.status !== "active") {
    // Idempotent for the current token only: no write, same final shortlist.
    return toView(deps, state, state.order, decision, sessions.tokenFor(loaded), loaded.revision);
  }
  // Lock-free CAS: fails with 409 if an answer holds the lease or already advanced the revision.
  const finished = withOrder(finishState(state, "user_finished"), state.order);
  const token = await sessions.commit(loaded, finished);
  logEvent("info", "discovery.finish", { requestId: deps.requestId, revision: loaded.revision + 1, sessionStore: deps.store.kind, latencyMs: Math.round(performance.now() - startedAt), ...pairFields(deps, finished) });
  return toView(deps, finished, state.order, decision, token, loaded.revision + 1);
}

// ---------------------------------------------------------------- S9.6 multi-round exploration
//
// One exploration = one server-side session record, so every transition below is a
// single CAS on the existing store: the signed {sid, rev, exp} token, revision checks,
// leases, replay rejection and expiry apply unchanged. History is never taken from
// the client; each request carries only the token and, at most, one entity ID that
// must belong to the current round's verified final recommendations.

const presentingDecision = (state: SessionState): AgentDecision => ({
  action: "finish",
  reasonCode: state.finishReason === "question_budget_exhausted" ? "question_budget_exhausted" : "stable_recommendations",
  done: true,
});

/** Feedback and continuation are only valid while a round is presenting its results. */
function assertPresenting(session: SessionState["session"]): void {
  if (session.status === "accepted") {
    throw new AppError("EXPLORATION_CLOSED", 409, "This exploration already ended with an accepted recommendation");
  }
  if (session.status === "active") {
    throw new AppError("ROUND_IN_PROGRESS", 409, "Finish the current round before giving recommendation feedback");
  }
}

/** The verified final recommendations the user is looking at right now (IDs the server issued). */
function presentedNow(deps: DiscoveryDeps, state: SessionState): RankedRecommendation[] {
  return finalRecommendations(deps, state.session, rankCandidates(visibleCandidates(state), state.session, state.order));
}

function assertShown(deps: DiscoveryDeps, state: SessionState, entityId: string): void {
  if (!presentedNow(deps, state).some((r) => r.candidate.entityId === entityId)) {
    throw new AppError("INVALID_RECOMMENDATION", 400, "Only a recommendation shown in the current results can be chosen");
  }
}

const feedback = (state: SessionState, revision: number, at: number, entry: { action: "reject" | "accept" | "continue"; entityId?: string; correction?: "reversed_positive" }) => [
  ...(state.session.recommendationFeedback ?? []),
  { ...entry, round: roundOf(state.session), revision, at },
];

/**
 * REJECT a shown recommendation. Records only that entity as unwanted (never its
 * tags), withdraws it from future results, and reverses an earlier explicit
 * positive answer about it (recorded as a correction). No provider call.
 */
export async function rejectRecommendation(deps: DiscoveryDeps, input: RecommendationFeedbackRequest): Promise<DiscoveryView> {
  const sessions = sessionsOf(deps);
  const loaded = await sessions.load(input.sessionToken);
  const { state } = loaded;
  assertPresenting(state.session);
  assertShown(deps, state, input.entityId);
  const wasPositive = state.session.positiveEntityIds.includes(input.entityId);
  const next = withOrder(
    {
      ...state,
      session: {
        ...state.session,
        rejectedEntityIds: [...new Set([...state.session.rejectedEntityIds, input.entityId])],
        positiveEntityIds: state.session.positiveEntityIds.filter((id) => id !== input.entityId),
        recommendationFeedback: feedback(state, loaded.revision, nowOf(deps), {
          action: "reject",
          entityId: input.entityId,
          ...(wasPositive ? { correction: "reversed_positive" as const } : {}),
        }),
      },
    },
    state.order,
  );
  // Lock-free CAS (as finish): a concurrent or replayed transition gets 409.
  const token = await sessions.commit(loaded, next);
  logEvent("info", "discovery.reject", { requestId: deps.requestId, revision: loaded.revision + 1, round: roundOf(state.session), sessionStore: deps.store.kind, ...pairFields(deps, next) });
  return toView(deps, next, state.order, presentingDecision(next), token, loaded.revision + 1);
}

/**
 * S9.9: read-only authorization for music playback. The artist must be a verified
 * candidate of this exploration's music-artist pool and not set aside by the user.
 * Uses the same signed token and revision check as every transition but writes nothing,
 * so resolving a video never advances the session or invalidates the token.
 */
export async function loadAuthorizedArtist(deps: DiscoveryDeps, sessionToken: string, entityId: string) {
  const loaded = await sessionsOf(deps).load(sessionToken);
  const { session, candidates } = loaded.state;
  if (session.targetType !== "music_artist") {
    throw new AppError("UNSUPPORTED_DOMAIN", 400, "Listening is only available when exploring music artists");
  }
  const candidate = candidates.find((c) => c.entityId === entityId);
  if (!candidate || session.rejectedEntityIds.includes(entityId)) {
    throw new AppError("ARTIST_NOT_IN_EXPLORATION", 403, "That artist is not part of this exploration");
  }
  return { explorationId: loaded.sessionId, expiresAt: loaded.expiresAt, candidate };
}

/** ACCEPT a shown recommendation: records the intention to try it (not consumption). Terminal. */
export async function acceptRecommendation(deps: DiscoveryDeps, input: RecommendationFeedbackRequest): Promise<DiscoveryView> {
  const sessions = sessionsOf(deps);
  const loaded = await sessions.load(input.sessionToken);
  const { state } = loaded;
  assertPresenting(state.session);
  assertShown(deps, state, input.entityId);
  const next: SessionState = {
    ...state,
    session: {
      ...state.session,
      status: "accepted",
      acceptedEntityId: input.entityId,
      recommendationFeedback: feedback(state, loaded.revision, nowOf(deps), { action: "accept", entityId: input.entityId }),
    },
  };
  const token = await sessions.commit(loaded, next);
  logEvent("info", "discovery.accept", { requestId: deps.requestId, revision: loaded.revision + 1, round: roundOf(state.session), sessionStore: deps.store.kind, ...pairFields(deps, next) });
  return toView(deps, next, state.order, presentingDecision(next), token, loaded.revision + 1);
}

/**
 * CONTINUE: open the next round from the stored context. All preferences,
 * question history (IDs and semantic dimensions), rejections and usage carry
 * over; only the per-round question counter restarts. The round's current
 * results are remembered as presented so the next round leads with unseen ones.
 * Refused (typed, context preserved, no provider call) when the verified pool is
 * exhausted or the exploration's Gemini allowance cannot cover another decision.
 */
export async function continueExploration(deps: DiscoveryDeps, input: ContinueRequest): Promise<DiscoveryView> {
  const sessions = sessionsOf(deps);
  const loaded = await sessions.load(input.sessionToken);
  const { state } = loaded;
  const { session } = state;
  assertPresenting(session);
  const shown = presentedNow(deps, state).map((r) => r.candidate.entityId);
  const blocked = explorationOf(deps, state, shown).continueBlockedReason;
  if (blocked === "candidates_exhausted") {
    throw new AppError(
      "EXPLORATION_EXHAUSTED",
      409,
      `Every verified ${domainLabel(session.targetType)} found for this anchor has been shown or turned down, and no unasked question remains. Try a different anchor or destination.`,
    );
  }
  if (blocked === "budget_exhausted") {
    throw new AppError("EXPLORATION_BUDGET_EXHAUSTED", 429, "This exploration has used its question allowance. Your results are kept; start a new exploration to keep going.");
  }
  const round = roundOf(session) + 1;
  const opened: SessionState = {
    ...state,
    finishReason: null,
    session: {
      ...session,
      status: "active",
      round,
      questionCount: 0,
      currentQuestionId: undefined,
      presentedEntityIds: [...new Set([...(session.presentedEntityIds ?? []), ...shown])],
      recommendationFeedback: feedback(state, loaded.revision, nowOf(deps), { action: "continue" }),
    },
  };
  // A new round may call Gemini: take the lease first so a concurrent continue gets 409 before any paid work.
  const lease = await sessions.acquire(loaded);
  if (deps.boundedAgent) return continueLive(deps, sessions, lease, state, opened);
  const ledger: UsageLedger = { qlooCalls: 0, toolCalls: 0 };
  let next: SessionState;
  let decision: AgentDecision;
  try {
    const out = await runAgent(deps, opened, ledger);
    next = withOrder(applyOutcome(out.state, out.question, out.decision), state.order);
    decision = out.decision;
  } catch (error) {
    await releaseQuietly(sessions, lease, withUsage(state, ledger));
    throw error;
  }
  const token = await sessions.commit(lease, next);
  logEvent("info", "discovery.continue", { requestId: deps.requestId, revision: lease.revision + 1, round, sessionStore: deps.store.kind, ...pairFields(deps, next) });
  return toView(deps, next, state.order, decision, token, lease.revision + 1);
}

async function continueLive(
  deps: DiscoveryDeps,
  sessions: SessionService,
  lease: Lease,
  state: SessionState,
  opened: SessionState,
): Promise<DiscoveryView> {
  const ledger = newLedger();
  const live = liveDepsOf(deps, ledger);
  let outcome: LiveOutcome;
  let next: SessionState;
  try {
    // No new answer was given, so no new signal could justify a Qloo retrieval here.
    outcome = await decideAndExecute(live, opened, ledger, { allowRetrieval: false });
    next = applyLedger(withOrder(applyOutcome(outcome.state, outcome.question, outcome.decision), state.order), ledger);
  } catch (error) {
    await releaseQuietly(sessions, lease, applyLedger(state, ledger));
    throw error;
  }
  const token = await sessions.commit(lease, next);
  const update: RecommendationUpdate = {
    mechanism: "UNCHANGED",
    qlooRequested: false,
    internalCorrelationIds: [],
    previousTopIds: state.order.slice(0, TOP_K),
    updatedTopIds: topIds(next, state.order),
    preferenceIds: [],
  };
  logTurn(deps, "continue", ledger, {
    revision: lease.revision + 1,
    round: roundOf(next.session),
    action: outcome.decision.action,
    selectedQuestionId: outcome.decision.selectedQuestionId ?? null,
    ...pairFields(deps, next),
  });
  return toView(deps, next, state.order, outcome.decision, token, lease.revision + 1, liveExtras(deps, ledger, outcome, update));
}

// ---------------------------------------------------------------- S9.12 listening loop

const candidateName = (state: SessionState, id: string) => state.candidates.find((c) => c.entityId === id)?.name ?? id;
/** Bounded resolver lookups when moving to another artist (each may skip an artist with no verified video). */
const LISTEN_ARTIST_ATTEMPTS = 3;

function assertListenable(state: SessionState): void {
  if (state.session.targetType !== "music_artist") {
    throw new AppError("UNSUPPORTED_DOMAIN", 400, "Listening is only available when exploring music artists");
  }
  if (state.session.status === "active") throw new AppError("ROUND_IN_PROGRESS", 409, "Finish the current round before listening");
}

/** Explicit artist-level exclusions only: recommendation rejects and explicit "not this artist". */
const excludedArtists = (state: SessionState) => new Set([...state.session.rejectedEntityIds, ...dismissedIds(state.session)]);

/** The programme the user sees first, then hidden verified candidates in rank order. */
function listeningArtistOrder(deps: DiscoveryDeps, state: SessionState): string[] {
  const shown = presentedNow(deps, state).map((r) => r.candidate.entityId);
  const all = orderOf(rankCandidates(visibleCandidates(state), state.session, state.order));
  return [...new Set([...shown, ...all])];
}

async function songOptions(deps: DiscoveryDeps, state: SessionState, artistId: string): Promise<VerifiedSongOption[]> {
  const c = state.candidates.find((x) => x.entityId === artistId);
  if (!c) return [];
  const resolution = await resolveArtistVideo(
    { entityId: c.entityId, name: c.name, provenance: c.evidence.source },
    { explorationId: state.session.sessionId, now: new Date(nowOf(deps)), momentReview: deps.config.music.momentReview, dynamic: deps.musicLookup },
  );
  return optionsFrom(resolution);
}

/** Only explicit, confirmed evidence: track reactions and answered-question preferences. */
function songEvidence(state: SessionState, listening: ListeningState) {
  const reactions = trackReactions(listening);
  const title = new Map(listening.encounters.map((e) => [e.videoId, { artistName: e.artistName, title: e.title }]));
  const pick = (kind: "love" | "not_for_me") =>
    [...reactions].filter(([, a]) => a === kind).map(([id]) => title.get(id)).filter((x): x is { artistName: string; title: string } => Boolean(x));
  const tagNames = new Map(state.candidates.flatMap((c) => c.tags.map((t) => [t.id, t.name] as const)));
  const names = (ids: string[]) => ids.map((id) => tagNames.get(id) ?? state.candidates.find((c) => c.entityId === id)?.name).filter((x): x is string => Boolean(x));
  return {
    loved: pick("love"),
    disliked: pick("not_for_me"),
    likes: names([...state.session.positiveTagIds, ...state.session.positiveEntityIds]),
    dislikes: names(state.session.rejectedTagIds),
  };
}

type SongChoice = { option: VerifiedSongOption; selection: SongSelection };

/**
 * Gemini chooses only when ≥2 eligible verified recordings exist, explicit evidence
 * exists and the exploration's Gemini allowance covers one request (charged before
 * the call). Its answer is re-validated against the eligible set; anything else is a
 * labelled deterministic choice.
 */
async function chooseSong(deps: DiscoveryDeps, state: SessionState, listening: ListeningState, artistId: string, eligible: VerifiedSongOption[], ledger: LiveLedger): Promise<SongChoice | null> {
  if (!eligible.length) return null;
  const count = eligible.length;
  if (count === 1) return { option: eligible[0]!, selection: { mode: "SINGLE_OPTION", reasonCode: "only_verified_option", fallbackReason: null, eligibleCount: 1 } };
  const fallback = (reason: string): SongChoice => ({
    option: deterministicSong(eligible)!,
    selection: { mode: "DETERMINISTIC", reasonCode: "unheard_verified_recording", fallbackReason: reason, eligibleCount: count },
  });
  const evidence = songEvidence(state, listening);
  if (!deps.songSelector) return fallback("llm_unavailable");
  if (evidence.loved.length + evidence.disliked.length + evidence.likes.length + evidence.dislikes.length === 0) return fallback("insufficient_evidence");
  const remaining = deps.config.limits.maxGeminiRequestsPerExploration - (state.session.geminiRequestCount ?? 0) - ledger.geminiRequests;
  if (remaining < 1) return fallback("exploration_gemini_budget_exhausted");
  ledger.geminiRequests += 1; // accounted before execution, failures included
  ledger.geminiDecisionRequests += 1;
  const r = await deps.songSelector.select({
    sessionRef: state.session.sessionId.slice(0, 8),
    anchor: { name: state.seed.name, domain: state.seed.entityType },
    artist: { entityId: artistId, name: candidateName(state, artistId) },
    options: eligible,
    lovedRecordings: evidence.loved,
    dislikedRecordings: evidence.disliked,
    confirmedLikes: evidence.likes,
    confirmedDislikes: evidence.dislikes,
  });
  ledger.tokens.input += r.usage.promptTokens;
  ledger.tokens.output += r.usage.outputTokens;
  ledger.tokens.thinking += r.usage.thoughtTokens;
  if (r.costUsd === null) ledger.geminiCostKnown = false;
  else ledger.geminiCostUsd += r.costUsd;
  if (!r.ok) return fallback(`gemini_${r.error}`);
  const chosen = eligible.find((o) => o.videoId === r.videoId && o.artistId === artistId);
  if (!chosen) return fallback("gemini_invalid_choice");
  return { option: chosen, selection: { mode: "GEMINI", reasonCode: r.reasonCode, fallbackReason: null, eligibleCount: count } };
}

type Turn = { deps: DiscoveryDeps; state: SessionState; ledger: LiveLedger; at: number; revision: number };

function encounter(t: Turn, l: ListeningState, artistId: string, options: VerifiedSongOption[], choice: SongChoice, notice: string | null): ListeningState {
  const base = { ...l, options, notice };
  const counted = choice.selection.mode === "GEMINI" ? { ...base, geminiSongRequests: base.geminiSongRequests + 1 } : base;
  return recordEncounter(counted, { artistId, artistName: candidateName(t.state, artistId), option: choice.option, selection: choice.selection, at: t.at, revision: t.revision });
}

/** Moves to the next verified artist with a playable recording (bounded lookups). */
async function moveToNextArtist(t: Turn, l: ListeningState): Promise<ListeningState> {
  let current = l;
  let tries = 0;
  for (const id of nextArtistIds(listeningArtistOrder(t.deps, t.state), current, excludedArtists(t.state))) {
    if (tries >= LISTEN_ARTIST_ATTEMPTS) break;
    tries += 1;
    const options = await songOptions(t.deps, t.state, id);
    const choice = await chooseSong(t.deps, t.state, current, id, eligibleOptions(current, options, null), t.ledger);
    if (choice) return encounter(t, current, id, options, choice, tries > 1 ? "skipped_artist_without_verified_song" : null);
    current = { ...current, unavailableArtistIds: [...current.unavailableArtistIds, id].slice(-100) };
  }
  return { ...current, notice: tries >= LISTEN_ARTIST_ATTEMPTS ? "no_verified_song_in_next_artists" : "no_other_artist" };
}

/** Records an explicit artist-level preference and lets the S9.11 controller decide on retrieval. */
async function likeArtist(t: Turn, state: SessionState, artistId: string): Promise<SessionState> {
  let next: SessionState = {
    ...state,
    session: { ...state.session, positiveEntityIds: [...new Set([...state.session.positiveEntityIds, artistId])] },
  };
  if (t.deps.config.features.adaptivePool && next.adaptivePool) {
    const live: LiveDeps = {
      config: t.deps.config,
      provider: countingProvider(t.deps.provider, t.ledger),
      boundedAgent: t.deps.boundedAgent!,
      questionGenerator: t.deps.questionGenerator,
      now: t.deps.now ?? Date.now,
    };
    next = (await retrieveAdaptive(live, next, t.ledger, { positiveTagIds: [], positiveEntityIds: [artistId] })).state;
  }
  return withOrder(next, state.order);
}

function rejectArtist(state: SessionState, artistId: string): SessionState {
  return withOrder(
    {
      ...state,
      session: {
        ...state.session,
        rejectedEntityIds: [...new Set([...state.session.rejectedEntityIds, artistId])],
        positiveEntityIds: state.session.positiveEntityIds.filter((id) => id !== artistId),
      },
    },
    state.order,
  );
}

async function listeningTurn(deps: DiscoveryDeps, sessionToken: string, kind: string, run: (t: Turn) => Promise<SessionState>): Promise<DiscoveryView> {
  const sessions = sessionsOf(deps);
  const loaded = await sessions.load(sessionToken);
  assertListenable(loaded.state);
  const lease = await sessions.acquire(loaded);
  const ledger = newLedger();
  const t: Turn = { deps, state: loaded.state, ledger, at: nowOf(deps), revision: lease.revision + 1 };
  let next: SessionState;
  try {
    next = applyLedger(await run(t), ledger);
  } catch (error) {
    // Verified prior state is kept; any provider usage already spent stays charged.
    await releaseQuietly(sessions, lease, applyLedger(loaded.state, ledger));
    throw error;
  }
  const token = await sessions.commit(lease, next);
  const l = next.listening!;
  logEvent("info", "discovery.listening", {
    requestId: deps.requestId,
    kind,
    revision: lease.revision + 1,
    artistId: l.currentArtistId,
    videoId: l.currentVideoId,
    selection: l.selection?.mode ?? null,
    fallbackReason: l.selection?.fallbackReason ?? null,
    notice: l.notice,
    geminiRequests: ledger.geminiRequests,
    qlooCalls: ledger.qlooBudgetCalls,
    sessionStore: deps.store.kind,
  });
  return toView(deps, next, loaded.state.order, presentingDecision(next), token, lease.revision + 1);
}

/** START (or switch to) listening: a chosen artist of this exploration, or the next one in programme order. */
export async function startListening(deps: DiscoveryDeps, input: ListenRequest): Promise<DiscoveryView> {
  return listeningTurn(deps, input.sessionToken, "start", async (t) => {
    const { state } = t;
    let l: ListeningState = withNavigation(state.listening ? { ...state.listening, status: "listening", notice: null } : emptyListening(), {
      action: "START",
      artistId: input.artistId ?? null,
      videoId: null,
      at: t.at,
      revision: t.revision,
    });
    if (!input.artistId) return { ...state, listening: await moveToNextArtist(t, l) };
    const artistId = input.artistId;
    if (!state.candidates.some((c) => c.entityId === artistId) || excludedArtists(state).has(artistId)) {
      throw new AppError("ARTIST_NOT_IN_EXPLORATION", 403, "That artist is not part of this exploration");
    }
    const options = await songOptions(deps, state, artistId);
    // An explicit choice of artist may replay a heard (never a disliked) recording.
    const reactions = trackReactions(l);
    const eligible = eligibleOptions(l, options, null);
    const replayable = eligible.length ? eligible : options.filter((o) => reactions.get(o.videoId) !== "not_for_me");
    const choice = await chooseSong(deps, state, l, artistId, replayable, t.ledger);
    if (!choice) {
      l = {
        ...l,
        currentArtistId: artistId,
        currentVideoId: null,
        options,
        selection: null,
        notice: options.length ? "all_recordings_disliked" : "no_verified_song",
        unavailableArtistIds: options.length ? l.unavailableArtistIds : [...new Set([...l.unavailableArtistIds, artistId])].slice(-100),
      };
      return { ...state, listening: l };
    }
    return { ...state, listening: encounter(t, l, artistId, options, choice, null) };
  });
}

/** One listening action on the recording the server last presented. */
export async function listeningFeedback(deps: DiscoveryDeps, input: ListeningFeedbackRequest): Promise<DiscoveryView> {
  return listeningTurn(deps, input.sessionToken, input.action.toLowerCase(), async (t) => {
    const l0 = t.state.listening;
    if (!l0) throw new AppError("LISTENING_NOT_STARTED", 409, "Start listening before giving feedback");
    if (l0.status === "finished") throw new AppError("LISTENING_FINISHED", 409, "This listening session is finished");
    // Server-authoritative current recording: a forged, stale or previous-artist video is refused.
    if (l0.currentArtistId !== input.artistId || l0.currentVideoId !== input.videoId) {
      throw new AppError("LISTENING_STATE_CONFLICT", 409, "That recording is not the one currently presented");
    }
    const artistId = input.artistId;
    const current = l0.options.find((o) => o.videoId === input.videoId && o.artistId === artistId);
    if (!current) throw new AppError("LISTENING_STATE_CONFLICT", 409, "That recording is not verified for this artist");
    let state = t.state;
    let l: ListeningState = { ...l0, notice: null };
    const track = (action: "love" | "not_for_me") => withTrackFeedback(l, { artistId, videoId: current.videoId, action, at: t.at, revision: t.revision });
    const nav = (action: "NEXT" | "ANOTHER_SONG" | "DIFFERENT_ARTIST") => withNavigation(l, { action, artistId, videoId: current.videoId, at: t.at, revision: t.revision });
    const notThisArtist = () => {
      l = withArtistFeedback(l, { artistId, action: "not_this_artist", at: t.at, revision: t.revision });
      state = rejectArtist(state, artistId);
    };

    switch (input.action) {
      case "LOVE": {
        l = track("love");
        if (input.artistIntent === "LIKE_ARTIST") {
          l = withArtistFeedback(l, { artistId, action: "like_artist", at: t.at, revision: t.revision });
          state = await likeArtist(t, state, artistId);
        }
        break;
      }
      case "NOT_FOR_ME": {
        // A track reaction only; the artist stays unless the user says so explicitly.
        l = track("not_for_me");
        if (input.artistIntent === "NOT_THIS_ARTIST") {
          notThisArtist();
          l = await moveToNextArtist({ ...t, state }, l);
        } else l = { ...l, notice: "recording_disliked_choose_next" };
        break;
      }
      case "NEXT": {
        l = nav("NEXT");
        const choice = await chooseSong(deps, state, l, artistId, eligibleOptions(l, l.options, current.videoId), t.ledger);
        l = choice ? encounter(t, l, artistId, l.options, choice, null) : await moveToNextArtist({ ...t, state }, l);
        break;
      }
      case "ANOTHER_SONG": {
        // Same artist from the stored verified options: no Qloo or YouTube call.
        l = nav("ANOTHER_SONG");
        const choice = await chooseSong(deps, state, l, artistId, eligibleOptions(l, l.options, current.videoId), t.ledger);
        l = choice ? encounter(t, l, artistId, l.options, choice, null) : { ...l, notice: l.options.length <= 1 ? "only_one_verified_song" : "no_other_unheard_song" };
        break;
      }
      case "DIFFERENT_ARTIST": {
        l = nav("DIFFERENT_ARTIST");
        if (input.artistIntent === "NOT_THIS_ARTIST") notThisArtist();
        const moved = await moveToNextArtist({ ...t, state }, l);
        // No other artist with a verified recording: keep the current one presented.
        l = moved.currentVideoId ? moved : { ...moved, currentArtistId: artistId, currentVideoId: current.videoId };
        break;
      }
      case "SAVE": {
        if (l.saved.some((x) => x.video.videoId === current.videoId)) {
          l = { ...l, notice: "already_saved" };
          break;
        }
        const c = state.candidates.find((x) => x.entityId === artistId)!;
        const saved: SavedDiscovery = {
          v: 1,
          savedAt: new Date(t.at).toISOString(),
          artist: { qlooId: artistId, name: c.name, provenance: c.evidence.source },
          video: { videoId: current.videoId, title: current.title, channelTitle: current.channelTitle, watchUrl: current.watchUrl, provenance: current.provenance },
          anchor: { qlooId: state.seed.entityId, name: state.seed.name, domain: state.seed.entityType },
        };
        l = { ...l, saved: [...l.saved, saved].slice(-50), notice: "saved" };
        break;
      }
      case "FINISH": {
        l = { ...l, status: "finished", notice: l.saved.length ? "finished" : "finished_without_saves" };
        break;
      }
    }
    return { ...state, listening: l };
  });
}
