import type { RankedRecommendation, RecommendationCandidate, TasteSession } from "@/lib/contracts";

/**
 * Placeholder reranker. NOT the production scoring equation: a transparent
 * additive adjustment so explicit answers visibly and testably move items.
 */
export const PLACEHOLDER_WEIGHTS = {
  positiveTag: 0.15,
  rejectedTag: -0.25,
  positiveEntity: 0.3,
  rejectedEntity: -0.5,
} as const;

export type PreferenceSets = Pick<
  TasteSession,
  "positiveTagIds" | "rejectedTagIds" | "positiveEntityIds" | "rejectedEntityIds"
>;

export function baseScore(candidate: RecommendationCandidate): number {
  if ("syntheticScore" in candidate) return candidate.syntheticScore;
  return candidate.affinity ?? Math.max(0, 1 - (candidate.rank - 1) * 0.05);
}

function explain(
  candidate: RecommendationCandidate,
  positive: string[],
  rejected: string[],
  prefs: PreferenceSets,
): string {
  const names = (ids: string[]) =>
    ids.map((id) => candidate.tags.find((t) => t.id === id)?.name ?? id).join(", ");
  const parts: string[] = [];
  if (positive.length) parts.push(`boosted for ${names(positive)}`);
  if (rejected.length) parts.push(`lowered for ${names(rejected)}`);
  if (prefs.positiveEntityIds.includes(candidate.entityId)) parts.push("boosted: you liked this title");
  if (prefs.rejectedEntityIds.includes(candidate.entityId)) parts.push("lowered: you rejected this title");
  if (!parts.length) {
    return candidate.evidence.source === "mock"
      ? "Ordered by synthetic fixture score (no matching preferences yet)."
      : "Ordered by provider affinity (no matching preferences yet).";
  }
  const text = parts.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

/**
 * Ranks candidates by base score plus preference adjustments.
 * Ties break on the provider's original rank, so output is deterministic.
 */
export function rankCandidates(
  candidates: RecommendationCandidate[],
  prefs: PreferenceSets,
  previousOrder: string[] | null = null,
): RankedRecommendation[] {
  const scored = candidates.map((candidate) => {
    const tagIds = candidate.tags.map((t) => t.id);
    const positive = tagIds.filter((id) => prefs.positiveTagIds.includes(id));
    const rejected = tagIds.filter((id) => prefs.rejectedTagIds.includes(id));
    let score = baseScore(candidate);
    score += positive.length * PLACEHOLDER_WEIGHTS.positiveTag;
    score += rejected.length * PLACEHOLDER_WEIGHTS.rejectedTag;
    if (prefs.positiveEntityIds.includes(candidate.entityId)) score += PLACEHOLDER_WEIGHTS.positiveEntity;
    if (prefs.rejectedEntityIds.includes(candidate.entityId)) score += PLACEHOLDER_WEIGHTS.rejectedEntity;
    return { candidate, score: Math.round(score * 1000) / 1000, positive, rejected };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.candidate.rank - b.candidate.rank ||
      a.candidate.entityId.localeCompare(b.candidate.entityId),
  );

  return scored.map((s, index) => {
    const prev = previousOrder ? previousOrder.indexOf(s.candidate.entityId) : -1;
    return {
      candidate: s.candidate,
      position: index + 1,
      previousPosition: prev >= 0 ? prev + 1 : null,
      score: s.score,
      matchedPositiveTagIds: s.positive,
      matchedRejectedTagIds: s.rejected,
      explanation: explain(s.candidate, s.positive, s.rejected, prefs),
    };
  });
}

export const orderOf = (ranked: RankedRecommendation[]): string[] =>
  ranked.map((r) => r.candidate.entityId);

export const sameOrder = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);
