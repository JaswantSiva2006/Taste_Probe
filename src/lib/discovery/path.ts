import {
  domainLabel,
  type DiscoveryPath,
  type DiscoveryPathItem,
  type DiscoveryPathRole,
  type DiscoveryView,
  type PathEvidence,
  type RankedRecommendation,
  type Tag,
} from "@/lib/contracts";
import { isUsefulTag } from "./tag-quality";

/**
 * S9.2 Discovery Path presenter. A pure, deterministic view of the final
 * shortlist: it assigns roles to recommendations already in the response and
 * explains them only with evidence carried by that response. It never calls a
 * provider, changes ranking, adds entities, or touches session state.
 */

export type PathInput = Pick<DiscoveryView, "recommendations" | "preferences" | "seed" | "targetType"> & {
  /**
   * S9.6: final recommendations already presented in earlier rounds. Featured
   * slots prefer candidates not yet presented (in unchanged rank order), so a
   * new round does not re-announce the same pick as a discovery.
   */
  previouslyPresentedIds?: string[];
};

const MAX_PREFERENCE_TAGS = 2;

/**
 * Words that would assert difficulty, novelty, popularity or quality. No
 * current metadata supports them, so they may only appear inside a quoted
 * verified name (a tag or the seed title).
 */
const UNSUPPORTED_CLAIM =
  /\b(beginners?|easy|easier|accessible|challenging|difficult|harder|advanced|novel(?:ty)?|obscure|adventurous|popular|bestsell\w*|acclaimed|classic|must[- ](?:read|watch|listen)|perfect|best|inspired|similar|because)\b/i;

const quote = (name: string) => `“${name}”`;
const listOf = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** An explicit entity rejection is the only ineligibility the ranking expresses. */
const eligible = (r: RankedRecommendation, input: PathInput) => !input.preferences.rejectedEntityIds.includes(r.candidate.entityId);

const presentedBefore = (r: RankedRecommendation, input: PathInput) => (input.previouslyPresentedIds ?? []).includes(r.candidate.entityId);

/** Featured-slot order: eligible candidates not yet presented, then already-presented ones; rank order kept within each. */
function featuredPool(input: PathInput): RankedRecommendation[] {
  const pool = input.recommendations.filter((r) => eligible(r, input));
  return [...pool.filter((r) => !presentedBefore(r, input)), ...pool.filter((r) => presentedBefore(r, input))];
}

/** Truthful tail for START HERE when higher-ranked results were skipped. */
function startTail(r: RankedRecommendation, input: PathInput): string {
  // Never present an earlier pick as new: say so when every unseen option is gone.
  if (presentedBefore(r, input)) return ". You were shown it in an earlier round; it now ranks highest among the picks you haven't turned down.";
  if (r.position === 1) return ", and it is the highest-ranked result.";
  const above = input.recommendations.filter((x) => x.position < r.position);
  const rejected = above.some((x) => !eligible(x, input));
  const seen = above.some((x) => eligible(x, input) && presentedBefore(x, input));
  if (rejected && seen) return ", and it is the highest-ranked result you haven't seen or turned down.";
  if (seen) return ", and it is the highest-ranked result you haven't been shown yet.";
  return ", and it is the highest-ranked result you didn't turn down.";
}

const usefulTags = (r: RankedRecommendation): Tag[] => r.candidate.tags.filter(isUsefulTag);

/** Confirmed positive preferences this candidate actually carries. */
function preferenceEvidence(r: RankedRecommendation, input: PathInput) {
  const { positiveTagIds, positiveEntityIds } = input.preferences;
  const tags = r.candidate.tags
    .filter((t) => positiveTagIds.includes(t.id) && r.matchedPositiveTagIds.includes(t.id))
    .slice(0, MAX_PREFERENCE_TAGS);
  const likedEntity = positiveEntityIds.includes(r.candidate.entityId);
  return { tags, likedEntity, ids: [...(likedEntity ? [r.candidate.entityId] : []), ...tags.map((t) => t.id)] };
}

/** First useful tag the candidate has and none of the reference picks have (never a rejected or already-cited tag). */
function contrastTag(r: RankedRecommendation, references: RankedRecommendation[], input: PathInput, exclude: string[]): Tag | null {
  const seen = new Set(references.flatMap((ref) => ref.candidate.tags.map((t) => t.id)));
  return (
    usefulTags(r).find(
      (t) => !seen.has(t.id) && !input.preferences.rejectedTagIds.includes(t.id) && !exclude.includes(t.id),
    ) ?? null
  );
}

