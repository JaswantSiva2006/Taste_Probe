import type { TasteSession } from "@/lib/contracts";

/** V2 — stop controller. */

export type StopEvaluation =
  | { stop: false }
  | { stop: true; reason: "question_budget_exhausted" | "stable_recommendations" };

export function evaluateStop(
  session: Pick<TasteSession, "questionCount" | "maxQuestions">,
  availableQuestionCount: number,
): StopEvaluation {
  if (session.questionCount >= session.maxQuestions) {
    return { stop: true, reason: "question_budget_exhausted" };
  }
  if (availableQuestionCount === 0) {
    // Nothing left that could reorder the shortlist.
    return { stop: true, reason: "stable_recommendations" };
  }
  return { stop: false };
}
