/**
 * S9.15 preview boundary policy for the official IFrame player (pure, testable).
 *
 * The player is given startSeconds/endSeconds when a preview is loaded, but YouTube
 * documents that endSeconds no longer applies after seekTo() (our own Back 10 s, or a
 * native scrub). So while a preview is PLAYING the client also checks the real playback
 * position, using the player's own clock (getCurrentTime), never elapsed wall time:
 * pauses and buffering therefore never count towards the preview.
 *
 * - Inside the window: keep playing.
 * - At or past the end (within a small slack): stop the preview.
 * - Well outside the window: the listener scrubbed with YouTube's own controls. We do
 *   not fight that with a seek-back loop; the player switches to full listening.
 */

export type PreviewWindow = { startSeconds: number; endSeconds: number };
export type GuardDecision = "continue" | "stop" | "exit_to_full";

/** Seconds of tolerance around the window (seek granularity, keyframes, timer cadence). */
export const PREVIEW_SLACK_SECONDS = 1.5;
/** Ignore "before start" readings briefly after a load: the player may still report 0 while it seeks. */
export const SETTLE_MS = 1500;
/** How often the guard samples the player while a preview is playing. */
export const GUARD_INTERVAL_MS = 250;

export function isPlayableWindow(w: PreviewWindow | null | undefined, durationSeconds?: number | null): w is PreviewWindow {
  if (!w) return false;
  const { startSeconds: s, endSeconds: e } = w;
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s) return false;
  return !durationSeconds || !Number.isFinite(durationSeconds) || e <= durationSeconds + PREVIEW_SLACK_SECONDS;
}

export function previewTick(time: number, w: PreviewWindow, msSinceLoad: number): GuardDecision {
  if (!Number.isFinite(time)) return "continue";
  if (time > w.endSeconds + PREVIEW_SLACK_SECONDS) return "exit_to_full";
  if (time >= w.endSeconds - 0.2) return "stop";
  if (time < w.startSeconds - PREVIEW_SLACK_SECONDS && msSinceLoad > SETTLE_MS) return "exit_to_full";
  return "continue";
}

/** Our own Back 10 s inside a preview never leaves the window. */
export const rewindTarget = (time: number, seconds: number, w: PreviewWindow | null): number => Math.max(w ? w.startSeconds : 0, time - seconds);

/** "0:45–1:15" */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const rangeLabel = (w: PreviewWindow) => `${clock(w.startSeconds)}–${clock(w.endSeconds)}`;
