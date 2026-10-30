import { z } from "zod";

/**
 * S9.12 listening loop contracts. Two layers stay separate:
 * - artist identities come from Qloo (the exploration's verified candidates);
 * - recordings come from the S9.9 verified YouTube resolver (reviewed mappings, or a
 *   validated Topic/VEVO Data API result). Neither the client nor Gemini can add one.
 * Track feedback (a recording) and artist feedback (an explicit artist decision) are
 * different records and never inferred from each other.
 */

export const LISTENING_ACTIONS = ["LOVE", "NOT_FOR_ME", "NEXT", "ANOTHER_SONG", "DIFFERENT_ARTIST", "SAVE", "FINISH"] as const;
export const ListeningActionSchema = z.enum(LISTENING_ACTIONS);
export type ListeningAction = z.infer<typeof ListeningActionSchema>;

/** Explicit artist-level intent; only ever set by the user, never derived from a track reaction. */
export const ArtistIntentSchema = z.enum(["LIKE_ARTIST", "NOT_THIS_ARTIST"]);
export type ArtistIntent = z.infer<typeof ArtistIntentSchema>;

const VideoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const EntityId = z.string().min(1).max(200);
const Token = z.string().min(1).max(4096);

/** S9.13: `videoId` (with `artistId`) replays a recording already heard in this exploration ("Previous"). */
export const ListenRequestSchema = z
  .object({ sessionToken: Token, artistId: EntityId.optional(), videoId: VideoId.optional() })
  .strict()
  .refine((r) => !r.videoId || r.artistId, { message: "videoId requires artistId" });
export type ListenRequest = z.infer<typeof ListenRequestSchema>;

export const ListeningFeedbackRequestSchema = z
  .object({ sessionToken: Token, artistId: EntityId, videoId: VideoId, action: ListeningActionSchema, artistIntent: ArtistIntentSchema.optional() })
  .strict()
  .refine((r) => !r.artistIntent || (r.artistIntent === "LIKE_ARTIST" ? r.action === "LOVE" : r.action === "NOT_FOR_ME" || r.action === "DIFFERENT_ARTIST"), {
    message: "artistIntent LIKE_ARTIST goes with LOVE; NOT_THIS_ARTIST goes with NOT_FOR_ME or DIFFERENT_ARTIST",
  });
export type ListeningFeedbackRequest = z.infer<typeof ListeningFeedbackRequestSchema>;

/** One verified, playable recording for one authorized Qloo artist. Server-issued only. */
export const VerifiedSongOptionSchema = z.object({
  artistId: EntityId,
  videoId: VideoId,
  title: z.string().min(1).max(300),
  channelTitle: z.string().min(1).max(200),
  channelKind: z.enum(["topic", "vevo", "label", "artist_self_described"]),
  provenance: z.enum(["reviewed_mapping", "youtube_data_api"]),
  watchUrl: z.string().startsWith("https://www.youtube.com/watch?v="),
  verifiedAt: z.string(),
  durationSeconds: z.number().positive().optional(),
});
export type VerifiedSongOption = z.infer<typeof VerifiedSongOptionSchema>;

export const SongSelectionSchema = z.object({
  /** GEMINI: the model chose among verified IDs and the server validated it. */
  mode: z.enum(["GEMINI", "DETERMINISTIC", "SINGLE_OPTION", "USER_REPLAY"]),
  reasonCode: z.string().max(64),
  fallbackReason: z.string().max(64).nullable(),
  eligibleCount: z.number().int().nonnegative(),
});
export type SongSelection = z.infer<typeof SongSelectionSchema>;

/** Canonical saved recording for browser-local Passport persistence (S9.13). */
export const SavedDiscoverySchema = z.object({
  v: z.literal(1),
  savedAt: z.string(),
  artist: z.object({ qlooId: EntityId, name: z.string().min(1).max(300), provenance: z.enum(["qloo", "mock"]) }),
  video: z.object({ videoId: VideoId, title: z.string(), channelTitle: z.string(), watchUrl: z.string().startsWith("https://www.youtube.com/watch?v="), provenance: z.enum(["reviewed_mapping", "youtube_data_api"]) }),
  anchor: z.object({ qlooId: EntityId, name: z.string(), domain: z.string() }),
});
export type SavedDiscovery = z.infer<typeof SavedDiscoverySchema>;

const at = z.number().int();
const rev = z.number().int().nonnegative();

/** Authoritative listening state, stored in the exploration's session record (never in the token). */
export const ListeningStateSchema = z.object({
  version: z.literal(1),
  status: z.enum(["listening", "finished"]),
  currentArtistId: EntityId.nullable(),
  currentVideoId: VideoId.nullable(),
  /** Verified options for the current artist only (bounded). */
  options: z.array(VerifiedSongOptionSchema).max(6),
  selection: SongSelectionSchema.nullable(),
  notice: z.string().max(64).nullable(),
  visitedArtistIds: z.array(EntityId).max(100),
  unavailableArtistIds: z.array(EntityId).max(100),
  encounters: z.array(z.object({ artistId: EntityId, artistName: z.string(), videoId: VideoId, title: z.string(), at, revision: rev, selection: z.enum(["GEMINI", "DETERMINISTIC", "SINGLE_OPTION", "USER_REPLAY"]) })).max(100),
  trackFeedback: z.array(z.object({ artistId: EntityId, videoId: VideoId, action: z.enum(["love", "not_for_me"]), at, revision: rev })).max(100),
  artistFeedback: z.array(z.object({ artistId: EntityId, action: z.enum(["like_artist", "not_this_artist"]), at, revision: rev })).max(100),
  navigation: z.array(z.object({ action: z.enum(["NEXT", "ANOTHER_SONG", "DIFFERENT_ARTIST", "START", "PREVIOUS"]), artistId: EntityId.nullable(), videoId: VideoId.nullable(), at, revision: rev })).max(200),
  saved: z.array(SavedDiscoverySchema).max(50),
  geminiSongRequests: z.number().int().nonnegative(),
});
export type ListeningState = z.infer<typeof ListeningStateSchema>;

/** What the client sees (a projection of ListeningState). */
export const ListeningViewSchema = z.object({
  status: z.enum(["listening", "finished", "no_verified_song"]),
  artist: z.object({ entityId: EntityId, name: z.string() }).nullable(),
  video: VerifiedSongOptionSchema.nullable(),
  /** Other verified recordings of this artist the user has not heard or disliked (player failover). */
  alternates: z.array(VerifiedSongOptionSchema),
  /** How many verified recordings exist for this artist. A single one is said plainly. */
  verifiedSongCount: z.number().int().nonnegative(),
  selection: SongSelectionSchema.nullable(),
  notice: z.string().nullable(),
  currentFeedback: z.enum(["love", "not_for_me"]).nullable(),
  artistsVisited: z.number().int().nonnegative(),
  history: z.array(z.object({ artistId: EntityId, artistName: z.string(), videoId: VideoId, title: z.string(), feedback: z.enum(["love", "not_for_me"]).nullable() })),
  saved: z.array(SavedDiscoverySchema),
  geminiSongRequests: z.number().int().nonnegative(),
});
export type ListeningView = z.infer<typeof ListeningViewSchema>;
