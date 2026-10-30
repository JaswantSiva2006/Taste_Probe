import { z } from "zod";
import type { ListeningState, RecommendationCandidate } from "@/lib/contracts";
import { seenVideoIds, trackReactions } from "./listening";

export const SupplyStateSchema = z.object({
  version: z.literal(1),
  resolutions: z.array(z.object({ artistId: z.string(), status: z.string(), reason: z.string().nullable(), lookup: z.string(), checkedAt: z.number(), retryAt: z.number(), options: z.number().int().nonnegative() })).max(90),
  decision: z.enum(["KEEP_SUPPLY", "LOCAL_RESOLVE", "LOCAL_REPLACE", "FETCH_ARTISTS", "EXPAND_VERIFIED_VIDEO_OPTIONS", "DEGRADED_KEEP", "EXHAUSTED"]),
  reasons: z.array(z.string()).max(20),
  funnel: z.object({ reservoir: z.number(), eligibleArtists: z.number(), playableArtists: z.number(), verifiedVideos: z.number(), unseenVideos: z.number(), unseenArtists: z.number(), exhaustedArtists: z.number(), targetRunway: z.number() }),
  exclusions: z.array(z.object({ artistId: z.string(), reasons: z.array(z.string()) })).max(90),
  selectedArtistId: z.string().nullable(), selectedVideoId: z.string().nullable(),
});
export type SupplyState = z.infer<typeof SupplyStateSchema>;

/** Separate catalog size, current playability, and unseen runway. No provider calls. */
export function supplySnapshot(candidates: RecommendationCandidate[], l: ListeningState, at: number, excludedIds: string[] = []): SupplyState {
  const seen = seenVideoIds(l), reactions = trackReactions(l);
  const rejected = new Set([...excludedIds, ...l.artistFeedback.filter((f) => f.action === "not_this_artist").map((f) => f.artistId)]);
  const eligible = candidates.filter((c) => c.entityType === "music_artist" && !rejected.has(c.entityId));
  const ids = new Set(eligible.map((c) => c.entityId));
  const inventory = [...new Map([...(l.inventory ?? []), ...l.options].filter((o) => ids.has(o.artistId)).map((o) => [o.videoId, o])).values()];
  const unseen = inventory.filter((o) => !seen.has(o.videoId) && reactions.get(o.videoId) !== "not_for_me");
  const playable = new Set(inventory.map((o) => o.artistId)), unseenArtists = new Set(unseen.map((o) => o.artistId));
  const resolutions = (l.supply?.resolutions ?? []).filter((r) => candidates.some((c) => c.entityId === r.artistId));
  return {
    version: 1, resolutions, decision: unseen.length ? "KEEP_SUPPLY" : "EXHAUSTED", reasons: [unseen.length ? "LOCAL_VERIFIED_ALTERNATIVE" : "NO_PLAYABLE_CANDIDATES"],
    funnel: { reservoir: candidates.length, eligibleArtists: eligible.length, playableArtists: playable.size, verifiedVideos: inventory.length, unseenVideos: unseen.length, unseenArtists: unseenArtists.size, exhaustedArtists: [...playable].filter((id) => !unseenArtists.has(id)).length, targetRunway: Math.min(6, Math.max(2, Math.ceil(Math.sqrt(eligible.length)))) },
    exclusions: candidates.slice(0, 90).map((c) => {
      const resolution = resolutions.find((r) => r.artistId === c.entityId);
      const reasons = c.entityType !== "music_artist" ? ["WRONG_ENTITY_TYPE"] : rejected.has(c.entityId) ? ["EXPLICIT_ARTIST_REJECT"] : playable.has(c.entityId) ? unseenArtists.has(c.entityId) ? [] : ["VIDEO_ALREADY_PRESENTED"] : resolution ? [resolution.status === "UNRESOLVED" ? "CACHE_MISS" : resolution.status === "DEFERRED" ? "BATCH_DEFERRED" : resolution.lookup === "CACHED" ? "NEGATIVE_CACHE" : resolution.status === "RATE_LIMITED" ? "QUOTA_EXHAUSTED" : resolution.status === "UPSTREAM_FAILURE" ? "TEMPORARY_RESOLUTION_FAILURE" : "NO_VERIFIED_RECORDING", resolution.reason ?? resolution.status, ...(resolution.retryAt > at ? ["RETRY_NOT_DUE"] : [])] : ["NOT_YET_RESOLVED"];
      return { artistId: c.entityId, reasons };
    }), selectedArtistId: l.currentArtistId, selectedVideoId: l.currentVideoId,
  };
}

/** Adequacy is a decision, not permission to spend. A strong local choice always wins the fast path. */
export function supplyPolicy(input: { snapshot: SupplyState; bestScore: number | null; unresolved: number; canLookup: boolean; canFetch: boolean }): Pick<SupplyState, "decision" | "reasons"> {
  const { snapshot: s } = input;
  const artistTarget = Math.min(s.funnel.targetRunway, Math.max(1, Math.ceil(Math.log2(s.funnel.eligibleArtists + 1))));
  const adequate = s.funnel.unseenVideos >= s.funnel.targetRunway && s.funnel.unseenArtists >= artistTarget;
  if (adequate || (s.funnel.unseenVideos > 0 && (input.bestScore ?? 0) >= 0.35)) return { decision: "KEEP_SUPPLY", reasons: ["LOCAL_VERIFIED_ALTERNATIVE"] };
  if (input.unresolved && input.canLookup) return { decision: "LOCAL_RESOLVE", reasons: ["RUNWAY_LOW_UNRESOLVED_ARTISTS"] };
  if (input.canFetch) return { decision: "FETCH_ARTISTS", reasons: ["PLAYABLE_RUNWAY_LOW"] };
  if (s.funnel.unseenVideos) return { decision: "DEGRADED_KEEP", reasons: ["FINITE_SUPPLY_LOCAL_CHOICE"] };
  return { decision: "EXHAUSTED", reasons: ["NO_PLAYABLE_CANDIDATES"] };
}
