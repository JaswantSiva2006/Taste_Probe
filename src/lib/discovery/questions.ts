import type {
  EntityType,
  Question,
  RankedRecommendation,
  RecommendationCandidate,
  TasteSession,
} from "@/lib/contracts";

/** K2 — question candidate builder. */

const tagQuestionId = (tagId: string) => `tag:${tagId}`;

/**
 * One like/dislike question per tag that splits the shortlist (present on some
 * but not all candidates). Tags on every or no candidate cannot change order.
 */
export function buildQuestionCandidates(
  candidates: RecommendationCandidate[],
  targetType: EntityType,
): Question[] {
  const tags = new Map<string, { name: string; count: number }>();
  for (const c of candidates) {
    for (const t of new Map(c.tags.map((tag) => [tag.id, tag])).values()) {
      const entry = tags.get(t.id) ?? { name: t.name, count: 0 };
      entry.count += 1;
      tags.set(t.id, entry);
    }
  }
  const noun = targetType === "book" ? "books" : "movies";
  return [...tags.entries()]
    .filter(([, { count }]) => count > 0 && count < candidates.length)
    .map(([tagId, { name }]) => ({
      questionId: tagQuestionId(tagId),
      text: `Do you want ${noun} with ${name}?`,
      targetType: "tag" as const,
      targetIds: [tagId],
      allowedResponses: ["like", "dislike", "unknown"] as Question["allowedResponses"],
    }));
}

/** Questions not yet asked and whose targets have no confirmed preference. */
export function availableQuestions(questions: Question[], session: TasteSession): Question[] {
  const decided = new Set([
    ...session.positiveTagIds,
    ...session.rejectedTagIds,
    ...session.positiveEntityIds,
    ...session.rejectedEntityIds,
  ]);
  return questions.filter(
    (q) => !session.askedQuestionIds.includes(q.questionId) && !q.targetIds.every((id) => decided.has(id)),
  );
}

/**
 * D1 selection boundary. S5 replaces this with the information-theoretic
 * optimizer. The S1 placeholder is a simple balance heuristic and makes no
 * information-gain claim: prefer tags that split the shortlist most evenly,
 * then tags carried by higher-ranked items, then question ID.
 */
export type QuestionSelector = (questions: Question[], ranked: RankedRecommendation[]) => Question[];

export const selectQuestionsByBalanceHeuristic: QuestionSelector = (questions, ranked) => {
  const n = ranked.length;
  const stats = (q: Question) => {
    const positions = ranked
      .filter((r) => r.candidate.tags.some((t) => q.targetIds.includes(t.id)))
      .map((r) => r.position);
    return { imbalance: Math.abs(positions.length - n / 2), best: Math.min(...positions, n + 1) };
  };
  return [...questions].sort((a, b) => {
    const sa = stats(a);
    const sb = stats(b);
    return sa.imbalance - sb.imbalance || sa.best - sb.best || a.questionId.localeCompare(b.questionId);
  });
};
