import type {
  EntityType,
  Question,
  RankedRecommendation,
  RecommendationCandidate,
  TasteSession,
} from "@/lib/contracts";
import { optimizeQuestions } from "./question-optimizer";
import { isUsefulTag } from "./tag-quality";

export { isUsefulTag, MEANINGFUL_TAG_TYPES } from "./tag-quality";

/** K2 — grounded question candidate construction and D1 optimizer boundary. */

const tagQuestionId = (tagId: string) => `tag:${tagId}`;
const entityQuestionId = (a: string, b: string) => `entity:${a}|${b}`;

function tagQuestions(candidates: RecommendationCandidate[], targetType: EntityType): Question[] {
  const tags = new Map<string, { name: string; count: number }>();
  for (const candidate of candidates) {
    for (const tag of new Map(candidate.tags.filter(isUsefulTag).map((item) => [item.id, item])).values()) {
      const entry = tags.get(tag.id) ?? { name: tag.name.trim(), count: 0 };
      entry.count += 1;
      tags.set(tag.id, entry);
    }
  }
  const noun = targetType === "book" ? "books" : "movies";
  return [...tags.entries()]
    .filter(([, tag]) => tag.count > 0 && tag.count < candidates.length)
    .map(([tagId, tag]) => ({
      questionId: tagQuestionId(tagId),
      text: `Do you enjoy ${tag.name} ${noun}?`,
      targetType: "tag" as const,
      targetIds: [tagId],
      allowedResponses: ["like", "dislike", "unknown"] as Question["allowedResponses"],
    }))
    .sort((a, b) => a.questionId.localeCompare(b.questionId));
}

function entityQuestions(candidates: RecommendationCandidate[], targetType: EntityType): Question[] {
  if (candidates.length < 2) return [];
  const noun = targetType === "book" ? "book" : "movie";
  const pool = [...candidates].sort((a, b) => a.rank - b.rank || a.entityId.localeCompare(b.entityId)).slice(0, 8);
  const pairs: Array<{ a: RecommendationCandidate; b: RecommendationCandidate; diversity: number }> = [];
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const a = pool[i]!;
      const b = pool[j]!;
      const at = new Set(a.tags.map((tag) => tag.id));
      const bt = new Set(b.tags.map((tag) => tag.id));
      const union = new Set([...at, ...bt]).size;
      const shared = [...at].filter((id) => bt.has(id)).length;
      pairs.push({ a, b, diversity: union ? 1 - shared / union : 0.5 });
    }
  }
  return pairs
    .sort((x, y) => y.diversity - x.diversity || x.a.rank - y.a.rank || x.b.rank - y.b.rank || x.a.entityId.localeCompare(y.a.entityId) || x.b.entityId.localeCompare(y.b.entityId))
    .slice(0, 10)
    .map(({ a, b }) => ({
      questionId: entityQuestionId(a.entityId, b.entityId),
      text: `Which ${noun} sounds more appealing: “${a.name}” or “${b.name}”?`,
      targetType: "entity" as const,
      targetIds: [a.entityId, b.entityId],
      allowedResponses: ["prefer_a", "prefer_b", "both", "neither", "unknown"] as Question["allowedResponses"],
    }));
}

/** Uses entity comparisons only when conservative tag filtering leaves no useful partition. */
export function buildQuestionCandidates(candidates: RecommendationCandidate[], targetType: EntityType): Question[] {
  if (candidates.length < 2) return [];
  const tags = tagQuestions(candidates, targetType);
  return tags.length ? tags : entityQuestions(candidates, targetType);
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
    (question) =>
      !session.askedQuestionIds.includes(question.questionId) &&
      (question.targetType === "entity"
        ? !question.targetIds.some((id) => decided.has(id))
        : !question.targetIds.every((id) => decided.has(id))),
  );
}

export type QuestionSelector = (
  questions: Question[],
  ranked: RankedRecommendation[],
  session?: TasteSession,
) => Question[];

/** Kept as a compatibility export; now delegates to the complete deterministic S5 objective. */
export const selectQuestionsByBalanceHeuristic: QuestionSelector = (questions, ranked, session) =>
  optimizeQuestions(questions, ranked, {
    askedQuestionIds: session?.askedQuestionIds ?? [],
    preferences: session
      ? {
          positiveTagIds: session.positiveTagIds,
          rejectedTagIds: session.rejectedTagIds,
          positiveEntityIds: session.positiveEntityIds,
          rejectedEntityIds: session.rejectedEntityIds,
        }
      : undefined,
  }).eligible.map((item) => item.question);
