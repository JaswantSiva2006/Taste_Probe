import type { PublicDomainPair } from "@/lib/contracts";

/**
 * S9.4 capability-driven choices and domain presentation. Availability comes
 * ONLY from the server's public projection (`/api/health` → capabilities.pairs);
 * this module never decides which pairs exist. The presentation table below
 * is cosmetic (glyph and artwork shape), with a neutral fallback, so a newly
 * enabled domain renders without code changes.
 */

export type DomainChoice = { domain: string; label: string; pluralLabel: string };

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Distinct enabled destinations, in registry order. */
export function targetChoices(pairs: readonly PublicDomainPair[]): DomainChoice[] {
  const seen = new Map<string, DomainChoice>();
  for (const p of pairs) {
    if (!seen.has(p.target)) seen.set(p.target, { domain: p.target, label: capitalize(p.targetLabel), pluralLabel: p.targetLabel });
  }
  return [...seen.values()];
}

/** Familiar-anchor domains the server allows for one destination. */
export function sourceChoices(pairs: readonly PublicDomainPair[], target: string | null): DomainChoice[] {
  if (!target) return [];
  const seen = new Map<string, DomainChoice>();
  for (const p of pairs) {
    if (p.target === target && !seen.has(p.source)) seen.set(p.source, { domain: p.source, label: p.sourceLabel, pluralLabel: `${p.sourceLabel}s` });
  }
  return [...seen.values()];
}

/** True only for a pair the server published; the start button is disabled otherwise. */
export const isOfferedPair = (pairs: readonly PublicDomainPair[], source: string | null, target: string | null) =>
  Boolean(source && target && pairs.some((p) => p.source === source && p.target === target));

/** "a movie" / "an album" — indefinite article for a singular label. */
export const withArticle = (label: string) => `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;

// ---- presentation (cosmetic only) -------------------------------------------------------------

export type Glyph = "film" | "book" | "vinyl" | "screen" | "controller" | "mic" | "spark";
/** Artwork frame: books, films and shows are posters/covers; artists, games and podcasts are square. */
export type ArtShape = "portrait" | "square";

const LOOK: Record<string, { glyph: Glyph; shape: ArtShape }> = {
  movie: { glyph: "film", shape: "portrait" },
  book: { glyph: "book", shape: "portrait" },
  music_artist: { glyph: "vinyl", shape: "square" },
  tv_show: { glyph: "screen", shape: "portrait" },
  video_game: { glyph: "controller", shape: "square" },
  podcast: { glyph: "mic", shape: "square" },
};

export const lookOf = (domain: string): { glyph: Glyph; shape: ArtShape } => LOOK[domain] ?? { glyph: "spark", shape: "square" };

/** Truthful alt text: a book image is its cover; for anything else we only know Qloo supplied an image. */
export const artAlt = (domain: string, title: string) => (domain === "book" ? `Cover of ${title}` : `Image for ${title} from Qloo`);
