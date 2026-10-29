import "server-only";
import { randomUUID } from "node:crypto";
import type { AgentDecision, Question, TurnTrace } from "@/lib/contracts";
import { deterministicDecision, type AgentMode, type AgentResult, type BoundedAgent } from "@/lib/agent/bounded";
import { buildAgentContext, offeredQuestions, type AgentDecisionContext } from "@/lib/agent/context";
import type { AppConfig } from "@/lib/config/env";
import type { QuestionGenerator } from "@/lib/agent/question-generation/proposer";
import type { QlooProvider } from "@/lib/qloo/provider";
import type { SessionState } from "@/lib/session/state";
import { AppError } from "@/lib/validation/errors";
import { normalizeRecommendations } from "./normalize";
import { optimizeQuestions } from "./question-optimizer";
import { availableQuestions, buildQuestionCandidates } from "./questions";
import { rankCandidates } from "./ranking";

/**
 * S7 live turn: S5 question shortlist -> S6 bounded agent -> application-executed
 * action. Bounded: one agent decision, plus at most ONE follow-up decision after
 * an executed tool. Session counters are only ever increased (via the ledger).
 */

/** Matches the live provider's per-request attempt cap; failures are charged at the cap. */
export const RETRIEVAL_ATTEMPT_CAP = 2;
const SEARCH_ATTEMPT_CAP = 2;
const MAX_DECISIONS_PER_TURN = 2;

type TraceDecision = TurnTrace["decisions"][number];

/** Usage and evidence for one HTTP request; applied to the session only by adding. */
export type LiveLedger = {
  turnId: string;
  startedAt: number;
  /** Every Qloo HTTP attempt in this request (trace), including seed verification. */
  qlooNetwork: number;
  /** Insights attempts charged to the session's Qloo budget. */
  qlooBudgetCalls: number;
  /** Executed agent tools (retrieval/enrichment) this turn. */
  toolCalls: number;
  geminiRequests: number;
  geminiProposerRequests: number;
  geminiDecisionRequests: number;
  geminiCostUsd: number;
  geminiCostKnown: boolean;
  tokens: { input: number; output: number; thinking: number };
  decisions: TraceDecision[];
  correlationIds: string[];
  retrieved: boolean;
  degraded: string | null;
  questionPool?: Question[];
  questionGeneration?: {
    generated: number;
    accepted: number;
    rejected: number;
    fallbackReason: string | null;
    selected?: { questionId: string; evidenceIds: string[]; components: ReturnType<typeof optimizeQuestions>["eligible"][number]["components"]; positiveTop: string[]; negativeTop: string[] };
  };
};

export function newLedger(): LiveLedger {
  return {
    turnId: randomUUID(),
    startedAt: performance.now(),
    qlooNetwork: 0,
    qlooBudgetCalls: 0,
    toolCalls: 0,
    geminiRequests: 0,
    geminiProposerRequests: 0,
    geminiDecisionRequests: 0,
    geminiCostUsd: 0,
    geminiCostKnown: true,
    tokens: { input: 0, output: 0, thinking: 0 },
    decisions: [],
    correlationIds: [],
    retrieved: false,
    degraded: null,
  };
}

/** Adds this request's usage to the session counters (never resets them). */
export function applyLedger(state: SessionState, ledger: LiveLedger): SessionState {
  const s = state.session;
  return {
    ...state,
    session: {
      ...s,
      qlooCallCount: s.qlooCallCount + ledger.qlooBudgetCalls,
      agentToolCallCount: s.agentToolCallCount + ledger.toolCalls,
      geminiRequestCount: (s.geminiRequestCount ?? 0) + ledger.geminiRequests,
      geminiCostUsd: Math.round(((s.geminiCostUsd ?? 0) + ledger.geminiCostUsd) * 1e8) / 1e8,
    },
  };
}

