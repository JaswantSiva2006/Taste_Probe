import type { RateLimitStore } from "@/lib/reliability/rate-limit";
import { isVideoId, watchUrl } from "./types";
import type { ResolvedVideo } from "@/lib/contracts";

/**
 * S9.9 Tier B: optional YouTube Data API v3 lookup. Constructed only when a dedicated
 * YOUTUBE_API_KEY is configured; otherwise the resolver never calls it and it costs nothing.
 *
 * Quota (Google, Oct 2026): search.list = 1 unit in its own "Search Queries" bucket
 * (default 100 calls/day); videos.list = 1 unit from the general 10,000 units/day.
 * Our own caps are lower: YOUTUBE_DAILY_SEARCH_MAX (default 40) per deployment and
 * YOUTUBE_SEARCHES_PER_EXPLORATION (default 2). Every attempt is counted before it is
 * made, failures included, and nothing is retried.
 *
 * Identity rule: a result is accepted only from the artist's auto-generated
 * "<Artist> - Topic" channel (label-delivered metadata), from exactly one such channel,
 * embeddable and public. Anything else is NEEDS_REVIEW, never a guess.
 */

export type DynamicOutcome =
  | { kind: "resolved"; video: ResolvedVideo; cached?: boolean }
  | { kind: "ambiguous"; reason: string; cached?: boolean }
  | { kind: "none"; cached?: boolean }
  | { kind: "quota" }
  | { kind: "failed"; reason: string };

/** The verified Qloo artist being looked up (the name is the search text; the ID keys caches). */
export type LookupArtist = { entityId: string; name: string };

export interface DynamicLookup {
  lookup(artist: LookupArtist, explorationId: string): Promise<DynamicOutcome>;
}

const API = "https://www.googleapis.com/youtube/v3";
const DAY_MS = 86_400_000;

export const normalizeName = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/** ISO-8601 duration (PT#H#M#S) → seconds. */
export function parseIsoDuration(value: string | undefined): number | undefined {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? "");
  if (!m) return undefined;
  const s = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return s > 0 ? s : undefined;
}

export type QuotaGuard = { take(explorationId: string): Promise<boolean> };

/** Counts attempts in the shared limiter store (Redis in production, so the cap holds across instances). */
export function createQuotaGuard(store: RateLimitStore, limits: { dailySearchMax: number; searchesPerExploration: number; explorationWindowMs: number }, now = () => Date.now()): QuotaGuard {
  return {
    async take(explorationId) {
      if (limits.dailySearchMax <= 0 || limits.searchesPerExploration <= 0) return false;
      const at = now();
      const day = new Date(at).toISOString().slice(0, 10);
      const perExploration = await store.increment(`tp:yt:search:exp:${explorationId}`, limits.explorationWindowMs, at);
      if (perExploration.count > limits.searchesPerExploration) return false;
      const daily = await store.increment(`tp:yt:search:day:${day}`, DAY_MS, at);
      return daily.count <= limits.dailySearchMax;
    },
  };
}

type SearchItem = { id?: { videoId?: string }; snippet?: { channelId?: string; channelTitle?: string } };
type VideoItem = {
  id?: string;
  snippet?: { title?: string; channelId?: string; channelTitle?: string };
  contentDetails?: { duration?: string };
  status?: { embeddable?: boolean; privacyStatus?: string; uploadStatus?: string };
};

export function createYouTubeDataLookup(opts: { apiKey: string; timeoutMs: number; quota: QuotaGuard; fetcher?: typeof fetch; now?: () => Date }): DynamicLookup {
  const fetcher = opts.fetcher ?? fetch;
  const get = async <T>(path: string, params: Record<string, string>): Promise<T> => {
    // The key travels in a header, never in a URL that could be logged.
    const res = await fetcher(`${API}/${path}?${new URLSearchParams(params)}`, {
      headers: { "x-goog-api-key": opts.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs),
      cache: "no-store",
    });
    if (res.status === 403 || res.status === 429) throw Object.assign(new Error("quota"), { quota: true });
    if (!res.ok) throw new Error(`youtube_http_${res.status}`);
    return (await res.json()) as T;
  };

  return {
    async lookup({ name: artistName }, explorationId) {
      if (!(await opts.quota.take(explorationId))) return { kind: "quota" };
      try {
        const search = await get<{ items?: SearchItem[] }>("search", {
          part: "snippet",
          type: "video",
          videoEmbeddable: "true",
          videoCategoryId: "10",
          maxResults: "5",
          q: artistName,
        });
        const topic = `${normalizeName(artistName)} - topic`;
        const items = (search.items ?? []).filter((i) => isVideoId(i.id?.videoId));
        const matching = items.filter((i) => normalizeName(i.snippet?.channelTitle ?? "") === topic);
        if (!matching.length) return items.length ? { kind: "ambiguous", reason: "no_topic_channel_match" } : { kind: "none" };
        if (new Set(matching.map((i) => i.snippet?.channelId)).size > 1) return { kind: "ambiguous", reason: "multiple_topic_channels" };

        const videos = await get<{ items?: VideoItem[] }>("videos", {
          part: "snippet,contentDetails,status",
          id: matching.map((i) => i.id!.videoId!).join(","),
        });
        const ok = (videos.items ?? []).find(
          (x) =>
            isVideoId(x.id) &&
            x.status?.embeddable === true &&
            x.status.privacyStatus === "public" &&
            normalizeName(x.snippet?.channelTitle ?? "") === topic &&
            (x.snippet?.title ?? "").trim().length > 0,
        );
        if (!ok) return { kind: "ambiguous", reason: "no_embeddable_public_match" };
        const durationSeconds = parseIsoDuration(ok.contentDetails?.duration);
        return {
          kind: "resolved",
          video: {
            videoId: ok.id!,
            title: ok.snippet!.title!.slice(0, 300),
            channelTitle: ok.snippet!.channelTitle!.slice(0, 200),
            watchUrl: watchUrl(ok.id!),
            provenance: "youtube_data_api",
            channelKind: "topic",
            verifiedAt: (opts.now?.() ?? new Date()).toISOString(),
            ...(durationSeconds ? { durationSeconds } : {}),
          },
        };
      } catch (error) {
        if ((error as { quota?: boolean }).quota) return { kind: "quota" };
        return { kind: "failed", reason: (error as Error).name === "TimeoutError" ? "youtube_timeout" : "youtube_error" };
      }
    },
  };
}
