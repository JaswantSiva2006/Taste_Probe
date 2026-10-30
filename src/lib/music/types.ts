/**
 * S9.9 music playback types. Four provenances are kept apart on purpose:
 * the Qloo artist (Qloo returned it), the YouTube video (YouTube reports it),
 * the artist/video match (a reviewer checked it) and any featured moment
 * (a person listened to it). None of them is inferred from another.
 */

/** YouTube video IDs are exactly 11 URL-safe base64 characters. */
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Qloo entity IDs as returned for artists (uppercase UUID). */
export const QLOO_ENTITY_ID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
/** Reviewed metadata is treated as stale after this, and the mapping falls back to NEEDS_REVIEW. */
export const MAPPING_MAX_AGE_DAYS = 30;

/** Why a channel is accepted as speaking for the artist. */
export type ChannelKind =
  | "topic" // YouTube's auto-generated "<Artist> - Topic" channel (label-delivered art tracks)
  | "vevo" // the artist's VEVO channel
  | "label" // a named record label's own channel
  | "artist_self_described" // the channel calls itself the artist's; not independently established
  | "credited_upload"; // S9.17: a label or other upload whose title/description credits the artist by full name

export type ReviewedVideo = {
  videoId: string;
  /** Exactly as reported by YouTube (oEmbed and the IFrame player) at `verifiedAt`. */
  title: string;
  channelTitle: string;
  channelUrl: string;
  channelKind: ChannelKind;
  /** ISO date of the last identity check. */
  verifiedAt: string;
  /** What was checked: oEmbed 200 (exists, embeddable), and/or the player reached PLAYING with this title/channel. */
  evidence: Array<"oembed_200" | "iframe_playing">;
  /** Seconds, as reported by the IFrame player during the audit; absent if not observed. */
  durationSeconds?: number;
};

export type MomentStatus = "PENDING_REVIEW" | "APPROVED";

/** A timestamp-bounded excerpt. Only APPROVED moments are offered to listeners. */
export type FeaturedMomentEntry = {
  videoId: string;
  startSeconds: number;
  endSeconds: number;
  status: MomentStatus;
  provenance: "human_curated";
  /** Who approved it and when; required for APPROVED. */
  reviewedBy?: string;
  reviewedAt?: string;
  /** Neutral note for the reviewer. Never a claim about the music unless a person wrote it after listening. */
  note: string;
};

export type ReviewedMapping = {
  qlooArtistId: string;
  /** The Qloo artist name, as returned by Qloo. */
  artistName: string;
  /** RESOLVED mappings may play; NEEDS_REVIEW mappings never do. */
  review: "RESOLVED" | "NEEDS_REVIEW";
  reviewReason?: string;
  primary: ReviewedVideo;
  alternates: ReviewedVideo[];
  moments: FeaturedMomentEntry[];
};

export function isVideoId(value: unknown): value is string {
  return typeof value === "string" && YOUTUBE_VIDEO_ID.test(value);
}

/** The only external URLs the music layer ever produces. */
export function watchUrl(videoId: string): string {
  if (!isVideoId(videoId)) throw new Error("invalid YouTube video id");
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function searchUrl(artistName: string): string {
  return `https://www.youtube.com/results?${new URLSearchParams({ search_query: artistName.slice(0, 120) })}`;
}

/** 0 ≤ start < end ≤ duration (when known). */
export function momentWithinBounds(m: Pick<FeaturedMomentEntry, "startSeconds" | "endSeconds">, durationSeconds?: number): boolean {
  const { startSeconds: s, endSeconds: e } = m;
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s) return false;
  return durationSeconds === undefined || e <= durationSeconds;
}
