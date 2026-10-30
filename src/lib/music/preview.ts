import type { PreviewSelection, VerifiedSongOption } from "@/lib/contracts";
import type { FeaturedMomentEntry } from "./types";

/**
 * S9.15 verified listening previews (pure, no I/O).
 *
 * A preview is a window of the CURRENT verified recording, played with the official
 * IFrame API's startSeconds/endSeconds. Every window is derived here, on the server,
 * from verified data; the client and the model only ever refer to a candidate ID.
 *
 * Two kinds exist today:
 * - REVIEWED_SEGMENT: a registry moment a person listened to and APPROVED (reviewer,
 *   date, and an optional note written after listening). None is approved yet.
 * - GENERIC_PREVIEW: a timing-only window from the verified duration. It is labelled
 *   "Quick preview" and makes no claim about chorus, drop, climax or "best part".
 * VERIFIED_TIMED_CUE is reserved for a legitimate timed source; nothing produces one.
 */

export const PREVIEW_MIN_SECONDS = 20;
export const PREVIEW_MAX_SECONDS = 35;
export const GENERIC_PREVIEW_SECONDS = 30;
/** Below this the whole recording is short enough to hear in full: no preview is offered. */
export const SHORT_RECORDING_SECONDS = 45;
/** Seconds of the recording left after a generic excerpt, so it never runs to the very end. */
const TAIL_SECONDS = 10;
const MAX_CANDIDATES = 6;

export type PreviewCandidate = {
  id: string;
  artistId: string;
  videoId: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  sourceKind: PreviewSelection["sourceKind"];
  evidence:
    | { kind: "human_review"; reviewedBy: string; reviewedAt: string; annotation: string | null }
    | { kind: "timing_policy"; policy: "generic-v1" };
  checkedAt: string;
  reviewStatus: PreviewSelection["reviewStatus"];
};

/** Finite whole seconds, 0 ≤ start < end ≤ duration, length within the preview bounds. */
export function validPreviewWindow(startSeconds: number, endSeconds: number, durationSeconds: number | undefined): boolean {
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
  if (!Number.isInteger(startSeconds) || !Number.isInteger(endSeconds)) return false;
  if (startSeconds < 0 || endSeconds <= startSeconds || endSeconds > durationSeconds) return false;
  const length = endSeconds - startSeconds;
  return length >= PREVIEW_MIN_SECONDS && length <= PREVIEW_MAX_SECONDS;
}

/**
 * Deterministic generic window ("generic-v1"): 30 seconds beginning about a third of the
 * way in, on a 5-second grid, leaving at least 10 seconds after it. Skipping the opening
 * avoids offering only an intro or silence; it is still just a timing choice, not a highlight.
 * Unknown, non-finite or short durations get no preview (full playback only).
 */
export function genericPreviewWindow(durationSeconds: number | undefined): { startSeconds: number; endSeconds: number } | null {
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds < SHORT_RECORDING_SECONDS) return null;
  const latest = Math.floor(durationSeconds - GENERIC_PREVIEW_SECONDS - TAIL_SECONDS);
  const startSeconds = Math.max(0, Math.min(Math.round((durationSeconds * 0.3) / 5) * 5, latest));
  const endSeconds = startSeconds + GENERIC_PREVIEW_SECONDS;
  return validPreviewWindow(startSeconds, endSeconds, durationSeconds) ? { startSeconds, endSeconds } : null;
}

/** Bounded, deduplicated candidates for one verified recording: approved reviewed segments first, then the generic window. */
export function previewCandidatesFor(option: VerifiedSongOption, moments: readonly FeaturedMomentEntry[], checkedAt: string): PreviewCandidate[] {
  const duration = option.durationSeconds;
  if (duration === undefined) return [];
  const out: PreviewCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: PreviewCandidate) => {
    const key = `${c.startSeconds}-${c.endSeconds}`;
    if (seen.has(key) || out.length >= MAX_CANDIDATES) return;
    seen.add(key);
    out.push(c);
  };
  for (const m of moments) {
    if (m.videoId !== option.videoId || m.status !== "APPROVED" || !m.reviewedBy || !m.reviewedAt) continue;
    if (!validPreviewWindow(m.startSeconds, m.endSeconds, duration)) continue;
    push({
      id: `rs-${m.startSeconds}-${m.endSeconds}`,
      artistId: option.artistId,
      videoId: option.videoId,
      startSeconds: m.startSeconds,
      endSeconds: m.endSeconds,
      durationSeconds: duration,
      sourceKind: "REVIEWED_SEGMENT",
      evidence: { kind: "human_review", reviewedBy: m.reviewedBy, reviewedAt: m.reviewedAt, annotation: m.note.trim() || null },
      checkedAt,
      reviewStatus: "APPROVED",
    });
  }
  const generic = genericPreviewWindow(duration);
  if (generic) {
    push({
      id: `gp-${generic.startSeconds}-${generic.endSeconds}`,
      artistId: option.artistId,
      videoId: option.videoId,
      ...generic,
      durationSeconds: duration,
      sourceKind: "GENERIC_PREVIEW",
      evidence: { kind: "timing_policy", policy: "generic-v1" },
      checkedAt,
      reviewStatus: "TIMING_ONLY",
    });
  }
  return out;
}

/** Reviewed segments carrying a listener's note: the only candidates a model has any basis to compare. */
export const annotatedSegments = (candidates: readonly PreviewCandidate[]) =>
  candidates.filter((c) => c.sourceKind === "REVIEWED_SEGMENT" && c.evidence.kind === "human_review" && c.evidence.annotation);

export function selectionOf(c: PreviewCandidate, selectionMethod: PreviewSelection["selectionMethod"], reasonCode: string, fallbackReason: string | null): PreviewSelection {
  return {
    candidateId: c.id,
    artistId: c.artistId,
    videoId: c.videoId,
    startSeconds: c.startSeconds,
    endSeconds: c.endSeconds,
    durationSeconds: c.durationSeconds,
    sourceKind: c.sourceKind,
    selectionMethod,
    reasonCode,
    reviewStatus: c.reviewStatus,
    label: c.sourceKind === "REVIEWED_SEGMENT" ? "Featured preview" : "Quick preview",
    fallbackReason,
  };
}

/** No model: the first reviewed segment, else the generic window, else none. */
export function deterministicPreview(candidates: readonly PreviewCandidate[], fallbackReason: string | null): PreviewSelection | null {
  const reviewed = candidates.find((c) => c.sourceKind === "REVIEWED_SEGMENT");
  if (reviewed) return selectionOf(reviewed, "REVIEWED_DEFAULT", "first_reviewed_segment", fallbackReason);
  const generic = candidates.find((c) => c.sourceKind === "GENERIC_PREVIEW");
  return generic ? selectionOf(generic, "DETERMINISTIC", "timing_only_window", fallbackReason) : null;
}

/** Server re-check of a chosen candidate against the authorized artist and current recording. */
export function authorizedCandidate(candidates: readonly PreviewCandidate[], id: unknown, artistId: string, videoId: string): PreviewCandidate | null {
  const c = candidates.find((x) => x.id === id);
  if (!c || c.artistId !== artistId || c.videoId !== videoId) return null;
  return validPreviewWindow(c.startSeconds, c.endSeconds, c.durationSeconds) ? c : null;
}
