import { z } from "zod";

/**
 * Server-authoritative domain capability registry (S9.2, generalized in S9.3).
 *
 * Everything TasteProbe knows about a cultural domain lives in DOMAINS, and
 * every source → target capability lives in DOMAIN_PAIRS. The single discovery
 * engine (provider URNs, normalization, question wording, Discovery Path copy,
 * session enums) reads from here; no code path is written for a concrete pair.
 *
 * Capability levels are deliberately separate (S9.3 skill §4):
 *   represented        — the domain row exists;
 *   search             — Qloo Search for it was verified live (or only documented);
 *   insightsTarget     — Qloo Insights `filter.type` for it was verified live;
 *   sessionReady       — normalization + question adapters exist and the offline
 *                        engine matrix covers it, so a signed session may hold it;
 *   pair evidence      — the strongest proof for a directed pair;
 *   pair enabled       — production may start it (requires FULL_E2E_VERIFIED).
 *
 * Adding a verified pair: update its PAIR_STATUS entry after a bounded live
 * Search → Start → Answer → Finish run. The module refuses to load if an
 * enabled pair lacks that evidence or uses a domain that is not session-ready.
 *
 * The browser never declares capabilities: it may only read the public projection.
 */

/** Live evidence for one domain-level capability. DOCUMENTED = Qloo docs only. */
export type DomainEvidence = "LIVE_VERIFIED" | "DOCUMENTED";

export type DomainDefinition = {
  /** Qloo wire type. Qloo calls a music artist `urn:entity:artist`, a video game `urn:entity:videogame`. */
  readonly qlooType: `urn:entity:${string}`;
  readonly noun: string;
  readonly plural: string;
  /** How a person consumes it, for wording like "read more …". */
  readonly verb: string;
  /** Narrative media may be described as "stories" in question wording. */
  readonly narrative: boolean;
  /** Deterministic tag-question wording; `{label}` is the exact verified tag name. */
  readonly tagQuestion: string;
  readonly search: DomainEvidence;
  readonly insightsTarget: DomainEvidence;
  readonly sessionReady: boolean;
};

const ALL_DOMAINS = ["movie", "book", "music_artist", "tv_show", "video_game", "podcast"] as const;
/** Domains a session can hold (normalization + question adapters exist, offline matrix passes). */
export const SESSION_DOMAINS = ALL_DOMAINS;

export const CulturalDomainSchema = z.enum(ALL_DOMAINS);
export type CulturalDomain = z.infer<typeof CulturalDomainSchema>;

const domain = (d: DomainDefinition) => Object.freeze(d);

// Evidence notes: S2 (movie Search, book Insights), S9.1 (artist Search), S9.3 live
// campaign 2026-10-29 (artist Insights; TV/game/podcast Search + Insights). See docs/cross-domain-engine.md.
export const DOMAINS: Readonly<Record<CulturalDomain, DomainDefinition>> = Object.freeze({
  movie: domain({
    qlooType: "urn:entity:movie", noun: "movie", plural: "movies", verb: "watch", narrative: true,
    tagQuestion: "Do you enjoy {label} movies?", search: "LIVE_VERIFIED", insightsTarget: "DOCUMENTED", sessionReady: true,
  }),
  book: domain({
    qlooType: "urn:entity:book", noun: "book", plural: "books", verb: "read", narrative: true,
    tagQuestion: "Do you enjoy {label} books?", search: "DOCUMENTED", insightsTarget: "LIVE_VERIFIED", sessionReady: true,
  }),
  music_artist: domain({
    qlooType: "urn:entity:artist", noun: "music artist", plural: "music artists", verb: "listen to", narrative: false,
    tagQuestion: "Do you enjoy music artists associated with {label}?", search: "LIVE_VERIFIED", insightsTarget: "LIVE_VERIFIED", sessionReady: true,
  }),
  tv_show: domain({
    qlooType: "urn:entity:tv_show", noun: "TV show", plural: "TV shows", verb: "watch", narrative: true,
    tagQuestion: "Do you enjoy {label} TV shows?", search: "LIVE_VERIFIED", insightsTarget: "LIVE_VERIFIED", sessionReady: true,
  }),
  video_game: domain({
    qlooType: "urn:entity:videogame", noun: "video game", plural: "video games", verb: "play", narrative: false,
    tagQuestion: "Do you enjoy {label} video games?", search: "LIVE_VERIFIED", insightsTarget: "LIVE_VERIFIED", sessionReady: true,
  }),
  podcast: domain({
    qlooType: "urn:entity:podcast", noun: "podcast", plural: "podcasts", verb: "listen to", narrative: false,
    tagQuestion: "Would you be interested in podcasts about {label}?", search: "LIVE_VERIFIED", insightsTarget: "LIVE_VERIFIED", sessionReady: true,
  }),
} as const);

