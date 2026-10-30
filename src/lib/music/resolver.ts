import type { FeaturedMoment, MusicResolution, ResolvedVideo } from "@/lib/contracts";
import { reviewedMappingFor } from "./mappings";
import { MAPPING_MAX_AGE_DAYS, isVideoId, momentWithinBounds, searchUrl, watchUrl, type ReviewedMapping, type ReviewedVideo } from "./types";
import { normalizeName, type DynamicLookup } from "./youtube-data";

/**
 * S9.9 resolver. Tier A (reviewed registry) → Tier B (optional Data API, only with a
 * dedicated key) → Tier C (honest fallback). The Qloo artist is an input and is
 * returned unchanged in every outcome: a failed video never replaces the artist.
 */

export type ResolveArtist = { entityId: string; name: string; provenance: "qloo" | "mock" };
export type ResolveOptions = {
  explorationId: string;
  now: Date;
  /** Non-production review mode: expose PENDING_REVIEW moments, labelled as such. */
  momentReview: boolean;
  /** Absent when no YouTube Data API key is configured. */
  dynamic?: DynamicLookup;
  registry?: (artistId: string) => ReviewedMapping | undefined;
  /** S9.18: names around this artist in its Qloo context, for identity corroboration. */
  context?: string[];
};

const DAY_MS = 86_400_000;

function fresh(video: ReviewedVideo, now: Date): boolean {
  const at = Date.parse(video.verifiedAt);
  return Number.isFinite(at) && now.getTime() - at <= MAPPING_MAX_AGE_DAYS * DAY_MS && at <= now.getTime() + DAY_MS;
}

function toResolved(video: ReviewedVideo): ResolvedVideo {
  return {
    videoId: video.videoId,
    title: video.title,
    channelTitle: video.channelTitle,
    watchUrl: watchUrl(video.videoId),
    provenance: "reviewed_mapping",
    channelKind: video.channelKind,
    verifiedAt: video.verifiedAt,
    ...(video.durationSeconds ? { durationSeconds: video.durationSeconds } : {}),
  };
}

/** Only an APPROVED moment with a reviewer and valid bounds is offered; PENDING_REVIEW only in review mode. */
export function selectMoment(mapping: ReviewedMapping, video: ReviewedVideo, momentReview: boolean): FeaturedMoment | null {
  const valid = mapping.moments.filter((m) => m.videoId === video.videoId && momentWithinBounds(m, video.durationSeconds));
  const approved = valid.find((m) => m.status === "APPROVED" && m.reviewedBy && m.reviewedAt);
  const chosen = approved ?? (momentReview ? valid.find((m) => m.status === "PENDING_REVIEW") : undefined);
  if (!chosen) return null;
  return {
    videoId: chosen.videoId,
    startSeconds: chosen.startSeconds,
    endSeconds: chosen.endSeconds,
    status: chosen.status,
    provenance: "human_curated",
    ...(chosen.status === "APPROVED" && chosen.reviewedAt ? { reviewedAt: chosen.reviewedAt } : {}),
  };
}

export async function resolveArtistVideo(artist: ResolveArtist, opts: ResolveOptions): Promise<MusicResolution> {
  const base = {
    provider: "youtube" as const,
    artist: { entityId: artist.entityId, name: artist.name, provenance: artist.provenance },
    alternates: [] as ResolvedVideo[],
    featuredMoment: null,
    fallback: { label: `Search for ${artist.name} on YouTube`, url: searchUrl(artist.name) },
    checkedAt: opts.now.toISOString(),
  };
  const outcome = (status: MusicResolution["status"], reason: string | null, dynamicLookup: MusicResolution["dynamicLookup"]): MusicResolution => ({
    ...base,
    status,
    video: null,
    reason,
    dynamicLookup,
  });

  const mapping = artist.provenance === "qloo" ? (opts.registry ?? reviewedMappingFor)(artist.entityId) : undefined;
  if (mapping) {
    // Same Qloo ID but a different Qloo name means the registry or upstream changed: do not play.
    if (normalizeName(mapping.artistName) !== normalizeName(artist.name)) return outcome("NEEDS_REVIEW", "artist_name_mismatch", "NOT_NEEDED");
    if (mapping.review !== "RESOLVED") return outcome("NEEDS_REVIEW", mapping.reviewReason ?? "mapping_not_reviewed", "NOT_NEEDED");
    if (!isVideoId(mapping.primary.videoId)) return outcome("NEEDS_REVIEW", "invalid_video_id", "NOT_NEEDED");
    if (!fresh(mapping.primary, opts.now)) return outcome("NEEDS_REVIEW", "mapping_stale", "NOT_NEEDED");
    return {
      ...base,
      status: "RESOLVED",
      video: toResolved(mapping.primary),
      alternates: mapping.alternates.filter((a) => isVideoId(a.videoId) && a.videoId !== mapping.primary.videoId && fresh(a, opts.now)).map(toResolved),
      featuredMoment: selectMoment(mapping, mapping.primary, opts.momentReview),
      reason: null,
      dynamicLookup: "NOT_NEEDED",
    };
  }

  if (artist.provenance !== "qloo") return outcome("UNAVAILABLE", "synthetic_artist", opts.dynamic ? "NOT_NEEDED" : "DISABLED_NO_KEY");
  if (!opts.dynamic) return outcome("UNAVAILABLE", "no_reviewed_mapping", "DISABLED_NO_KEY");

  const found = await opts.dynamic.lookup({ entityId: artist.entityId, name: artist.name }, opts.explorationId, opts.context?.length ? { context: opts.context } : undefined);
  const how = "cached" in found && found.cached ? "CACHED" : "USED";
  switch (found.kind) {
    case "resolved":
      return { ...base, status: "RESOLVED", video: found.video, alternates: found.alternates ?? [], reason: null, dynamicLookup: how };
    case "ambiguous":
      return outcome("NEEDS_REVIEW", found.reason, how);
    case "none":
      return outcome("UNAVAILABLE", "no_match", how);
    case "quota":
      return outcome("RATE_LIMITED", "youtube_quota_exhausted", "QUOTA_EXHAUSTED");
    case "failed":
      return outcome("UPSTREAM_FAILURE", found.reason, "FAILED");
  }
}
