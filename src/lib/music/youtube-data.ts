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
 * Identity rule: a result is accepted only from the artist's auto-generated Topic
 * channel or an exact-name VEVO channel. VEVO also requires the video's own title to
 * corroborate the artist. Anything ambiguous is NEEDS_REVIEW, never a guess.
 */

export type DynamicOutcome =
  | { kind: "resolved"; video: ResolvedVideo; alternates?: ResolvedVideo[]; cached?: boolean }
  | { kind: "ambiguous"; reason: string; cached?: boolean }
  | { kind: "none"; cached?: boolean }
  | { kind: "quota" }
  | { kind: "failed"; reason: string };

/** The verified Qloo artist being looked up (the name is the search text; the ID keys caches). */
export type LookupArtist = { entityId: string; name: string };

export interface DynamicLookup {
  lookup(artist: LookupArtist, explorationId: string): Promise<DynamicOutcome>;
  /** Cache-only inspection. Never crosses the network lookup/quota boundary. */
  peek?(artist: LookupArtist): Promise<DynamicOutcome | null>;
  /** One OR query, exact channel verification against each authorized Qloo identity. Null is deferred, never negative evidence. */
  lookupBatch?(artists: LookupArtist[], explorationId: string): Promise<Record<string, DynamicOutcome | null>>;
}

const API = "https://www.googleapis.com/youtube/v3";
const DAY_MS = 86_400_000;

/** Canonical comparison only; the original spelling is always retained for display. */
export const normalizeName = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

type VerifiedChannel = { kind: "topic" | "vevo"; canonical: string };

function verifiedChannel(channelTitle: string, artistName: string): VerifiedChannel | null {
  const channel = normalizeName(channelTitle).replace(/\s/g, "");
  const artist = normalizeName(artistName).replace(/\s/g, "");
  if (!artist) return null;
  if (channel === `${artist}topic`) return { kind: "topic", canonical: channel };
  if (channel === `${artist}vevo`) return { kind: "vevo", canonical: channel };
  return null;
}

const IMPERSONATION = /\b(cover|tribute|karaoke|reaction|parody|impersonat(?:e|ion)|fan made)\b/i;

