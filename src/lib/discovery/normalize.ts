import {
  EntitySummarySchema,
  MockRecommendationCandidateSchema,
  QlooRecommendationCandidateSchema,
  sessionDomainOfQlooType,
  type EntitySummary,
  type EntityType,
  type RecommendationCandidate,
} from "@/lib/contracts";
import type {
  ProviderResult,
  RawInsightEntity,
  RawInsightsResponse,
  RawSearchEntity,
  RawSearchResponse,
} from "@/lib/qloo/raw-types";

/** K1 — converts raw provider payloads into public contracts, preserving provenance. */

/** Wire type → session domain via the S9.2 registry; unregistered types stay unrecognised. */
const toEntityType = (urn: string | undefined): EntityType | undefined => sessionDomainOfQlooType(urn);

/**
 * Insights classification: Qloo may carry the specific kind in `subtype`, `type`
 * or `types[]`, so all are checked — but only exact registry URNs count, and
 * `subtype` wins. Nothing is inferred from names or tags.
 */
const classify = (raw: RawInsightEntity): EntityType | undefined =>
  [raw.subtype, raw.type, ...(raw.types ?? [])].map(toEntityType).find((t) => t !== undefined);

export function normalizeEntity(
  raw: RawSearchEntity,
  provenance: ProviderResult<unknown>["provenance"],
): EntitySummary | null {
  const entityType = raw.types.map(toEntityType).find((t) => t !== undefined);
  if (!entityType) return null;
  return EntitySummarySchema.parse({
    entityId: raw.entity_id,
    name: raw.name,
    entityType,
    year: raw.properties?.release_year ?? raw.properties?.publication_year,
    provenance,
  });
}

export function normalizeSearchResults(result: ProviderResult<RawSearchResponse>): EntitySummary[] {
  return result.payload.results
    .map((raw) => normalizeEntity(raw, result.provenance))
    .filter((e): e is EntitySummary => e !== null);
}

const MOCK_NOTE = "Synthetic fixture data for development. Not returned by Qloo; scores are not measured affinities.";

function normalizeCandidate(
  raw: RawInsightEntity,
  rank: number,
  result: ProviderResult<RawInsightsResponse>,
  seedEntityIds: string[],
): RecommendationCandidate {
  const base = {
    entityId: raw.entity_id,
    name: raw.name,
    entityType: classify(raw) ?? raw.subtype,
    rank,
    ...(raw.properties?.description === undefined ? {} : { description: raw.properties.description }),
    ...(raw.properties?.image?.url === undefined ? {} : { imageUrl: raw.properties.image.url }),
    tags: (raw.tags ?? []).flatMap((t) => {
      const id = t.id ?? t.tag_id;
      return id && t.name.trim() && t.type.trim() ? [{ id, name: t.name, type: t.type }] : [];
    }),
  };

  if (result.provenance === "mock") {
    // Schema rejects fixtures whose IDs are not in the `mock:` namespace.
    return MockRecommendationCandidateSchema.parse({
      ...base,
      syntheticScore: raw.query?.affinity ?? 0,
      evidence: {
        source: "mock",
        requestId: result.requestId,
        seedEntityIds,
        fixtureId: raw.entity_id,
        note: MOCK_NOTE,
      },
    });
  }
  return QlooRecommendationCandidateSchema.parse({
    ...base,
    ...(raw.query?.affinity === undefined ? {} : { affinity: raw.query.affinity }),
    evidence: {
      source: "qloo",
      requestId: result.requestId,
      seedEntityIds,
      ...(raw.query?.explainability === undefined ? {} : { explainability: raw.query.explainability }),
    },
  });
}

export function normalizeRecommendations(
  result: ProviderResult<RawInsightsResponse>,
  seedEntityIds: string[],
  limit: number,
): RecommendationCandidate[] {
  const seen = new Set<string>();
  const unique = result.payload.results.entities.filter((raw) => {
    if (seen.has(raw.entity_id)) return false;
    seen.add(raw.entity_id);
    return true;
  });
  return unique.slice(0, limit).map((raw, index) => normalizeCandidate(raw, index + 1, result, seedEntityIds));
}

/**
 * Normalizes and keeps only candidates of the requested target domain with the
 * expected provenance. Anything else is rejected (counted), never coerced into
 * the target domain. Qloo's order and affinities are preserved.
 */
export function normalizeTargetCandidates(
  result: ProviderResult<RawInsightsResponse>,
  seedEntityIds: string[],
  limit: number,
  target: { targetType: EntityType; provenance: ProviderResult<unknown>["provenance"] },
): { candidates: RecommendationCandidate[]; rejected: number; acquisition: { returned: number; normalized: number; rejections: Array<{ entityId: string; reason: string }> } } {
  const all = normalizeRecommendations(result, seedEntityIds, limit);
  const anchors = new Set(seedEntityIds.map((id) => id.toUpperCase()));
  const candidates = all.filter((c) => c.entityType === target.targetType && c.evidence.source === target.provenance && !anchors.has(c.entityId.toUpperCase()));
  const accepted = new Set(candidates.map((c) => c.entityId));
  const seen = new Set<string>();
  const rejections: Array<{ entityId: string; reason: string }> = [];
  for (const raw of result.payload.results.entities) {
    const reason = seen.has(raw.entity_id) ? "DUPLICATE_ENTITY" : anchors.has(raw.entity_id.toUpperCase()) ? "SOURCE_ARTIST_EXCLUDED" : classify(raw) !== target.targetType ? "WRONG_ENTITY_TYPE" : !accepted.has(raw.entity_id) ? "CANDIDATE_LIMIT_OR_PROVENANCE" : null;
    seen.add(raw.entity_id);
    if (reason) rejections.push({ entityId: raw.entity_id, reason });
  }
  return { candidates, rejected: all.length - candidates.length, acquisition: { returned: result.payload.results.entities.length, normalized: candidates.length, rejections: rejections.slice(0, 100) } };
}
