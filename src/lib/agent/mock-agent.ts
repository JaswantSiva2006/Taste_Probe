import type { AgentDecision } from "@/lib/contracts";
import type { AgentContext, DiscoveryAgent } from "./types";

export const DETERMINISTIC_MOCK_AGENT_NAME = "deterministic-mock-agent";

/**
 * Explicitly mocked agent: fixed rules, no LLM call. Retrieves when the
 * shortlist is too small, finishes when the stop controller says so,
 * otherwise asks the selector's top question.
 */
export function createDeterministicMockAgent(): DiscoveryAgent {
  return {
    name: DETERMINISTIC_MOCK_AGENT_NAME,
    async decide(ctx: AgentContext): Promise<AgentDecision> {
      if (ctx.candidateCount < ctx.minCandidates) {
        return ctx.qlooCallsRemaining > 0
          ? { action: "retrieve", reasonCode: "insufficient_candidates", done: false }
          : { action: "finish", reasonCode: "insufficient_candidates", done: true };
      }
      if (ctx.stop.stop) {
        return { action: "finish", reasonCode: ctx.stop.reason, done: true };
      }
      const next = ctx.rankedQuestions[0];
      if (!next) {
        return { action: "finish", reasonCode: "stable_recommendations", done: true };
      }
      return {
        action: "ask",
        selectedQuestionId: next.questionId,
        questionText: next.text,
        reasonCode: "informative_question",
        done: false,
      };
    },
  };
}
