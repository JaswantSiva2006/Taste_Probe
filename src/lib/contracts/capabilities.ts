import { z } from "zod";

/**
 * S9.2 server-authoritative domain capability registry.
 *
 * Everything TasteProbe knows about a cultural domain lives in DOMAINS, and
 * every source → target capability lives in DOMAIN_PAIRS. The rest of the
 * pipeline (provider URNs, normalization, question nouns, Discovery Path copy,
 * session enums) reads from here, so adding a verified pair is a local change:
 *
 *   1. add/complete the domain row (Qloo wire type, nouns, `sessionReady`);
 *   2. add the pair row and enable it only after a bounded live E2E run.
 *
 * `sessionReady` means the domain is in the session enum and the existing
 * normalizer/question adapters handle it. The module refuses to load if an
 * enabled pair uses a domain that is not session-ready.
 *
 * The browser never declares capabilities: it may only read the public projection.
 */

export type DomainDefinition = {
  /** Verified Qloo wire type. Qloo calls a music artist `urn:entity:artist`. */
  readonly qlooType: `urn:entity:${string}`;
  readonly noun: string;
  readonly plural: string;
  /** How a person consumes it, for wording like "read more …". */
  readonly verb: string;
  /** Narrative media may be described as "stories" in question wording. */
  readonly narrative: boolean;
  readonly sessionReady: boolean;
};

const ALL_DOMAINS = ["movie", "book", "music_artist"] as const;
/** Domains a session can hold today (normalization + question adapters exist). */
export const SESSION_DOMAINS = ["movie", "book"] as const;

export const CulturalDomainSchema = z.enum(ALL_DOMAINS);
export type CulturalDomain = z.infer<typeof CulturalDomainSchema>;

export const DOMAINS: Readonly<Record<CulturalDomain, DomainDefinition>> = Object.freeze({
  movie: Object.freeze({ qlooType: "urn:entity:movie", noun: "movie", plural: "movies", verb: "watch", narrative: true, sessionReady: true }),
  book: Object.freeze({ qlooType: "urn:entity:book", noun: "book", plural: "books", verb: "read", narrative: true, sessionReady: true }),
  // Registered for S9.4; Search/Insights verified in S9.1, no session adapter yet.
  music_artist: Object.freeze({ qlooType: "urn:entity:artist", noun: "music artist", plural: "music artists", verb: "listen to", narrative: false, sessionReady: false }),
} as const);

export const QLOO_WIRE_TYPES: Readonly<Record<CulturalDomain, string>> = Object.freeze(
  Object.fromEntries(ALL_DOMAINS.map((d) => [d, DOMAINS[d].qlooType])) as Record<CulturalDomain, string>,
);

export const qlooTypeOf = (domain: CulturalDomain): string => DOMAINS[domain].qlooType;

const isDomain = (value: string): value is CulturalDomain => (ALL_DOMAINS as readonly string[]).includes(value);

/** Reverse wire mapping, limited to session-ready domains (unknown or unsupported → undefined). */
export function sessionDomainOfQlooType(urn: string | undefined): (typeof SESSION_DOMAINS)[number] | undefined {
  const domain = ALL_DOMAINS.find((d) => DOMAINS[d].qlooType === urn);
  return domain && (SESSION_DOMAINS as readonly string[]).includes(domain) ? (domain as (typeof SESSION_DOMAINS)[number]) : undefined;
}

/** Display noun for a domain; an unregistered value is returned as-is rather than guessed. */
export const domainLabel = (domain: string, plural = false): string =>
  isDomain(domain) ? (plural ? DOMAINS[domain].plural : DOMAINS[domain].noun) : domain;

/** Language facts for a plural noun (used by question renderers that receive nouns). */
export function domainLanguageOfPlural(plural: string): Pick<DomainDefinition, "verb" | "narrative"> {
  const domain = ALL_DOMAINS.find((d) => DOMAINS[d].plural === plural);
  return domain ? DOMAINS[domain] : { verb: "explore", narrative: false };
}

/** Strongest evidence level reached for a pair (S9.1 audit vocabulary). */
export const CapabilityEvidenceSchema = z.enum(["FULL_E2E_VERIFIED", "VERIFIED_INSIGHTS", "INCONCLUSIVE"]);
export type CapabilityEvidence = z.infer<typeof CapabilityEvidenceSchema>;

export type DomainPairCapability = {
  readonly source: CulturalDomain;
  readonly target: CulturalDomain;
  readonly enabled: boolean;
  readonly evidence: CapabilityEvidence;
};

export const DOMAIN_PAIRS: readonly DomainPairCapability[] = Object.freeze([
  Object.freeze({ source: "movie", target: "book", enabled: true, evidence: "FULL_E2E_VERIFIED" } as const),
  // S9.1: Search + Insights verified with a real artist ID; the full session journey was not (S9.4).
  Object.freeze({ source: "music_artist", target: "book", enabled: false, evidence: "VERIFIED_INSIGHTS" } as const),
  Object.freeze({ source: "movie", target: "music_artist", enabled: false, evidence: "INCONCLUSIVE" } as const),
]);

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
  }
  const keys = pairs.map((p) => `${p.source}->${p.target}`);
  if (new Set(keys).size !== keys.length) problems.push("duplicate pair");
  for (const p of pairs) {
    if (p.source === p.target) problems.push(`${p.source}->${p.target}: same-domain pair`);
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

/** Domains a user may search for as a familiar anchor (sources of enabled pairs). */
export const enabledSourceDomains = (): CulturalDomain[] => [
  ...new Set(DOMAIN_PAIRS.filter((p) => p.enabled).map((p) => p.source)),
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

/** Enabled pairs only, with no wire types or evidence internals. */
export const publicCapabilities = (): PublicCapabilities => ({
  pairs: DOMAIN_PAIRS.filter((p) => p.enabled).map((p) => ({
    source: p.source,
    target: p.target,
    sourceLabel: domainLabel(p.source),
    targetLabel: domainLabel(p.target, true),
  })),
});