/** Wraps the provider to count Qloo network attempts for the trace (fixtures count as 0). */
export function countingProvider(provider: QlooProvider, ledger: LiveLedger): QlooProvider {
  const count = <T extends { provenance: string; requestCount: number }>(r: T) => {
    if (r.provenance === "qloo") ledger.qlooNetwork += Math.max(1, r.requestCount);
    return r;
  };
  const charge = (cap: number) => (error: unknown) => {
    if (provider.mode === "live") ledger.qlooNetwork += cap;
    throw error;
  };
  return {
    mode: provider.mode,
    searchEntities: (q, t) => provider.searchEntities(q, t).then(count, charge(SEARCH_ATTEMPT_CAP)),
    getEntity: (id) => provider.getEntity(id).then(count, charge(SEARCH_ATTEMPT_CAP)),
    getRecommendations: (req) => provider.getRecommendations(req).then(count, charge(req.maxAttempts ?? RETRIEVAL_ATTEMPT_CAP)),
  };
}

export type LiveDeps = {
  config: AppConfig;
  provider: QlooProvider;
  boundedAgent: BoundedAgent;
  questionGenerator?: QuestionGenerator;
  now: () => number;
};

const qlooRemaining = (deps: LiveDeps, state: SessionState, ledger: LiveLedger) =>
  deps.config.limits.maxQlooCallsPerSession - state.session.qlooCallCount - ledger.qlooBudgetCalls;

/**
 * Executes one authorized Insights retrieval through the S3 provider. Budget is
 * checked before the call and charged conservatively if the call fails.
 * Returns null when Qloo returned no usable candidates (caller keeps the old shortlist).
 */
export async function retrieve(
  deps: LiveDeps,
  state: SessionState,
  ledger: LiveLedger,
  signals: { positiveTagIds: string[]; positiveEntityIds: string[] },
): Promise<SessionState | null> {
  const remaining = qlooRemaining(deps, state, ledger);
  if (remaining <= 0) throw new AppError("QLOO_BUDGET_EXHAUSTED", 429, "Recommendation retrieval budget exhausted");
  const attemptCap = Math.min(RETRIEVAL_ATTEMPT_CAP, remaining);
  const { session } = state;
  let result;
  try {
    result = await deps.provider.getRecommendations({
      seedEntityIds: session.anchorIds,
      targetType: session.targetType,
      take: deps.config.limits.maxRecommendationCandidates,
      positiveTagIds: signals.positiveTagIds,
      positiveEntityIds: signals.positiveEntityIds,
      // Negative preferences stay local penalties (rankCandidates); no hard Qloo exclusions.
      includeExplainability: deps.config.mode === "live",
      maxAttempts: attemptCap,
    });
  } catch (error) {
    ledger.qlooBudgetCalls += attemptCap;
    throw error;
  }
  ledger.qlooBudgetCalls += Math.max(1, result.requestCount);
  ledger.correlationIds.push(result.requestId);
  ledger.retrieved = true;
  const expectedSource = deps.config.mode === "live" ? "qloo" : "mock";
  const candidates = normalizeRecommendations(result, session.anchorIds, deps.config.limits.maxRecommendationCandidates).filter(
    (c) => c.entityType === session.targetType && c.evidence.source === expectedSource,
  );
  if (!candidates.length) return null;
  return { ...state, candidates };
}