/** VEVO identity is only sufficient when the video metadata independently names the artist. */
function corroboratesVevoTitle(title: string, artistName: string): boolean {
  if (IMPERSONATION.test(title)) return false;
  const titleName = normalizeName(title);
  const artist = normalizeName(artistName);
  return titleName === artist || titleName.startsWith(`${artist} `);
}

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
    async lookupBatch(artists, explorationId) {
      const bounded = [...new Map(artists.map((a) => [a.entityId, a])).values()].slice(0, 6);
      const outcomes: Record<string, DynamicOutcome | null> = Object.fromEntries(bounded.map((a) => [a.entityId, null]));
      try {
        if (!(await opts.quota.take(explorationId))) return Object.fromEntries(bounded.map((a) => [a.entityId, { kind: "quota" as const }]));
        const search = await get<{ items?: SearchItem[] }>("search", { part: "snippet", type: "video", videoEmbeddable: "true", videoCategoryId: "10", maxResults: "30", q: bounded.map((a) => `"${a.name.replace(/[|"\\]/g, " ").slice(0, 200)}"`).join("|") });
        const items = (search.items ?? []).filter((i) => isVideoId(i.id?.videoId));
        const matchingIds = [...new Set(items.filter((item) => bounded.filter((a) => verifiedChannel(item.snippet?.channelTitle ?? "", a.name)).length === 1).map((i) => i.id!.videoId!))];
        if (!matchingIds.length) return outcomes;
        const videos = await get<{ items?: VideoItem[] }>("videos", { part: "snippet,contentDetails,status", id: matchingIds.join(",") });
        for (const artist of bounded) {
          // Same normalized name for different Qloo IDs is ambiguous, never assigned to both.
          if (bounded.filter((a) => normalizeName(a.name) === normalizeName(artist.name)).length !== 1) { outcomes[artist.entityId] = { kind: "ambiguous", reason: "duplicate_artist_name" }; continue; }
          const matching = items.filter((i) => verifiedChannel(i.snippet?.channelTitle ?? "", artist.name));
          if (!matching.length) continue;
          if (new Set(matching.map((i) => i.snippet?.channelId)).size !== 1) { outcomes[artist.entityId] = { kind: "ambiguous", reason: "multiple_verified_channels" }; continue; }
          const accepted: ResolvedVideo[] = [];
          for (const video of videos.items ?? []) {
            const channel = verifiedChannel(video.snippet?.channelTitle ?? "", artist.name), title = video.snippet?.title?.trim() ?? "";
            if (!channel || !isVideoId(video.id) || !title || video.status?.embeddable !== true || video.status.privacyStatus !== "public") continue;
            if (!matching.some((item) => item.id?.videoId === video.id && item.snippet?.channelId && item.snippet.channelId === video.snippet?.channelId)) continue;
            if (channel.kind === "vevo" && !corroboratesVevoTitle(title, artist.name)) continue;
            const durationSeconds = parseIsoDuration(video.contentDetails?.duration);
            accepted.push({ videoId: video.id, title: title.slice(0, 300), channelTitle: video.snippet!.channelTitle!.slice(0, 200), channelKind: channel.kind, provenance: "youtube_data_api", watchUrl: watchUrl(video.id), verifiedAt: (opts.now?.() ?? new Date()).toISOString(), ...(durationSeconds ? { durationSeconds } : {}) });
          }
          if (accepted.length) outcomes[artist.entityId] = { kind: "resolved", video: accepted[0]!, alternates: accepted.slice(1, 6) };
        }
        return outcomes;
      } catch (error) {
        return Object.fromEntries(bounded.map((a) => [a.entityId, (error as { quota?: boolean }).quota ? { kind: "quota" as const } : { kind: "failed" as const, reason: "youtube_batch_failed" }]));
      }
    },
    async lookup({ name: artistName }, explorationId) {
      try {
        // The shared Redis-backed quota decision is part of authorization. If it is
        // unavailable, fail closed before making any YouTube request.
        if (!(await opts.quota.take(explorationId))) return { kind: "quota" };
        const search = await get<{ items?: SearchItem[] }>("search", {
          part: "snippet",
          type: "video",
          videoEmbeddable: "true",
          videoCategoryId: "10",
          maxResults: "5",
          q: artistName,
        });
        const items = (search.items ?? []).filter((i) => isVideoId(i.id?.videoId));
        const matching = items.flatMap((item) => {
          const channel = verifiedChannel(item.snippet?.channelTitle ?? "", artistName);
          return channel ? [{ item, channel }] : [];
        });
        if (!matching.length) return items.length ? { kind: "ambiguous", reason: "no_topic_channel_match" } : { kind: "none" };
        if (new Set(matching.map(({ item }) => item.snippet?.channelId)).size > 1) {
          const onlyTopic = matching.every(({ channel }) => channel.kind === "topic");
          return { kind: "ambiguous", reason: onlyTopic ? "multiple_topic_channels" : "multiple_verified_channels" };
        }

        const videos = await get<{ items?: VideoItem[] }>("videos", {
          part: "snippet,contentDetails,status",
          id: matching.map(({ item }) => item.id!.videoId!).join(","),
        });
        const verified = (videos.items ?? []).flatMap((video) => {
          const channel = verifiedChannel(video.snippet?.channelTitle ?? "", artistName);
          const title = video.snippet?.title?.trim() ?? "";
          if (!isVideoId(video.id) || video.status?.embeddable !== true || video.status.privacyStatus !== "public" || !channel || !title) return [];
          if (!matching.some(({ item }) => item.id?.videoId === video.id && item.snippet?.channelId === video.snippet?.channelId)) return [];
          if (channel.kind === "vevo" && !corroboratesVevoTitle(title, artistName)) return [];
          return [{ video, channel }];
        });
        const ok = verified[0];
        if (!ok) return { kind: "ambiguous", reason: "no_embeddable_public_match" };
        const toVideo = (ok: (typeof verified)[number]): ResolvedVideo => {
          const durationSeconds = parseIsoDuration(ok.video.contentDetails?.duration);
          return {
            videoId: ok.video.id!,
            title: ok.video.snippet!.title!.slice(0, 300),
            channelTitle: ok.video.snippet!.channelTitle!.slice(0, 200),
            watchUrl: watchUrl(ok.video.id!),
            provenance: "youtube_data_api",
            channelKind: ok.channel.kind,
            verifiedAt: (opts.now?.() ?? new Date()).toISOString(),
            ...(durationSeconds ? { durationSeconds } : {}),
          };
        };
        return { kind: "resolved", video: toVideo(ok), alternates: verified.slice(1, 5).map(toVideo) };
      } catch (error) {
        if ((error as { quota?: boolean }).quota) return { kind: "quota" };
        return { kind: "failed", reason: (error as Error).name === "TimeoutError" ? "youtube_timeout" : "youtube_error" };
      }
    },
  };
}
