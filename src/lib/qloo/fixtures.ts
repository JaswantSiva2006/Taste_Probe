import type { RawInsightEntity, RawSearchEntity, RawTag } from "./raw-types";

/**
 * SYNTHETIC FIXTURES — not Qloo data.
 * Every ID uses the `mock:` namespace. Book titles, descriptions, tags and
 * scores are invented for testing the discovery loop and make no claim about
 * real works or measured affinities.
 */

const tag = (slug: string, name: string): RawTag => ({
  tag_id: `mock:tag:${slug}`,
  name,
  type: "mock:tag:theme",
});

const TAGS = {
  hardSf: tag("hard-science-fiction", "hard science fiction"),
  space: tag("space-exploration", "space exploration"),
  family: tag("family-drama", "family drama"),
  time: tag("time-dilation", "time and relativity"),
  philosophy: tag("philosophical", "philosophical reflection"),
  action: tag("space-opera-action", "space-opera action"),
  romance: tag("romance", "romance"),
} as const;

export const MOCK_SEARCH_ENTITIES: readonly RawSearchEntity[] = [
  {
    entity_id: "mock:movie:interstellar",
    name: "Interstellar",
    types: ["urn:entity:movie"],
    properties: { release_year: 2014 },
  },
  {
    entity_id: "mock:movie:interstellar-echoes",
    name: "Interstellar Echoes (synthetic)",
    types: ["urn:entity:movie"],
  },
  {
    entity_id: "mock:book:alpha",
    name: "The Gravity Archive (synthetic)",
    types: ["urn:entity:book"],
  },
];

const book = (
  slug: string,
  name: string,
  syntheticScore: number,
  description: string,
  tags: RawTag[],
): RawInsightEntity => ({
  entity_id: `mock:book:${slug}`,
  name,
  subtype: "urn:entity:book",
  query: { affinity: syntheticScore },
  properties: { description },
  tags,
});

const INTERSTELLAR_BOOKS: readonly RawInsightEntity[] = [
  book("alpha", "The Gravity Archive (synthetic)", 0.92, "Synthetic fixture: engineers chart a wormhole.", [TAGS.hardSf, TAGS.space]),
  book("beta", "Letters from the Dust Belt (synthetic)", 0.88, "Synthetic fixture: a family waits for a voyager.", [TAGS.family, TAGS.philosophy]),
  book("gamma", "Slow Clocks (synthetic)", 0.85, "Synthetic fixture: physics of relativistic travel.", [TAGS.hardSf, TAGS.time]),
  book("delta", "Fleet of the Outer Ring (synthetic)", 0.81, "Synthetic fixture: interstellar battles.", [TAGS.action, TAGS.space]),
  book("epsilon", "What the Horizon Keeps (synthetic)", 0.78, "Synthetic fixture: meditations on time.", [TAGS.philosophy, TAGS.time]),
  book("zeta", "A Harvest of Stars (synthetic)", 0.74, "Synthetic fixture: love across a dying farm.", [TAGS.family, TAGS.romance]),
];

/** seed entity ID -> target type -> raw insight entities, in provider order. */
export const MOCK_RECOMMENDATIONS: Readonly<Record<string, Partial<Record<string, readonly RawInsightEntity[]>>>> = {
  "mock:movie:interstellar": { book: INTERSTELLAR_BOOKS },
  "mock:movie:interstellar-echoes": { book: INTERSTELLAR_BOOKS.slice(2) },
};
