/**
 * Provider-specific raw response shapes, loosely modelled on Qloo's
 * Search / Insights payloads. Only the normalizer (K1) should depend on these;
 * the rest of the app uses the public contracts in src/lib/contracts.
 * S2/S3 will tighten these against the real Qloo API.
 */

export type RawTag = {
  tag_id?: string;
  id?: string;
  name: string;
  type: string;
};

export type RawSearchEntity = {
  entity_id: string;
  name: string;
  types: string[];
  tags?: RawTag[];
  properties?: { release_year?: number; publication_year?: number };
};

export type RawSearchResponse = {
  results: RawSearchEntity[];
};

export type RawInsightEntity = {
  entity_id: string;
  name: string;
  subtype: string;
  /** Qloo also returns a separate `type` (and sometimes `types[]`); kept verbatim for classification. */
  type?: string;
  types?: string[];
  /** Qloo affinity for live data; a synthetic score for fixtures. */
  query?: { affinity?: number; explainability?: unknown };
  popularity?: number;
  properties?: { description?: string; image?: { url?: string } };
  tags?: RawTag[];
};

export type RawInsightsResponse = {
  success: boolean;
  results: { entities: RawInsightEntity[] };
};

/** Raw provider payload plus where it came from, so provenance survives normalization. */
export type ProviderResult<T> = {
  provenance: "mock" | "qloo";
  requestId: string;
  /** Number of actual upstream HTTP attempts; zero for fixtures. */
  requestCount: number;
  payload: T;
};
