import "server-only";
import type { AppConfig } from "@/lib/config/env";
import { evaluateStop } from "@/lib/discovery/stop";
import { AppError } from "@/lib/validation/errors";
import { hardStop, type AgentResult, type BoundedAgent } from "./bounded";
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

const GEMINI_PROVIDERS = new Set(["google", "gemini"]);

/**
 * Selection boundary. Mock mode never performs inference. Live mode requires a
 * Google/Gemini provider, a model and a key, all from central configuration.
 * Not yet wired into discovery routes: S7 owns that integration.
 */
export function createBoundedAgent(
  config: Pick<AppConfig, "mode" | "llm" | "features">,
  opts: { transport?: GeminiTransport; log?: AgentLogger } = {},
): BoundedAgent {
  if (config.mode === "mock") return createMockBoundedAgent();
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
