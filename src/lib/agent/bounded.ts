import type { AgentDecision } from "@/lib/contracts";
import type { AgentDecisionContext } from "./context";
import { offeredQuestions } from "./context";
import type { TokenUsage } from "./pricing";
import type { AgentIntent, ToolName, ToolRejection } from "./tools";
import { validateAgentDecision } from "./validate";

/**
 * S6 agent boundary: decide(context) -> AgentResult. Results always carry an
 * explicit execution mode so a deterministic fallback is never reported as a
 * Gemini decision. Agents never mutate session state; S7 applies decisions.
 */

export type AgentMode = "LIVE_GEMINI" | "MOCK_AGENT" | "DETERMINISTIC_FALLBACK";

export type AgentErrorKind =
  | "auth"
  | "rate_limit"
  | "bad_request"
  | "server"
  | "timeout"
  | "network"
  | "empty_response"
  | "missing_function_call"
  | "tool_call_budget_exceeded"
  | ToolRejection;

export type FallbackReason =
  | "hard_stop_session_inactive"
  | "hard_stop_question_budget"
  | "hard_stop_tool_budget"
  | "hard_stop_no_actions"
  | "provider_error"
  | "invalid_output";

export type AgentResult = {
  decision: AgentDecision;
  mode: AgentMode;
  intent?: AgentIntent;
  model: string | null;
  requestId: string;
  toolCalls: { allowed: ToolName[]; attempted: number; accepted: ToolName | null; names: string[] };
  /** valid: first response accepted; repaired: accepted after the single repair; invalid/not_called: fallback. */
  validation: "valid" | "repaired" | "invalid" | "not_called";
  fallbackReason?: FallbackReason;
  /** Last classified problem, if any (sanitized; no provider text). */
  error?: { kind: AgentErrorKind; status?: number };
  usage: TokenUsage & { requests: number; latencyMs: number; estimatedCostUsd: number | null };
  questionCandidates: number;
};

export interface BoundedAgent {
  readonly name: string;
  readonly mode: Exclude<AgentMode, "DETERMINISTIC_FALLBACK">;
  decide(context: AgentDecisionContext): Promise<AgentResult>;
}

/**
 * Deterministic hard stops, enforced in application code BEFORE any model call.
 * Returns the forced decision, or null when the agent may be consulted.
 */
export function hardStop(context: AgentDecisionContext): { decision: AgentDecision; reason: FallbackReason } | null {
  if (context.sessionStatus !== "active") {
    return { decision: { action: "finish", reasonCode: "stable_recommendations", done: true }, reason: "hard_stop_session_inactive" };
  }
  if (context.questionCount >= context.maxQuestions) {
    return { decision: { action: "finish", reasonCode: "question_budget_exhausted", done: true }, reason: "hard_stop_question_budget" };
  }
  const { ask, retrieve, enrich } = context.permissions;
  if (!ask && !retrieve && !enrich) {
    return { decision: { action: "finish", reasonCode: "stable_recommendations", done: true }, reason: "hard_stop_no_actions" };
  }
  if (context.toolCallsRemaining <= 0) {
    return { decision: deterministicDecision(context), reason: "hard_stop_tool_budget" };
  }
  return null;
}

/**
 * The reproducible fallback: ask the top S5-approved question (approved text),
 * otherwise finish. Depends only on the context, never on model output.
 */
export function deterministicDecision(context: AgentDecisionContext): AgentDecision {
  const top = context.permissions.ask ? context.questions[0] : undefined;
  if (top) {
    return validateAgentDecision(
      { action: "ask", selectedQuestionId: top.questionId, reasonCode: "informative_question", done: false },
      offeredQuestions(context),
    );
  }
  const exhausted = context.questionCount >= context.maxQuestions;
  return { action: "finish", reasonCode: exhausted ? "question_budget_exhausted" : "stable_recommendations", done: true };
}
