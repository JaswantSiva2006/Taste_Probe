import { z } from "zod";

/**
 * S9.2 server-authoritative domain capability registry.
 *
 * Product domains are TasteProbe's names; Qloo wire types are owned here and
 * nowhere else (Qloo calls a music artist `urn:entity:artist`, not
 * `music_artist`). Only pairs listed below exist, and only enabled pairs may
 * start a session. The browser never declares capabilities: it may only read
 * the public projection.
 */

export const CulturalDomainSchema = z.enum(["movie", "book", "music_artist"]);
export type CulturalDomain = z.infer<typeof CulturalDomainSchema>;

export const QLOO_WIRE_TYPES = {
  movie: "urn:entity:movie",
  book: "urn:entity:book",
  music_artist: "urn:entity:artist",
} as const satisfies Record<CulturalDomain, `urn:entity:${string}`>;

export const qlooTypeOf = (domain: CulturalDomain): string => QLOO_WIRE_TYPES[domain];

const DOMAIN_LABELS: Record<CulturalDomain, { singular: string; plural: string }> = {
  movie: { singular: "film", plural: "films" },
  book: { singular: "book", plural: "books" },
  music_artist: { singular: "music artist", plural: "music artists" },
};

export const domainLabel = (domain: CulturalDomain, plural = false): string =>
  plural ? DOMAIN_LABELS[domain].plural : DOMAIN_LABELS[domain].singular;

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
  // S9.1: Search + Insights verified with a real artist ID; the full session journey was not.
  Object.freeze({ source: "music_artist", target: "book", enabled: false, evidence: "VERIFIED_INSIGHTS" } as const),
  Object.freeze({ source: "movie", target: "music_artist", enabled: false, evidence: "INCONCLUSIVE" } as const),
]);

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