/** S5: eligible, unasked, scored questions for the current authoritative state. */
async function eligibleTraces(deps: LiveDeps, state: SessionState, ledger: LiveLedger) {
  if (!deps.config.features.adaptiveQuestioning) return [];
  const ranked = rankCandidates(state.candidates, state.session);
  let generated = ledger.questionPool;
  if (deps.config.features.questionGenerationMode === "llm_grounded" && !deps.questionGenerator && generated === undefined) {
    generated = buildQuestionCandidates(state.candidates, state.session.targetType);
    ledger.questionPool = generated;
    ledger.questionGeneration = { generated: 0, accepted: 0, rejected: 0, fallbackReason: "generator_unavailable" };
  }
  if (deps.config.features.questionGenerationMode === "llm_grounded" && deps.questionGenerator && generated === undefined) {
    const result = await deps.questionGenerator.generate({ seed: state.seed, session: state.session, ranked });
    ledger.geminiRequests += result.usage.requests;
    ledger.geminiProposerRequests += result.usage.requests;
    ledger.tokens.input += result.usage.promptTokens;
    ledger.tokens.output += result.usage.outputTokens;
    ledger.tokens.thinking += result.usage.thoughtTokens;
    if (result.usage.estimatedCostUsd === null) ledger.geminiCostKnown = false;
    else ledger.geminiCostUsd += result.usage.estimatedCostUsd;
    ledger.questionGeneration = {
      generated: result.validation.generated,
      accepted: result.validation.accepted,
      rejected: result.validation.rejected,
      fallbackReason: result.fallbackReason,
    };
    generated = result.questions.length ? result.questions : buildQuestionCandidates(state.candidates, state.session.targetType);
    ledger.questionPool = generated;
  }
  const source = generated ?? buildQuestionCandidates(state.candidates, state.session.targetType);
  const questions = availableQuestions(source, state.session);
  const eligible = optimizeQuestions(questions, ranked, {
    askedQuestionIds: state.session.askedQuestionIds,
    preferences: state.session,
    profile: deps.config.features.questionGenerationMode === "llm_grounded" ? "quality_v1" : "s5",
  }).eligible;
  if (ledger.questionGeneration && eligible[0]) {
    ledger.questionGeneration.selected = {
      questionId: eligible[0].question.questionId,
      evidenceIds: [...eligible[0].evidenceIds],
      components: { ...eligible[0].components },
      positiveTop: eligible[0].positiveOrder.slice(0, 5),
      negativeTop: eligible[0].negativeOrder.slice(0, 5),
    };
  }
  return eligible;
}

async function contextFor(deps: LiveDeps, state: SessionState, ledger: LiveLedger, allowRetrieval: boolean): Promise<AgentDecisionContext> {
  return buildAgentContext({
    session: state.session,
    ranked: rankCandidates(state.candidates, state.session),
    eligible: await eligibleTraces(deps, state, ledger),
    toolCallsRemaining: deps.config.limits.maxAgentToolCallsPerTurn - ledger.toolCalls,
    qlooCallsRemaining: qlooRemaining(deps, state, ledger),
    now: deps.now(),
    allowRetrieval,
    // The S3 provider has no enrichment capability, so the tool is never granted.
    allowEnrichment: false,
    allowEarlyFinish: deps.config.features.earlyStopping,
    ...(deps.config.features.questionGenerationMode === "llm_grounded" ? { shortlistSize: 1 } : {}),
  });
}

function record(ledger: LiveLedger, result: AgentResult): void {
  ledger.geminiRequests += result.usage.requests;
  ledger.geminiDecisionRequests += result.usage.requests;
  ledger.tokens.input += result.usage.promptTokens;
  ledger.tokens.output += result.usage.outputTokens;
  ledger.tokens.thinking += result.usage.thoughtTokens;
  if (result.usage.estimatedCostUsd === null) ledger.geminiCostKnown = false;
  else ledger.geminiCostUsd += result.usage.estimatedCostUsd;
  ledger.decisions.push({
    mode: result.mode,
    action: result.decision.action,
    selectedQuestionId: result.decision.selectedQuestionId ?? null,
    validation: result.validation,
    fallbackReason: result.fallbackReason ?? null,
  });
}

export type LiveOutcome = {
  state: SessionState;
  decision: AgentDecision;
  question: Question | null;
  mode: AgentMode;
  fallbackReason: string | null;
};

