import type { DiscoveryView, PreferenceResponse, Question, RankedRecommendation, UpdateMechanism } from "@/lib/contracts";
import { isUsefulTag } from "@/lib/discovery/tag-quality";

/**
 * Pure presentation helpers for the S8 interface. No network, no state:
 * everything here derives display text from existing API fields only.
 */

// ---- Answers -----------------------------------------------------------------------------

/** Labels for every backend response value. Values are never invented. */
export function answerLabel(response: PreferenceResponse, question: Question, names: NameBook): string {
  const [a, b] = question.targetIds;
  switch (response) {
    case "like":
      return "Yes, more of this";
    case "dislike":
      return "Not for me";
    case "prefer_a":
      return a ? `I'd pick ${shortTitle(names.entity(a))}` : "The first";
    case "prefer_b":
      return b ? `I'd pick ${shortTitle(names.entity(b))}` : "The second";
    case "both":
      return "Both appeal";
    case "neither":
      return "Neither";
    case "unknown":
      return question.targetType === "entity" ? "I don't know them" : "Not sure";
  }
}

/** Primary answers are emphasised; skips are visually quieter. */
export const isSkip = (response: PreferenceResponse) => response === "unknown";

// ---- Titles --------------------------------------------------------------------------------

/** Splits Goodreads-style "Title (Series, #1)" into title and series. */
export function splitTitle(name: string): { title: string; series: string | null } {
  const match = /^(.*?)\s*\(([^()]+,\s*#[\d.\-–]+)\)\s*$/.exec(name.trim());
  return match ? { title: match[1]!.trim(), series: match[2]!.trim() } : { title: name.trim(), series: null };
}

export const shortTitle = (name: string) => {
  const { title } = splitTitle(name);
  return title.length > 34 ? `${title.slice(0, 32).trimEnd()}…` : title;
};

// ---- Names for preference IDs ---------------------------------------------------------------

export type NameBook = { tag(id: string): string; entity(id: string): string; remember(view: DiscoveryView): void };

/** Readable fallback for an ID whose name we have never seen (e.g. "urn:tag:theme:qloo:space_travel" -> "space travel"). */
export function humanizeId(id: string): string {
  const last = id.split(/[:/]/).filter(Boolean).at(-1) ?? id;
  return last.replace(/[_-]+/g, " ").trim() || id;
}

/** Remembers tag/entity names from every view seen, so notes stay readable after reretrieval. */
export function createNameBook(): NameBook {
  const tags = new Map<string, string>();
  const entities = new Map<string, string>();
  return {
    tag: (id) => tags.get(id) ?? humanizeId(id),
    entity: (id) => entities.get(id) ?? humanizeId(id),
    remember(view) {
      entities.set(view.seed.entityId, view.seed.name);
      for (const { candidate } of view.recommendations) {
        entities.set(candidate.entityId, candidate.name);
        for (const t of candidate.tags) tags.set(t.id, t.name);
      }
    },
  };
}

export type TasteNote = { id: string; label: string; kind: "liked" | "passed"; target: "tag" | "entity" };

export function tasteNotes(view: DiscoveryView, names: NameBook): TasteNote[] {
  const p = view.preferences;
  return [
    ...p.positiveTagIds.map((id) => ({ id, label: names.tag(id), kind: "liked" as const, target: "tag" as const })),
    ...p.positiveEntityIds.map((id) => ({ id, label: shortTitle(names.entity(id)), kind: "liked" as const, target: "entity" as const })),
    ...p.rejectedTagIds.map((id) => ({ id, label: names.tag(id), kind: "passed" as const, target: "tag" as const })),
    ...p.rejectedEntityIds.map((id) => ({ id, label: shortTitle(names.entity(id)), kind: "passed" as const, target: "entity" as const })),
  ];
}

// ---- Book details -----------------------------------------------------------------------------

/** Labels Qloo files under genre that describe format/audience, not taste. Display only. */
const NON_TASTE_LABELS = new Set(["adult", "audiobook", "fiction", "nonfiction", "non-fiction", "novels", "books", "ebook", "kindle"]);

/** Up to `max` meaningful (content) tags from Qloo, never formats or audience buckets. */
export function displayTags(item: RankedRecommendation, max = 3): string[] {
  const seen = new Set<string>();
  return item.candidate.tags
    .filter((t) => isUsefulTag(t) && !NON_TASTE_LABELS.has(t.name.trim().toLowerCase()))
    .map((t) => t.name.trim())
    .filter((n) => (seen.has(n.toLowerCase()) ? false : (seen.add(n.toLowerCase()), true)))
    .slice(0, max);
}

/**
 * Strips Goodreads catalogue boilerplate that Qloo passes through at the start of
 * descriptions ("Librarian's note: An alternate cover edition can be found here",
 * "This is an alternate cover edition for ISBN …"). Removes text only; adds nothing.
 */
const BOILERPLATE = [
  /^\s*librarian['’]s note:\s*(an\s+)?alternate cover( edition)?( for this isbn)?( can be found)?( here)?[.:]?\s*/i,
  // most specific first, so the general ISBN pattern cannot consume half of it
  /^\s*an alternate cover( edition)? for this isbn can be found here\.?\s*/i,
  /^\s*(this is )?an alternate cover( edition)? (for|of) (this )?isbn\s*[\dxX-]*\.?\s*/i,
];
export function cleanDescription(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let out = text;
  for (const re of BOILERPLATE) out = out.replace(re, "");
  out = out.trim();
  return out.length >= 12 ? out : undefined;
}

/** Supported "why": only the preference matches the server actually applied. */
export function matchSummary(item: RankedRecommendation, names: NameBook): { boosted: string[]; lowered: string[] } {
  return {
    boosted: item.matchedPositiveTagIds.map((id) => names.tag(id)),
    lowered: item.matchedRejectedTagIds.map((id) => names.tag(id)),
  };
}

export type Movement = { kind: "new" | "up" | "down" | "same" | "initial"; by: number };

export function movementOf(item: RankedRecommendation, hasPrevious: boolean): Movement {
  if (!hasPrevious) return { kind: "initial", by: 0 };
  if (item.previousPosition === null) return { kind: "new", by: 0 };
  const by = item.previousPosition - item.position;
  return by > 0 ? { kind: "up", by } : by < 0 ? { kind: "down", by: -by } : { kind: "same", by: 0 };
}

/** Stable, ID-derived cloth colour for the "no cover from Qloo" fallback board. */
const CLOTHS = ["#5b2a2a", "#2f4a4a", "#6a5524", "#2d3550", "#4c3b5a", "#3e4a2c", "#6b3d24", "#23383f"];
export function clothFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CLOTHS[h % CLOTHS.length]!;
}

// ---- Update notices -----------------------------------------------------------------------------

export type UpdateNotice = { mechanism: UpdateMechanism; title: string; detail: string };

/**
 * What changed after an answer, stated truthfully. Uses the server's
 * recommendationUpdate when present (live); otherwise derives LOCAL_RERANK /
 * UNCHANGED from rankingChanged (the mock path never re-retrieves after start).
 */
export function updateNotice(view: DiscoveryView, names: NameBook): UpdateNotice | null {
  if (!view.lastAnswer) return null;
  const mechanism: UpdateMechanism = view.recommendationUpdate?.mechanism ?? (view.rankingChanged ? "LOCAL_RERANK" : "UNCHANGED");
  const moved = view.recommendations.filter((r) => r.previousPosition !== null && r.previousPosition !== r.position).length;
  const arrived = view.recommendations.filter((r) => r.previousPosition === null).length;
  const because = becauseOf(view, names);
  switch (mechanism) {
    case "QLOO_RERETRIEVAL":
      return {
        mechanism,
        title: "Fresh picks from Qloo",
        detail: `${because} TasteProbe asked Qloo again${arrived ? `; ${arrived} new ${arrived === 1 ? "book" : "books"} arrived` : ""}.`,
      };
    case "LOCAL_RERANK":
      return { mechanism, title: "Your shelf was reordered", detail: `${because} ${moved} ${moved === 1 ? "book" : "books"} changed place.` };
    case "UNCHANGED":
      return { mechanism, title: "Your shelf held steady", detail: `${because} The order didn't need to change.` };
    default:
      return null;
  }
}

function becauseOf(view: DiscoveryView, names: NameBook): string {
  const a = view.lastAnswer!;
  if (a.response === "unknown") return "You skipped that one, so nothing was assumed.";
  const label = a.targetType === "tag" ? names.tag(a.targetIds[0] ?? "") : shortTitle(names.entity(a.targetIds[0] ?? ""));
  if (a.response === "like") return `You said yes to ${label}.`;
  if (a.response === "dislike") return `You passed on ${label}.`;
  if (a.response === "prefer_a") return `You picked ${label}.`;
  if (a.response === "prefer_b") return `You picked ${shortTitle(names.entity(a.targetIds[1] ?? ""))}.`;
  if (a.response === "both") return "You liked both.";
  return "Neither appealed.";
}

// ---- Agent credit ----------------------------------------------------------------------------------

/** Who chose the current question, never crediting Gemini for a fallback. */
export function questionCredit(view: DiscoveryView, appMode: "mock" | "live" | null): string {
  switch (view.agent.mode) {
    case "LIVE_GEMINI":
      return "Chosen by Gemini from questions TasteProbe's optimizer approved";
    case "DETERMINISTIC_FALLBACK":
      return "Chosen by TasteProbe's optimizer (Gemini was not used for this step)";
    case "MOCK_AGENT":
      return "Chosen by the mock agent";
    default:
      return appMode === "mock" ? "Chosen by the deterministic mock agent" : "Chosen by TasteProbe's optimizer";
  }
}

/**
 * Questions actually answered. `questionCount` counts questions *asked*; when the
 * user ends early, the question on screen was asked but not answered.
 */
export function answeredCount(view: DiscoveryView): number {
  if (view.status === "finished" && view.finishReason === "user_finished") return Math.max(0, view.questionCount - 1);
  return view.status === "finished" ? view.questionCount : Math.max(0, view.questionCount - 1);
}

export function finishLine(view: DiscoveryView): string {
  const n = answeredCount(view);
  switch (view.finishReason) {
    case "user_finished":
      return n === 0 ? "You went straight to the books." : `You ended the screening after ${n} ${n === 1 ? "answer" : "answers"}.`;
    case "question_budget_exhausted":
      return "All three questions answered.";
    case "stable_recommendations":
      return "Nothing left to ask would have changed your shelf.";
    default:
      return "";
  }
}

// ---- Errors ------------------------------------------------------------------------------------------

export type Recovery = "retry" | "restart" | "edit";
export type FriendlyError = { title: string; body: string; recovery: Recovery };

export function friendlyError(code: string): FriendlyError {
  switch (code) {
    case "NETWORK_ERROR":
      return { title: "Connection lost", body: "We couldn't reach TasteProbe. Check your connection and try again.", recovery: "retry" };
    case "SESSION_EXPIRED":
      return { title: "This screening expired", body: "Sessions last 30 minutes. Start a new one with the same film.", recovery: "restart" };
    case "SESSION_REVISION_CONFLICT":
      return { title: "This screening moved on", body: "It was updated by another request (perhaps another tab). Start fresh to continue safely.", recovery: "restart" };
    case "SESSION_FINISHED":
    case "QUESTION_BUDGET_EXHAUSTED":
    case "QUESTION_MISMATCH":
      return { title: "That question is closed", body: "This screening has already moved past it.", recovery: "restart" };
    case "NO_RECOMMENDATIONS":
      return { title: "No books for this film", body: "Qloo didn't return any books for it. Try another film.", recovery: "edit" };
    case "ENTITY_NOT_FOUND":
    case "ENTITY_NOT_RESOLVED":
    case "ENTITY_TYPE_MISMATCH":
      return { title: "We couldn't confirm that film", body: "Search again and pick it from the list.", recovery: "edit" };
    case "QLOO_RATE_LIMITED":
      return { title: "Qloo is busy", body: "The recommendation service is rate-limiting requests. Wait a moment and try again.", recovery: "retry" };
    case "QLOO_TIMEOUT":
    case "QLOO_UPSTREAM_ERROR":
    case "QLOO_INVALID_RESPONSE":
    case "QLOO_AUTH_ERROR":
    case "QLOO_PERMISSION_ERROR":
    case "QLOO_BAD_REQUEST":
      return { title: "Qloo didn't answer", body: "The recommendation service had a problem. Try again in a moment.", recovery: "retry" };
    case "SESSION_STORE_UNAVAILABLE":
      return { title: "Session storage is unavailable", body: "We couldn't safely save your progress. Try again shortly.", recovery: "retry" };
    case "VALIDATION_ERROR":
      return { title: "That didn't look right", body: "Check what you typed and try again.", recovery: "edit" };
    default:
      return { title: "Something went wrong", body: "TasteProbe hit an unexpected problem. Try again.", recovery: "retry" };
  }
}
