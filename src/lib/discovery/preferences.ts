import type { PreferenceAnswer, PreferenceResponse, Question, TasteSession } from "@/lib/contracts";
import { AppError } from "@/lib/validation/errors";

/** D2 — explicit preference updates. Only explicit responses change preferences. */

type Effect = { positive: string[]; rejected: string[] };

function effectOf(response: PreferenceResponse, targetIds: string[]): Effect {
  const [a, b] = targetIds;
  switch (response) {
    case "like":
      return { positive: targetIds, rejected: [] };
    case "dislike":
      return { positive: [], rejected: targetIds };
    case "prefer_a":
      return { positive: a ? [a] : [], rejected: [] };
    case "prefer_b":
      return { positive: b ? [b] : [], rejected: [] };
    case "both":
      return { positive: targetIds, rejected: [] };
    case "neither":
      return { positive: [], rejected: targetIds };
    case "unknown":
      // Skip: never infer a positive or negative preference.
      return { positive: [], rejected: [] };
  }
}

const withAdded = (list: string[], add: string[], remove: string[]) =>
  [...new Set([...list.filter((id) => !remove.includes(id)), ...add])];

export function buildAnswer(question: Question, response: PreferenceResponse, now: number): PreferenceAnswer {
  if (!question.allowedResponses.includes(response)) {
    throw new AppError(
      "INVALID_ANSWER",
      400,
      `Response "${response}" is not allowed for question ${question.questionId}`,
    );
  }
  return {
    questionId: question.questionId,
    targetType: question.targetType,
    targetIds: [...question.targetIds],
    response,
    timestamp: now,
  };
}

/** Returns a new session with the answer recorded and preference sets updated. */
export function applyAnswer(session: TasteSession, answer: PreferenceAnswer): TasteSession {
  const { positive, rejected } = effectOf(answer.response, answer.targetIds);
  const next: TasteSession = { ...session, answers: [...session.answers, answer] };
  if (answer.targetType === "tag") {
    next.positiveTagIds = withAdded(session.positiveTagIds, positive, rejected);
    next.rejectedTagIds = withAdded(session.rejectedTagIds, rejected, positive);
  } else {
    next.positiveEntityIds = withAdded(session.positiveEntityIds, positive, rejected);
    next.rejectedEntityIds = withAdded(session.rejectedEntityIds, rejected, positive);
  }
  return next;
}
