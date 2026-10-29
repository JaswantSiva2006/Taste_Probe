import type { AgentDecision, Question } from "@/lib/contracts";
import type { StopEvaluation } from "@/lib/discovery/stop";

/** What the orchestrator tells the agent each step. The agent never calls tools itself. */
export type AgentContext = {
  candidateCount: number;
  minCandidates: number;
  qlooCallsRemaining: number;
  stop: StopEvaluation;
  /** Ordered by the question selector; the agent may only pick from these. */
  rankedQuestions: Question[];
};

/** A1 boundary: the Gemini agent (later segment) implements the same interface. */
export interface DiscoveryAgent {
  readonly name: string;
  decide(context: AgentContext): Promise<AgentDecision>;
}