export const QLOO_WIRE_TYPES: Readonly<Record<CulturalDomain, string>> = Object.freeze(
  Object.fromEntries(ALL_DOMAINS.map((d) => [d, DOMAINS[d].qlooType])) as Record<CulturalDomain, string>,
);

export const qlooTypeOf = (domain: CulturalDomain): string => DOMAINS[domain].qlooType;

export const isDomain = (value: string): value is CulturalDomain => (ALL_DOMAINS as readonly string[]).includes(value);

/** Reverse wire mapping, limited to session-ready domains (unknown or unsupported → undefined). Exact match only. */
export function sessionDomainOfQlooType(urn: string | undefined): (typeof SESSION_DOMAINS)[number] | undefined {
  const found = ALL_DOMAINS.find((d) => DOMAINS[d].qlooType === urn);
  return found && DOMAINS[found].sessionReady ? found : undefined;
}

/** Display noun for a domain; an unregistered value is returned as-is rather than guessed. */
export const domainLabel = (domain: string, plural = false): string =>
  isDomain(domain) ? (plural ? DOMAINS[domain].plural : DOMAINS[domain].noun) : domain;

const NEUTRAL_LANGUAGE = { verb: "explore", narrative: false, tagQuestion: "Are you interested in {label}?" } as const;

/** Language facts for a plural noun (used by question renderers that receive nouns). */
export function domainLanguageOfPlural(plural: string): Pick<DomainDefinition, "verb" | "narrative" | "tagQuestion"> {
  const found = ALL_DOMAINS.find((d) => DOMAINS[d].plural === plural);
  return found ? DOMAINS[found] : NEUTRAL_LANGUAGE;
}

/** Language facts for a singular noun. */
export function domainLanguageOfNoun(noun: string): Pick<DomainDefinition, "verb" | "narrative" | "tagQuestion"> {
  const found = ALL_DOMAINS.find((d) => DOMAINS[d].noun === noun);
  return found ? DOMAINS[found] : NEUTRAL_LANGUAGE;
}

/** The deterministic, domain-aware tag question. The verified label is inserted verbatim. */
export function tagQuestionText(target: string, label: string): string {
  const template = isDomain(target) ? DOMAINS[target].tagQuestion : NEUTRAL_LANGUAGE.tagQuestion;
  return template.replace("{label}", label);
}

/** Strongest evidence level reached for a directed pair. */
export const CapabilityEvidenceSchema = z.enum([
  "FULL_E2E_VERIFIED", // complete live HTTP session: Search → Start → (Answer) → Finish → Discovery Path
  "VERIFIED_INSIGHTS", // live Search + Insights only, no session
  "OFFLINE_MATRIX", // engine behaviour proven with fixtures only — NOT live Qloo coverage
  "INCONCLUSIVE",
]);
export type CapabilityEvidence = z.infer<typeof CapabilityEvidenceSchema>;

export type DomainPairCapability = {
  readonly source: CulturalDomain;
  readonly target: CulturalDomain;
  readonly enabled: boolean;
  readonly evidence: CapabilityEvidence;
};

type PairKey = `${CulturalDomain}->${CulturalDomain}`;

/**
 * Per-pair evidence. Every other directed cross-domain pair is registered as
 * disabled OFFLINE_MATRIX. Changing a row here is the whole change needed to
 * promote a pair once live evidence exists.
 */
const PAIR_STATUS: Partial<Record<PairKey, { enabled: boolean; evidence: CapabilityEvidence }>> = {
  // S7/S9 reference journey.
  "movie->book": { enabled: true, evidence: "FULL_E2E_VERIFIED" },
  // S9.3 live HTTP sessions (Upstash Redis, live Gemini): search → start → answer → replay 409 → finish → path.
  "music_artist->book": { enabled: true, evidence: "FULL_E2E_VERIFIED" },
  "movie->music_artist": { enabled: true, evidence: "FULL_E2E_VERIFIED" },
  // S9.14 real typed Search + Insights probes; held from public enablement until
  // production session/listening/browser acceptance is complete.
  "music_artist->music_artist": { enabled: false, evidence: "VERIFIED_INSIGHTS" },
  "tv_show->music_artist": { enabled: false, evidence: "VERIFIED_INSIGHTS" },
  "video_game->music_artist": { enabled: false, evidence: "VERIFIED_INSIGHTS" },
  "podcast->music_artist": { enabled: false, evidence: "VERIFIED_INSIGHTS" },
  "book->music_artist": { enabled: false, evidence: "INCONCLUSIVE" },
  // S9.3 probe: Insights from a verified movie returned 10/10 correctly typed, tagged entities. No session yet.
  // S9.5: full live HTTP lifecycle passed (Redis, Gemini, positive answer → local rerank). Kept
  // disabled until the browser journey is verified too, the S9.5 bar for public pairs.
  "movie->tv_show": { enabled: false, evidence: "FULL_E2E_VERIFIED" },
  "movie->video_game": { enabled: false, evidence: "VERIFIED_INSIGHTS" },
  "movie->podcast": { enabled: false, evidence: "VERIFIED_INSIGHTS" },
};