function provenanceSentence(r: RankedRecommendation, input: PathInput, lead: "first" | "also"): string {
  const plural = domainLabel(input.targetType, true);
  const seed = quote(input.seed.name);
  if (r.candidate.evidence.source === "qloo") {
    return lead === "first"
      ? `Qloo returned this among its ${plural} for fans of ${seed}`
      : `Qloo also returned this for fans of ${seed}`;
  }
  return lead === "first"
    ? `This comes from TasteProbe's synthetic sample ${plural} for ${seed}, not from Qloo`
    : `This also comes from the synthetic sample set for ${seed}`;
}

function preferenceSentence(pref: ReturnType<typeof preferenceEvidence>, input: PathInput): string {
  const noun = domainLabel(input.targetType);
  const parts: string[] = [];
  if (pref.likedEntity) parts.push(`You said yes to this ${noun} during your questions.`);
  if (pref.tags.length) {
    const names = listOf(pref.tags.map((t) => quote(t.name)));
    parts.push(`You said yes to ${names}, and it carries ${pref.tags.length === 1 ? "that tag" : "those tags"}.`);
  }
  return parts.join(" ");
}

function evidenceOf(r: RankedRecommendation, input: PathInput, preferenceIds: string[], tagIds: string[]): PathEvidence {
  return {
    provenance: r.candidate.evidence.source,
    seedEntityIds: r.candidate.evidence.seedEntityIds.filter((id) => id === input.seed.entityId),
    preferenceIds,
    tagIds,
  };
}

/** The always-true fallback: provenance only. */
function neutralExplanation(r: RankedRecommendation, input: PathInput, role: DiscoveryPathRole): DiscoveryPathItem["explanation"] {
  const laterRound = (input.previouslyPresentedIds ?? []).length > 0;
  const tail =
    role === "START_HERE"
      ? startTail(r, input)
      : role === "EXPLORE_NEXT"
        ? !laterRound
          ? "; it ranks next."
          : presentedBefore(r, input)
            ? "; you were shown it in an earlier round."
            : "; it is the next pick you haven't been shown yet."
        : ".";
  return {
    kind: "source_grounded",
    text: `${provenanceSentence(r, input, role === "START_HERE" ? "first" : "also")}${tail}`,
    evidence: evidenceOf(r, input, [], []),
  };
}

function explain(
  r: RankedRecommendation,
  input: PathInput,
  role: DiscoveryPathRole,
  contrast: Tag | null,
): DiscoveryPathItem["explanation"] {
  const pref = preferenceEvidence(r, input);
  const neutral = neutralExplanation(r, input, role);
  const sentences: string[] = [];
  if (pref.ids.length) sentences.push(preferenceSentence(pref, input));
  if (contrast) {
    const others = role === "ANOTHER_DIRECTION" ? "the picks above" : "your first pick";
    sentences.push(`It is tagged ${quote(contrast.name)}, which ${others} ${role === "ANOTHER_DIRECTION" ? "don't" : "doesn't"} carry.`);
  }
  if (!sentences.length) return neutral;
  sentences.push(`${neutral.text}`);
  return {
    kind: pref.ids.length ? "preference_match" : "metadata_contrast",
    text: sentences.join(" "),
    evidence: evidenceOf(r, input, pref.ids, contrast ? [contrast.id] : []),
  };
}

function item(r: RankedRecommendation, input: PathInput, role: DiscoveryPathRole, contrast: Tag | null): DiscoveryPathItem {
  const candidate: DiscoveryPathItem = {
    role,
    recommendationEntityId: r.candidate.entityId,
    position: r.position,
    explanation: explain(r, input, role, contrast),
  };
  // Reject-or-replace: any explanation that fails grounding falls back to provenance only.
  return explanationProblems(candidate, input).length
    ? { ...candidate, explanation: neutralExplanation(r, input, role) }
    : candidate;
}

export function buildDiscoveryPath(input: PathInput): DiscoveryPath {
  const recs = input.recommendations;
  const pool = featuredPool(input);
  const featured: DiscoveryPathItem[] = [];

  // START HERE: the highest-ranked eligible recommendation not yet presented (round 1: exactly as ranked).
  const start = pool[0];
  if (start) featured.push(item(start, input, "START_HERE", null));

  // EXPLORE NEXT: the next eligible recommendation in rank order; a contrast is cited only if verified.
  const next = pool[1];
  if (start && next) featured.push(item(next, input, "EXPLORE_NEXT", contrastTag(next, [start], input, [])));

  // ANOTHER DIRECTION: optional; the first remaining eligible pick with a verified tag neither earlier pick has.
  if (start && next) {
    const cited = featured.flatMap((f) => f.explanation.evidence.tagIds);
    for (const r of pool.slice(2)) {
      const tag = contrastTag(r, [start, next], input, cited);
      if (tag) {
        featured.push(item(r, input, "ANOTHER_DIRECTION", tag));
        break;
      }
    }
  }

  const featuredIds = new Set(featured.map((f) => f.recommendationEntityId));
  return {
    version: 1,
    sourceType: input.seed.entityType,
    targetType: input.targetType,
    featured,
    remainingEntityIds: recs.map((r) => r.candidate.entityId).filter((id) => !featuredIds.has(id)),
  };
}

