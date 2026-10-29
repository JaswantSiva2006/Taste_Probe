import type { EntityType, ProviderMode } from "@/lib/contracts";
import type { ProviderResult, RawInsightsResponse, RawSearchEntity, RawSearchResponse } from "./raw-types";

export type RecommendationRequest = {
  seedEntityIds: string[];
  targetType: EntityType;
  take: number;
};

/**
 * Narrow Qloo boundary (T1 search + T2 insights). The live implementation in a
 * later segment must satisfy the same interface; callers never branch on mode.
 */
export interface QlooProvider {
  readonly mode: ProviderMode;
  searchEntities(query: string, type?: EntityType): Promise<ProviderResult<RawSearchResponse>>;
  /** Resolve a single entity by ID, or null when unknown. */
  getEntity(entityId: string): Promise<ProviderResult<RawSearchEntity | null>>;
  getRecommendations(request: RecommendationRequest): Promise<ProviderResult<RawInsightsResponse>>;
}