/** Grounded deterministic decision from the current context with tools withdrawn. */
function fallback(context: AgentDecisionContext, state: SessionState, ledger: LiveLedger, reason: string): LiveOutcome {
  const ctx = { ...context, permissions: { ...context.permissions, retrieve: false, enrich: false } };
  const decision = deterministicDecision(ctx);
  ledger.decisions.push({
    mode: "DETERMINISTIC_FALLBACK",
    action: decision.action,
    selectedQuestionId: decision.selectedQuestionId ?? null,
    validation: "not_called",
    fallbackReason: reason,
  });
  const question = decision.action === "ask" ? (offeredQuestions(ctx).find((q) => q.questionId === decision.selectedQuestionId) ?? null) : null;
  return { state, decision, question, mode: "DETERMINISTIC_FALLBACK", fallbackReason: reason };
}

/**
 * Bounded decision loop. The agent may request one retrieval; the application
 * executes it, then asks for exactly one follow-up decision with retrieval withdrawn.
 */
export async function decideAndExecute(
  deps: LiveDeps,
  state: SessionState,
  ledger: LiveLedger,
  opts: { allowRetrieval: boolean },
): Promise<LiveOutcome> {
  let current = state;
  let allowRetrieval = opts.allowRetrieval;
  for (let step = 0; step < MAX_DECISIONS_PER_TURN; step += 1) {
    const context = await contextFor(deps, current, ledger, allowRetrieval);
    const result = await deps.boundedAgent.decide(context);
    record(ledger, result);
    const { decision } = result;
    const outcome = { mode: result.mode, fallbackReason: result.fallbackReason ?? null };

    if (decision.action === "ask") {
      const question = offeredQuestions(context).find((q) => q.questionId === decision.selectedQuestionId);
      if (!question) return fallback(context, current, ledger, "unapproved_question");
      return { state: current, decision, question, ...outcome };
    }
    if (decision.action === "finish") return { state: current, decision, question: null, ...outcome };
    if (decision.action === "enrich") return fallback(context, current, ledger, "enrichment_unsupported");

    // retrieve: only if granted in this context and this is not already the follow-up.
    if (!context.permissions.retrieve || step === MAX_DECISIONS_PER_TURN - 1) {
      return fallback(context, current, ledger, "retrieval_not_permitted");
    }
    ledger.toolCalls += 1;
    const intent = result.intent?.kind === "retrieval" ? result.intent : null;
    const explicit = intent ? [...intent.positiveTagIds, ...intent.positiveEntityIds].length > 0 : false;
    const signals = explicit
      ? { positiveTagIds: intent!.positiveTagIds, positiveEntityIds: intent!.positiveEntityIds }
      : { positiveTagIds: current.session.positiveTagIds, positiveEntityIds: current.session.positiveEntityIds };
    try {
      const refreshed = await retrieve(deps, current, ledger, signals);
      if (refreshed) current = refreshed;
      else ledger.degraded = "qloo_empty_result";
    } catch (error) {
      // Keep the existing verified shortlist; never fabricate replacements.
      ledger.degraded = error instanceof AppError ? `qloo_${error.code.toLowerCase()}` : "qloo_error";
      return fallback(await contextFor(deps, current, ledger, false), current, ledger, "retrieval_failed");
    }
    allowRetrieval = false;
  }
  return fallback(await contextFor(deps, current, ledger, false), current, ledger, "decision_limit");
}

export function traceOf(ledger: LiveLedger, sessionStore: "memory" | "redis"): TurnTrace {
  return {
    turnId: ledger.turnId,
    qlooRequests: ledger.qlooNetwork,
    geminiRequests: ledger.geminiRequests,
    geminiRequestBreakdown: { proposer: ledger.geminiProposerRequests, decisionAgent: ledger.geminiDecisionRequests },
    geminiTokens: { ...ledger.tokens },
    estimatedGeminiCostUsd: ledger.geminiCostKnown ? Math.round(ledger.geminiCostUsd * 1e8) / 1e8 : null,
    latencyMs: Math.round(performance.now() - ledger.startedAt),
    sessionStore,
    decisions: ledger.decisions,
    ...(ledger.questionGeneration
      ? { questionGeneration: { mode: "llm_grounded" as const, ...ledger.questionGeneration } }
      : {}),
  };
}