// ---- Grounding validation --------------------------------------------------

/** Removes quoted verified names so a tag like “Classic Literature” is not read as a claim. */
function unquoted(text: string, names: string[]): string {
  return names.reduce((t, name) => t.split(quote(name)).join(" "), text);
}

/** Problems with one item's explanation; empty when every claim resolves to evidence in the input. */
export function explanationProblems(entry: DiscoveryPathItem, input: PathInput): string[] {
  const problems: string[] = [];
  const r = input.recommendations.find((x) => x.candidate.entityId === entry.recommendationEntityId);
  if (!r) return [`${entry.recommendationEntityId}: not a final recommendation`];
  const { evidence, text, kind } = entry.explanation;
  const tagIds = r.candidate.tags.map((t) => t.id);

  if (evidence.provenance !== r.candidate.evidence.source) problems.push("provenance does not match the candidate");
  if (!evidence.seedEntityIds.every((id) => id === input.seed.entityId && r.candidate.evidence.seedEntityIds.includes(id))) {
    problems.push("seed evidence does not resolve");
  }
  for (const id of evidence.preferenceIds) {
    const isTag = input.preferences.positiveTagIds.includes(id) && tagIds.includes(id);
    const isEntity = input.preferences.positiveEntityIds.includes(id) && id === r.candidate.entityId;
    if (!isTag && !isEntity) problems.push(`preference ${id} is not a confirmed positive preference of this candidate`);
  }
  for (const id of evidence.tagIds) {
    if (!tagIds.includes(id)) problems.push(`tag ${id} is not on this candidate`);
    if (input.preferences.rejectedTagIds.includes(id)) problems.push(`tag ${id} was rejected by the user`);
  }
  if (kind === "preference_match" && !evidence.preferenceIds.length) problems.push("preference_match without preference evidence");
  if (kind === "metadata_contrast" && !evidence.tagIds.length) problems.push("metadata_contrast without tag evidence");
  if (r.candidate.evidence.source === "mock" && /\bQloo returned\b|\bQloo also returned\b/.test(text)) {
    problems.push("synthetic candidate described as Qloo-returned");
  }

  const cited = r.candidate.tags.filter((t) => evidence.preferenceIds.includes(t.id) || evidence.tagIds.includes(t.id));
  const scrubbed = unquoted(text, [input.seed.name, ...cited.map((t) => t.name)]);
  if (/[“”]/.test(scrubbed)) problems.push("quotes a name that is not cited evidence");
  const claim = scrubbed.match(UNSUPPORTED_CLAIM);
  if (claim) problems.push(`unsupported claim "${claim[0]}"`);
  return problems;
}

/** Whole-path invariants: real, unique IDs; unchanged ranking; no unjustified roles; grounded text. */
export function discoveryPathProblems(path: DiscoveryPath, input: PathInput): string[] {
  const problems: string[] = [];
  const ids = input.recommendations.map((r) => r.candidate.entityId);
  const featuredIds = path.featured.map((f) => f.recommendationEntityId);
  const all = [...featuredIds, ...path.remainingEntityIds];
  if (new Set(all).size !== all.length) problems.push("duplicate entity in path");
  if (all.length !== ids.length || !ids.every((id) => all.includes(id))) problems.push("path does not cover exactly the final recommendations");
  if (path.remainingEntityIds.join("|") !== ids.filter((id) => !featuredIds.includes(id)).join("|")) {
    problems.push("remaining recommendations are not in ranked order");
  }
  const firstEligible = featuredPool(input)[0];
  const start = path.featured.find((f) => f.role === "START_HERE");
  if (firstEligible && start?.recommendationEntityId !== firstEligible.candidate.entityId) problems.push("START_HERE is not the top eligible pick");
  if (path.featured[0] && path.featured[0].role !== "START_HERE") problems.push("first featured item is not START_HERE");
  if (path.featured.some((f) => f.role === "GO_FURTHER")) problems.push("GO_FURTHER has no supporting metadata");
  const roles = path.featured.map((f) => f.role);
  if (new Set(roles).size !== roles.length) problems.push("duplicate role");
  for (const f of path.featured) {
    const r = input.recommendations.find((x) => x.candidate.entityId === f.recommendationEntityId);
    if (r && r.position !== f.position) problems.push(`${f.recommendationEntityId}: position differs from ranking`);
    if (input.preferences.rejectedEntityIds.includes(f.recommendationEntityId)) problems.push(`${f.recommendationEntityId}: featured after explicit rejection`);
    problems.push(...explanationProblems(f, input).map((p) => `${f.recommendationEntityId}: ${p}`));
  }
  return problems;
}
