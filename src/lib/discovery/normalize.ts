import {
  EntitySummarySchema,
  MockRecommendationCandidateSchema,
  QlooRecommendationCandidateSchema,
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

const ENTITY_URN_PREFIX = "urn:entity:";

function toEntityType(urn: string | undefined): EntityType | undefined {
  const type = urn?.startsWith(ENTITY_URN_PREFIX) ? urn.slice(ENTITY_URN_PREFIX.length) : undefined;
  return type === "movie" || type === "book" ? type : undefined;
}

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
    entityType: toEntityType(raw.subtype) ?? raw.subtype,
    rank,
    description: raw.properties?.description,
    imageUrl: raw.properties?.image?.url,
    tags: (raw.tags ?? []).map((t) => ({ id: t.tag_id, name: t.name, type: t.type })),
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
    affinity: raw.query?.affinity,
    evidence: { source: "qloo", requestId: result.requestId, seedEntityIds },
  });
}

export function normalizeRecommendations(
  result: ProviderResult<RawInsightsResponse>,
  seedEntityIds: string[],
  limit: number,
): RecommendationCandidate[] {
  return result.payload.results.entities
    .slice(0, limit)
    .map((raw, index) => normalizeCandidate(raw, index + 1, result, seedEntityIds));
}
