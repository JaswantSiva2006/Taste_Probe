import { randomUUID } from "node:crypto";
import { qlooTypeOf as typeUrn } from "@/lib/contracts";
import { MOCK_RECOMMENDATIONS, MOCK_SEARCH_ENTITIES } from "./fixtures";
import type { QlooProvider, RecommendationRequest } from "./provider";
import type { ProviderResult, RawInsightsResponse, RawSearchEntity, RawSearchResponse } from "./raw-types";

const mockResult = <T>(payload: T): ProviderResult<T> => ({
  provenance: "mock",
  requestId: `mock-req-${randomUUID()}`,
  requestCount: 0,
  payload,
});

/** Fixture-backed provider. Performs no network I/O. */
export function createMockQlooProvider(): QlooProvider {
  return {
    mode: "mock",

    async searchEntities(query, type): Promise<ProviderResult<RawSearchResponse>> {
      const needle = query.trim().toLowerCase();
      const results = MOCK_SEARCH_ENTITIES.filter(
        (e) =>
          e.name.toLowerCase().includes(needle) && (!type || e.types.includes(typeUrn(type))),
      ).map((e) => structuredClone(e));
      return mockResult({ results });
    },

    async getEntity(entityId): Promise<ProviderResult<RawSearchEntity | null>> {
      const found = MOCK_SEARCH_ENTITIES.find((e) => e.entity_id === entityId);
      return mockResult(found ? structuredClone(found) : null);
    },

    async getRecommendations({ seedEntityIds, targetType, take }: RecommendationRequest) {
      const entities = seedEntityIds.flatMap((id) => MOCK_RECOMMENDATIONS[id]?.[targetType] ?? []);
      const unique = [...new Map(entities.map((e) => [e.entity_id, e])).values()];
      return mockResult<RawInsightsResponse>({
        success: true,
        results: { entities: structuredClone(unique.slice(0, take)) },
      });
    },
  };
}
