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
  // S9.4: synthetic music-artist anchors so every enabled journey runs offline.
  {
    entity_id: "mock:music_artist:glass-harbor",
    name: "Glass Harbor (synthetic)",
    types: ["urn:entity:artist"],
  },
  {
    entity_id: "mock:music_artist:glass-harbor-ensemble",
    name: "Glass Harbor Ensemble (synthetic)",
    types: ["urn:entity:artist"],
  },
  // Returns a single book, so the engine finishes truthfully without a question.
  {
    entity_id: "mock:music_artist:lone-signal",
    name: "Lone Signal (synthetic)",
    types: ["urn:entity:artist"],
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

const MUSIC = {
  ambient: tag("ambient-textures", "ambient textures"),
  orchestral: tag("orchestral-swell", "orchestral swell"),
  piano: tag("minimal-piano", "minimal piano"),
  pulse: tag("electronic-pulse", "electronic pulse"),
  choral: tag("choral-voices", "choral voices"),
  lyrics: tag("narrative-lyrics", "narrative lyrics"),
} as const;

const artist = (slug: string, name: string, syntheticScore: number, description: string | null, tags: RawTag[]): RawInsightEntity => ({
  entity_id: `mock:music_artist:${slug}`,
  name,
  subtype: "urn:entity:artist",
  query: { affinity: syntheticScore },
  ...(description ? { properties: { description } } : {}),
  tags,
});

const INTERSTELLAR_ARTISTS: readonly RawInsightEntity[] = [
  artist("tidal-organ", "The Tidal Organ (synthetic)", 0.91, "Synthetic fixture: vast pipe-organ drones.", [MUSIC.orchestral, MUSIC.ambient]),
  artist("quiet-orbit", "Quiet Orbit (synthetic)", 0.87, "Synthetic fixture: sparse piano under tape hiss.", [MUSIC.piano, MUSIC.ambient]),
  artist("signal-choir", "Signal Choir (synthetic)", 0.84, null, [MUSIC.choral, MUSIC.orchestral]),
  artist("dust-arcade", "Dust Arcade (synthetic)", 0.8, "Synthetic fixture: warm synth arpeggios.", [MUSIC.pulse]),
  artist("harbour-lights", "Harbour Lights (synthetic)", 0.77, "Synthetic fixture: story-songs about leaving home.", [MUSIC.lyrics, MUSIC.piano]),
  artist("night-ferry", "Night Ferry (synthetic)", 0.73, null, [MUSIC.pulse, MUSIC.choral]),
];

// Books for the music-artist anchor reuse the synthetic book shapes with their own order.
const GLASS_HARBOR_BOOKS: readonly RawInsightEntity[] = [
  book("eta", "The Lighthouse Keeper's Tapes (synthetic)", 0.9, "Synthetic fixture: a recording engineer alone on an island.", [TAGS.philosophy, TAGS.family]),
  book("theta", "Static Between Stations (synthetic)", 0.86, "Synthetic fixture: night radio and the people who call in.", [TAGS.romance, TAGS.philosophy]),
  book("iota", "Harbour Hymns (synthetic)", 0.82, "Synthetic fixture: a choir rebuilds a flooded town.", [TAGS.family]),
  INTERSTELLAR_BOOKS[2]!,
  book("kappa", "Liner Notes (synthetic)", 0.75, "Synthetic fixture: essays written on album sleeves.", [TAGS.philosophy]),
];

/** seed entity ID -> target type -> raw insight entities, in provider order. */
export const MOCK_RECOMMENDATIONS: Readonly<Record<string, Partial<Record<string, readonly RawInsightEntity[]>>>> = {
  "mock:movie:interstellar": { book: INTERSTELLAR_BOOKS, music_artist: INTERSTELLAR_ARTISTS },
  "mock:movie:interstellar-echoes": { book: INTERSTELLAR_BOOKS.slice(2), music_artist: INTERSTELLAR_ARTISTS.slice(1) },
  "mock:music_artist:glass-harbor": { book: GLASS_HARBOR_BOOKS },
  "mock:music_artist:glass-harbor-ensemble": { book: GLASS_HARBOR_BOOKS.slice(1) },
  "mock:music_artist:lone-signal": { book: [GLASS_HARBOR_BOOKS[0]!] },
};
