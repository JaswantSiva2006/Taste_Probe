import "server-only";
import type { MusicResolution, MusicResolveRequest } from "@/lib/contracts";
import { loadAuthorizedArtist, type DiscoveryDeps } from "@/lib/discovery/service";
import { rateLimitStoreFor } from "@/lib/reliability/rate-limit";
import { logEvent } from "@/lib/telemetry/logger";
import { cachedLookup, lookupCacheFor } from "./cache";
import { resolveArtistVideo } from "./resolver";
import { createQuotaGuard, createYouTubeDataLookup, type DynamicLookup, type DynamicOutcome } from "./youtube-data";

/**
 * S9.9 composition for POST /api/music/resolve: authorize the artist against the
 * signed exploration, then resolve. The client only names a Qloo artist ID; the
 * video always comes from the server.
 */

export type MusicDeps = { dynamic?: DynamicLookup; now?: () => Date };

// Concurrent requests for the same artist share one Data API lookup (per instance).
const INFLIGHT = new Map<string, Promise<DynamicOutcome>>();
export function deduplicated(lookup: DynamicLookup): DynamicLookup {
  return {
    ...(lookup.lookupBatch ? { lookupBatch: lookup.lookupBatch.bind(lookup) } : {}),
    lookup(artist, explorationId, options) {
      const key = `${explorationId}:${artist.entityId}:${options?.fresh ? "fresh" : "any"}`;
      const running = INFLIGHT.get(key);
      if (running) return running;
      const p = lookup.lookup(artist, explorationId, options).finally(() => INFLIGHT.delete(key));
      INFLIGHT.set(key, p);
      return p;
    },
  };
}

export function defaultDynamicLookup(deps: DiscoveryDeps): DynamicLookup | undefined {
  const { music, session } = deps.config;
  if (!music.youtubeApiKey) return undefined; // no key: Tier B disabled, zero cost
  // Order: per-artist cache (free, stable video) → in-flight dedup → quota guard → Data API.
  return cachedLookup(
    deduplicated(
      createYouTubeDataLookup({
        apiKey: music.youtubeApiKey,
        timeoutMs: music.timeoutMs,
        quota: createQuotaGuard(rateLimitStoreFor(deps.config), {
          dailySearchMax: music.dailySearchMax,
          searchesPerExploration: music.searchesPerExploration,
          explorationWindowMs: session.ttlSeconds * 1_000,
        }),
      }),
    ),
    lookupCacheFor(deps.config),
  );
}

export async function resolveMusic(deps: DiscoveryDeps, input: MusicResolveRequest, music: MusicDeps = {}): Promise<MusicResolution> {
  const { explorationId, candidate } = await loadAuthorizedArtist(deps, input.sessionToken, input.artistId);
  const result = await resolveArtistVideo(
    { entityId: candidate.entityId, name: candidate.name, provenance: candidate.evidence.source },
    {
      explorationId,
      now: music.now?.() ?? new Date(deps.now?.() ?? Date.now()),
      momentReview: deps.config.music.momentReview,
      dynamic: "dynamic" in music ? music.dynamic : defaultDynamicLookup(deps),
    },
  );
  logEvent("info", "music.resolve", {
    requestId: deps.requestId,
    status: result.status,
    reason: result.reason,
    dynamicLookup: result.dynamicLookup,
    provenance: result.video?.provenance ?? null,
    alternates: result.alternates.length,
  });
  return result;
}
