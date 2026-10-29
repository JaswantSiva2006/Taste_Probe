import "server-only";
import type { AppConfig } from "@/lib/config/env";
import { evaluateStop } from "@/lib/discovery/stop";
import { AppError } from "@/lib/validation/errors";
import { deterministicDecision, hardStop, type AgentResult, type BoundedAgent } from "./bounded";
import { offeredQuestions, type AgentDecisionContext } from "./context";
import { createGeminiAgent, type AgentLogger } from "./gemini-agent";
import { createFetchGeminiTransport, type GeminiTransport } from "./gemini-transport";
import { createDeterministicMockAgent } from "./mock-agent";
import { emptyUsage } from "./pricing";
import { permittedTools } from "./tools";
import { validateAgentDecision } from "./validate";

/** The existing deterministic mock agent behind the S6 boundary (mode MOCK_AGENT, no inference). */
export function createMockBoundedAgent(): BoundedAgent {
  const inner = createDeterministicMockAgent();
  return {
    name: inner.name,
    mode: "MOCK_AGENT",
    async decide(context: AgentDecisionContext): Promise<AgentResult> {
      const offered = offeredQuestions(context);
      const stop = hardStop(context);
      const decision =
        stop?.decision ??
        validateAgentDecision(
          await inner.decide({
            candidateCount: context.candidates.length,
            minCandidates: 2,
            qlooCallsRemaining: context.permissions.retrieve ? context.qlooCallsRemaining : 0,
            stop: evaluateStop(context, context.permissions.ask ? offered.length : 0),
            rankedQuestions: context.permissions.ask ? offered : [],
          }),
          offered,
        );
      return {
        decision,
        mode: "MOCK_AGENT",
        model: null,
        requestId: "mock",
        toolCalls: { allowed: permittedTools(context), attempted: 0, accepted: null, names: [] },
        validation: "not_called",
        usage: { ...emptyUsage(), requests: 0, latencyMs: 0, estimatedCostUsd: 0 },
        questionCandidates: context.questions.length,
      };
    },
  };
}

/** `google` is canonical; `gemini` is accepted as a legacy alias. */
export const GEMINI_PROVIDERS = new Set(["google", "gemini"]);
/** Explicit opt-out of inference in live mode (e.g. Qloo-only smoke). Never selected implicitly. */
export const NO_LLM_PROVIDER = "none";

/**
 * Explicitly configured no-LLM agent: every decision is the grounded deterministic
 * one and is labelled DETERMINISTIC_FALLBACK (reason llm_disabled), never as Gemini.
 */
export function createDeterministicBoundedAgent(): BoundedAgent {
  return {
    name: "deterministic-agent",
    mode: "MOCK_AGENT",
    async decide(context: AgentDecisionContext): Promise<AgentResult> {
      const stop = hardStop(context);
      return {
        decision: stop?.decision ?? deterministicDecision({ ...context, permissions: { ...context.permissions, retrieve: false, enrich: false } }),
        mode: "DETERMINISTIC_FALLBACK",
        fallbackReason: stop?.reason ?? "llm_disabled",
        model: null,
        requestId: "deterministic",
        toolCalls: { allowed: [], attempted: 0, accepted: null, names: [] },
        validation: "not_called",
        usage: { ...emptyUsage(), requests: 0, latencyMs: 0, estimatedCostUsd: 0 },
        questionCandidates: context.questions.length,
      };
    },
  };
}

/** Human-readable agent label for health checks, without constructing anything. */
export function agentLabel(config: Pick<AppConfig, "mode" | "llm">): string {
  if (config.mode === "mock") return "deterministic-mock-agent";
  if (config.llm.provider === NO_LLM_PROVIDER) return "deterministic-agent (LLM disabled)";
  return `gemini-agent (${config.llm.model ?? "unconfigured"})`;
}

/**
 * Selection boundary. Mock mode never performs inference. Live mode requires a
 * Google/Gemini provider, a model and a key, all from central configuration,
 * unless LLM_PROVIDER=none explicitly disables inference.
 */
export function createBoundedAgent(
  config: Pick<AppConfig, "mode" | "llm" | "features">,
  opts: { transport?: GeminiTransport; log?: AgentLogger } = {},
): BoundedAgent {
  if (config.mode === "mock") return createMockBoundedAgent();
  if (config.llm.provider === NO_LLM_PROVIDER) return createDeterministicBoundedAgent();
  if (!GEMINI_PROVIDERS.has(config.llm.provider)) {
    throw new AppError("CONFIG_ERROR", 500, "LLM_PROVIDER must be google (Gemini) in live mode");
  }
  if (!config.llm.model) throw new AppError("CONFIG_ERROR", 500, "LLM_MODEL is required in live mode");
  if (!config.llm.apiKey && !opts.transport) throw new AppError("CONFIG_ERROR", 500, "GOOGLE_API_KEY is required in live mode");
  return createGeminiAgent({
    model: config.llm.model,
    temperature: config.llm.temperature,
    timeoutMs: config.llm.timeoutMs,
    transport: opts.transport ?? createFetchGeminiTransport(config.llm.apiKey!),
    tracing: config.features.agentTracing,
    log: opts.log,
  });
}
