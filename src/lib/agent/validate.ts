import { AgentDecisionSchema, type AgentDecision, type Question } from "@/lib/contracts";
import { AppError } from "@/lib/validation/errors";

/**
 * V1 (partial) — validates any agent output before the orchestrator acts on it.
 * An `ask` must reference one of the offered questions; its text is replaced
 * with the server-side question text so the agent cannot inject wording.
 */
export function validateAgentDecision(raw: unknown, offered: Question[]): AgentDecision {
  const parsed = AgentDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("AGENT_DECISION_INVALID", 500, "Agent returned a malformed decision");
  }
  const decision = parsed.data;
  if (decision.action === "ask") {
    const question = offered.find((q) => q.questionId === decision.selectedQuestionId);
    if (!question) {
      throw new AppError("AGENT_DECISION_INVALID", 500, "Agent selected an unknown question");
    }
    return { ...decision, questionText: question.text, done: false };
  }
  if (decision.action === "finish" && !decision.done) {
    throw new AppError("AGENT_DECISION_INVALID", 500, "A finish decision must set done=true");
  }
  return decision;
}
