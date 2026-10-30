import { z } from "zod";

/** S9.9: artist → YouTube video resolution contract (POST /api/music/resolve). */

export const MusicResolveRequestSchema = z.object({
  sessionToken: z.string().min(1).max(4096),
  artistId: z.string().min(1).max(200),
});
export type MusicResolveRequest = z.infer<typeof MusicResolveRequestSchema>;

export const MUSIC_RESOLUTION_STATUSES = ["RESOLVED", "NEEDS_REVIEW", "UNAVAILABLE", "RATE_LIMITED", "UPSTREAM_FAILURE"] as const;
export type MusicResolutionStatus = (typeof MUSIC_RESOLUTION_STATUSES)[number];

const VideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const YouTubeUrl = (prefix: string) => z.string().refine((u) => u.startsWith(prefix), { message: "unexpected external URL" });

export const ResolvedVideoSchema = z.object({
  videoId: VideoIdSchema,
  title: z.string().min(1).max(300),
  channelTitle: z.string().min(1).max(200),
  watchUrl: YouTubeUrl("https://www.youtube.com/watch?v="),
  /** How the artist/video match was established. */
  provenance: z.enum(["reviewed_mapping", "youtube_data_api"]),
  channelKind: z.enum(["topic", "vevo", "label", "artist_self_described"]),
  verifiedAt: z.string(),
  durationSeconds: z.number().positive().optional(),
});
export type ResolvedVideo = z.infer<typeof ResolvedVideoSchema>;

export const FeaturedMomentSchema = z.object({
  videoId: VideoIdSchema,
  startSeconds: z.number().min(0),
  endSeconds: z.number().positive(),
  /** APPROVED only after a person listened; PENDING_REVIEW is exposed only in non-production review mode. */
  status: z.enum(["APPROVED", "PENDING_REVIEW"]),
  provenance: z.literal("human_curated"),
  reviewedAt: z.string().optional(),
});
export type FeaturedMoment = z.infer<typeof FeaturedMomentSchema>;

export const MusicResolutionSchema = z.object({
  status: z.enum(MUSIC_RESOLUTION_STATUSES),
  provider: z.literal("youtube"),
  /** The Qloo artist stays the recommendation whatever happens to the video. */
  artist: z.object({ entityId: z.string(), name: z.string(), provenance: z.enum(["qloo", "mock"]) }),
  video: ResolvedVideoSchema.nullable(),
  /** Reviewed alternates for the same artist, tried in order when the player fails. */
  alternates: z.array(ResolvedVideoSchema),
  featuredMoment: FeaturedMomentSchema.nullable(),
  fallback: z.object({ label: z.string(), url: YouTubeUrl("https://www.youtube.com/results?") }),
  reason: z.string().nullable(),
  /** CACHED: a recent Data API result for this artist was reused (no quota spent, same video). */
  dynamicLookup: z.enum(["DISABLED_NO_KEY", "NOT_NEEDED", "USED", "CACHED", "QUOTA_EXHAUSTED", "FAILED"]),
  checkedAt: z.string(),
});
export type MusicResolution = z.infer<typeof MusicResolutionSchema>;
