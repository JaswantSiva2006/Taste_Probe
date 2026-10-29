import { DOMAINS, type Question, type RecommendationCandidate } from "@/lib/contracts";

export type SemanticQuestionScores = {
  clarity: number;
  naturalness: number;
  answerability: number;
  relevance: number;
  preferenceUsefulness: number;
  mean: number;
};

const clamp5 = (value: number) => Math.min(5, Math.max(1, value));
const round = (value: number) => Math.round(value * 1000) / 1000;
const plurals = Object.values(DOMAINS).map((d) => d.plural.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const mechanical = new RegExp(`^do you enjoy .+ (${plurals})\\?$`, "i");
const vague = /^(immersive|adult|general|popular|other|fiction|nonfiction|science fiction|fantasy|magic|adventure|action|thriller|horror|mystery|drama|romance|books?|movies?)$/i;

/** Auditable heuristic rubric. These scores are proxies, never human ratings. */
export function semanticQuestionScores(question: Question, candidates: RecommendationCandidate[]): SemanticQuestionScores {
  const text = question.text.trim();
  const words = text.split(/\s+/).length;
  const target = question.targetIds[0];
  const tag = question.targetType === "tag"
    ? candidates.flatMap((candidate) => candidate.tags).find((item) => item.id === target)
    : undefined;
  const carriers = tag
    ? candidates.filter((candidate) => candidate.tags.some((item) => item.id === tag.id)).length
    : 0;
  const ratio = candidates.length ? carriers / candidates.length : 0;
  const label = tag?.name.trim() ?? "";
  const bareLabel = label.length > 0 && [
    `would you enjoy ${label}?`, `would you like ${label}?`, `do you enjoy ${label}?`,
  ].some((value) => value.toLowerCase() === text.toLowerCase());

  const clarity = clamp5(5 - (words > 22 ? 1 : 0) - (!text.endsWith("?") ? 1 : 0));
  const naturalness = clamp5(5 - (mechanical.test(text) || bareLabel ? 1.5 : 0) - (/\b(?:tag|metadata|entity)\b/i.test(text) ? 2 : 0));
  const answerability = clamp5(5 - (question.targetType === "entity" && question.targetIds.length !== 2 ? 3 : 0));
  const vagueTarget = vague.test(tag?.name.trim() ?? "");
  const relevance = clamp5(question.targetType === "entity" ? 4 : vagueTarget ? 1.5 : 4);
  const actionable = ratio > 0 && ratio < 1 ? 1 : 0;
  const preferenceUsefulness = clamp5(vagueTarget ? 2 + actionable : 2 + actionable * 2 + (tag && tag.name.trim().split(/\s+/).length >= 2 ? 1 : 0));
  const values = [clarity, naturalness, answerability, relevance, preferenceUsefulness];
  return { clarity, naturalness, answerability, relevance, preferenceUsefulness, mean: round(values.reduce((a, b) => a + b, 0) / values.length) };
}

/** Normalized, order-aware rank distance; detects reorderings with unchanged top-K membership. */
export function orderAwareSeparation(positive: string[], negative: string[], topK: number): number {
  const ids = [...new Set([...positive.slice(0, topK), ...negative.slice(0, topK)])];
  if (!ids.length) return 0;
  const missing = topK + 1;
  const distance = ids.reduce((sum, id) => {
    const a = positive.indexOf(id);
    const b = negative.indexOf(id);
    return sum + Math.abs((a < 0 ? missing : Math.min(a, missing)) - (b < 0 ? missing : Math.min(b, missing)));
  }, 0);
  return Math.min(1, distance / (ids.length * Math.max(1, topK)));
}