export const DOMAIN_PAIRS: readonly DomainPairCapability[] = Object.freeze(
  ALL_DOMAINS.flatMap((source) =>
    ALL_DOMAINS.filter((target) => target !== source || source === "music_artist").map((target) =>
      Object.freeze({ source, target, ...(PAIR_STATUS[`${source}->${target}`] ?? { enabled: false, evidence: "OFFLINE_MATRIX" as const }) }),
    ),
  ),
);

/** Structural rules every registry must satisfy; pure so a proposed table can be checked in tests. */
export function registryProblems(
  pairs: readonly DomainPairCapability[],
  domains: Readonly<Record<CulturalDomain, DomainDefinition>>,
): string[] {
  const problems: string[] = [];
  for (const d of ALL_DOMAINS) {
    if (domains[d].sessionReady !== (SESSION_DOMAINS as readonly string[]).includes(d)) {
      problems.push(`${d}: sessionReady disagrees with SESSION_DOMAINS`);
    }
    if (!domains[d].tagQuestion.includes("{label}")) problems.push(`${d}: tagQuestion lacks {label}`);
  }
  const keys = pairs.map((p) => `${p.source}->${p.target}`);
  if (new Set(keys).size !== keys.length) problems.push("duplicate pair");
  for (const p of pairs) {
    if (p.source === p.target && p.source !== "music_artist") problems.push(`${p.source}->${p.target}: same-domain pair`);
    if (!p.enabled) continue;
    for (const d of [p.source, p.target]) {
      if (!domains[d].sessionReady) problems.push(`${p.source}->${p.target}: ${d} has no session adapter`);
    }
    if (p.evidence !== "FULL_E2E_VERIFIED") problems.push(`${p.source}->${p.target}: enabled without FULL_E2E_VERIFIED evidence`);
  }
  return problems;
}

const startupProblems = registryProblems(DOMAIN_PAIRS, DOMAINS);
if (startupProblems.length) throw new Error(`Invalid domain registry: ${startupProblems.join("; ")}`);

export type PairStatus = "enabled" | "disabled" | "unregistered";

export function pairStatus(source: string, target: string): PairStatus {
  const row = DOMAIN_PAIRS.find((p) => p.source === source && p.target === target);
  if (!row) return "unregistered";
  return row.enabled ? "enabled" : "disabled";
}

export const isEnabledPair = (source: string, target: string): boolean => pairStatus(source, target) === "enabled";

export const pairKey = (source: string, target: string): string => `${source}->${target}`;

/**
 * Access decision for one request. `verificationPairs` comes only from server
 * configuration that is refused in production (config/env.ts); it can admit a
 * registered-but-disabled pair for an isolated internal verification run and
 * never an unregistered one. Browsers have no way to supply it.
 */
export type PairAccess = "enabled" | "verification" | "disabled" | "unregistered";

export function pairAccess(source: string, target: string, verificationPairs: readonly string[] = []): PairAccess {
  const status = pairStatus(source, target);
  if (status === "disabled" && verificationPairs.includes(pairKey(source, target))) return "verification";
  return status;
}

/** Domains a user may search for as a familiar anchor (sources of enabled pairs, plus verification-only sources). */
export const enabledSourceDomains = (verificationPairs: readonly string[] = []): CulturalDomain[] => [
  ...new Set(DOMAIN_PAIRS.filter((p) => p.enabled || pairAccess(p.source, p.target, verificationPairs) === "verification").map((p) => p.source)),
];

// ---- Public projection -----------------------------------------------------

export const PublicDomainPairSchema = z.object({
  source: CulturalDomainSchema,
  target: CulturalDomainSchema,
  sourceLabel: z.string(),
  targetLabel: z.string(),
});
export type PublicDomainPair = z.infer<typeof PublicDomainPairSchema>;

export const PublicCapabilitiesSchema = z.object({ pairs: z.array(PublicDomainPairSchema) });
export type PublicCapabilities = z.infer<typeof PublicCapabilitiesSchema>;

/** Enabled pairs only, with no wire types, evidence internals or verification-only pairs. */
export const publicCapabilities = (): PublicCapabilities => ({
  pairs: DOMAIN_PAIRS.filter((p) => p.enabled).map((p) => ({
    source: p.source,
    target: p.target,
    sourceLabel: domainLabel(p.source),
    targetLabel: domainLabel(p.target, true),
  })),
});
