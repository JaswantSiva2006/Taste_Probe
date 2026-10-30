import type { RateLimitStore } from "@/lib/reliability/rate-limit";
import { isVideoId, watchUrl } from "./types";
import type { ResolvedVideo } from "@/lib/contracts";

/**
 * S9.9 Tier B: optional YouTube Data API v3 lookup. Constructed only when a dedicated
 * YOUTUBE_API_KEY is configured; otherwise the resolver never calls it and it costs nothing.
 *
 * Quota (Google, Oct 2026): search.list = 1 unit in its own "Search Queries" bucket
 * (default 100 calls/day); videos.list = 1 unit from the general 10,000 units/day.
 * Our own caps: YOUTUBE_DAILY_SEARCH_MAX per deployment and
 * YOUTUBE_SEARCHES_PER_EXPLORATION. Every attempt is counted before it is
 * made, failures included, and nothing is retried.
 *
 * S9.17 identity tiers (strongest first). A recording is attributed to a Qloo artist when:
 * 1. topic   — it comes from the artist's auto-generated "<Artist> - Topic" channel;
 * 2. vevo    — it comes from the exact-name VEVO channel and the title names the artist;
 * 3. artist_channel — the channel's name is the artist's own name ("ARRahman", "Anirudh Ravichander Official");
 * 4. credited_title — any channel (typically the record label: "Sony Music South",
 *    "Think Music India") whose upload title credits the artist by full name;
 * 5. credited_description — a label upload whose description carries an explicit
 *    credit line ("Music: Anirudh Ravichander", "Singer: …").
 * Tiers 3–5 additionally require: Music category (search filter), public and embeddable,
 * a song-like duration (60 s–15 min), and a title that is not a cover, karaoke, reaction,
 * slowed/8D edit, jukebox, status clip, trailer or similar. S9.16 accepted only tiers 1–2,
 * which excluded most film-music catalogues (published by labels, not Topic channels).
 */

export type DynamicOutcome =
  | { kind: "resolved"; video: ResolvedVideo; alternates?: ResolvedVideo[]; cached?: boolean }
  | { kind: "ambiguous"; reason: string; cached?: boolean }
  | { kind: "none"; cached?: boolean }
  | { kind: "quota" }
  | { kind: "failed"; reason: string };

/** The verified Qloo artist being looked up (the name is the search text; the ID keys caches). */
export type LookupArtist = { entityId: string; name: string };

/**
 * S9.18 identity context: names Qloo places around this artist (the starting point, other
 * reservoir artists). A recording that also credits one of them is corroborated.
 */
export type LookupOptions = { fresh?: boolean; context?: string[] };

export interface DynamicLookup {
  /** `fresh` skips a cached answer (a deliberate deeper search for an artist the user loves). */
  lookup(artist: LookupArtist, explorationId: string, options?: LookupOptions): Promise<DynamicOutcome>;
  /** Cache-only inspection. Never crosses the network lookup/quota boundary. */
  peek?(artist: LookupArtist): Promise<DynamicOutcome | null>;
  /**
   * One OR query for up to six artists. `harvest` names other authorized reservoir artists:
   * recordings in the same results that verifiably belong to them are kept too (positive only;
   * a harvest artist that is absent is simply omitted). Null is deferred, never negative evidence.
   */
  lookupBatch?(artists: LookupArtist[], explorationId: string, harvest?: LookupArtist[], context?: string[]): Promise<Record<string, DynamicOutcome | null>>;
}

const API = "https://www.googleapis.com/youtube/v3";
const DAY_MS = 86_400_000;
/** Recordings kept per artist per lookup (the inventory dedupes across lookups). */
const MAX_PER_ARTIST = 12;

/** Canonical comparison only; the original spelling is always retained for display. */
export const normalizeName = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Normalized, with runs of initials joined: "A.R. Rahman", "A R Rahman" and "AR Rahman" → "ar rahman". */
export const nameKey = (s: string) => {
  const out: string[] = [];
  let initials = "";
  for (const word of normalizeName(s).split(" ").filter(Boolean)) {
    if (word.length === 1) { initials += word; continue; }
    if (initials) {
      out.push(initials);
      initials = "";
    }
    out.push(word);
  }
  if (initials) out.push(initials);
  return out.join(" ");
};
const compact = (s: string) => nameKey(s).replace(/\s/g, "");

/** Leading credit words that may precede a name inside one credit segment ("Music by X", "Singer X"). */
const CREDIT_WORDS = /^(?:(?:music|musical|director|composed|composer|composition|arranged|and|by|singers?|sung|vocals?|artists?|performed|produced|producer|featuring|feat|ft|official|starring|lyrics?|written)\s+)+/;

/**
 * A full artist name credited as a whole segment of a title or credit line, split at the
 * usual separators ("|", "-", ",", "&", "(", "feat.", " x ", " by "…). The name must equal a
 * segment, never merely start one: "Pritam" is not credited by "Pritam Bhartwan New Song".
 * Very short names are too ambiguous to credit by text at all.
 */
export function creditsArtist(text: string, artistName: string): boolean {
  const artist = nameKey(artistName);
  if (artist.replace(/\s/g, "").length < 4) return false;
  return creditKeys(text).has(artist);
}

/** Every whole credit segment of a text, normalized. Hashtags and @mentions are tagging, not credits. */
export function creditKeys(text: string): Set<string> {
  return new Set(text
    .replace(/[#@]\S+/g, " ")
    .split(/[|,\-–—:;()[\]{}"“”/•·+&\n]|\s(?:x|X|feat\.?|ft\.?|featuring|with|by|and|vs\.?)\s/)
    .map((segment) => nameKey(segment).replace(CREDIT_WORDS, ""))
    .filter((key) => key.replace(/\s/g, "").length >= 4));
}

/** True when the recording also credits someone from the artist's Qloo context (or comes from their channel). */
export function corroborates(video: CandidateVideo, artistName: string, context: string[]): boolean {
  const self = nameKey(artistName);
  const keys = creditKeys(`${video.title}\n${(video.description ?? "").slice(0, 3000)}`);
  const channel = compact(video.channelTitle);
  return context.some((name) => {
    const key = nameKey(name);
    if (!key || key === self || key.replace(/\s/g, "").length < 4) return false;
    const c = key.replace(/\s/g, "");
    return keys.has(key) || channel === c || channel === `${c}topic` || channel === `${c}vevo`;
  });
}

export type MatchTier = "topic" | "vevo" | "artist_channel" | "credited_title" | "credited_description";
const TIER_RANK: Record<MatchTier, number> = { topic: 0, vevo: 1, artist_channel: 2, credited_title: 3, credited_description: 4 };
const KIND: Record<MatchTier, ResolvedVideo["channelKind"]> = { topic: "topic", vevo: "vevo", artist_channel: "artist_self_described", credited_title: "credited_upload", credited_description: "credited_upload" };

function channelTier(channelTitle: string, artistName: string): "topic" | "vevo" | "artist_channel" | null {
  const channel = compact(channelTitle);
  const artist = compact(artistName);
  if (!artist) return null;
  if (channel === `${artist}topic`) return "topic";
  if (channel === `${artist}vevo`) return "vevo";
  if (artist.length >= 4 && [artist, `${artist}official`, `official${artist}`, `${artist}music`, `${artist}officialchannel`, `${artist}officialmusic`].includes(channel)) return "artist_channel";
  return null;
}

const IMPERSONATION = /\b(cover|tribute|karaoke|reaction|parody|impersonat(?:e|ion)|fan made)\b/i;
/** Not a playable recording of the artist's own song, whatever channel posted it. */
const NOT_A_RECORDING =
  /\b(covers?|tribute|karaoke|reactions?|reacts?|reacting|parody|impersonat\w*|fan ?made|nightcore|slowed|reverb|8d|bass boosted|sped up|status|ringtones?|jukebox|non ?stop|mashup|medley|full album|live ?stream|shorts|lofi|lo fi|whatsapp|tutorial|lesson|chords|scenes?|trailer|teaser|promo|interview|making of|behind the scenes|press meet|audio launch|speech|mime|dance practice|choreography|unboxing)\b/;
const CREDIT_LINE = /^(music|music director|music composed(?: and arranged)? by|composed by|composer|music by|singers?|sung by|vocals?|artists?|performed by|produced by|featuring|feat)\b/;
const SONG_SECONDS = { min: 60, max: 900 };

export type CandidateVideo = { title: string; channelTitle: string; description?: string; durationSeconds?: number };

/** The strongest identity tier under which `video` is `artistName`'s recording, or null. */
export function matchRecording(video: CandidateVideo, artistName: string): MatchTier | null {
  const tier = channelTier(video.channelTitle, artistName);
  if (tier === "topic") return tier;
  if (tier === "vevo") return !IMPERSONATION.test(video.title) && (nameKey(video.title) === nameKey(artistName) || nameKey(video.title).startsWith(`${nameKey(artistName)} `)) ? tier : null;
  // Below Topic/VEVO the channel alone is weaker evidence: the upload must also look like a song.
  if (NOT_A_RECORDING.test(normalizeName(video.title))) return null;
  const d = video.durationSeconds;
  if (d === undefined || d < SONG_SECONDS.min || d > SONG_SECONDS.max) return null;
  if (tier) return tier;
  if (creditsArtist(video.title, artistName)) return "credited_title";
  const credited = (video.description ?? "").split(/\r?\n/).slice(0, 60).some((line) => {
    const key = nameKey(line);
    return CREDIT_LINE.test(key) && creditsArtist(line, artistName);
  });
  return credited ? "credited_description" : null;
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

type SearchItem = { id?: { videoId?: string }; snippet?: { channelId?: string; channelTitle?: string; title?: string } };
type VideoItem = {
  id?: string;
  snippet?: { title?: string; description?: string; channelId?: string; channelTitle?: string };
  contentDetails?: { duration?: string };
  status?: { embeddable?: boolean; privacyStatus?: string; uploadStatus?: string };
};

/** Light title key so the same song uploaded by a Topic channel and a label is offered once. */
const songKey = (title: string, artistName: string) =>
  ` ${nameKey(title.replace(/[([{][^)\]}]*[)\]}]/g, " "))} `
    .replace(` ${nameKey(artistName)} `, " ")
    .replace(/ (official|video|audio|lyrics?|lyrical|full|song|songs|hd|4k|music|visualizer|from|ft|feat) /g, " ")
    .replace(/\s+/g, " ")
    .trim();

type Verified = { video: ResolvedVideo; tier: MatchTier; channelId: string; order: number; corroborated: boolean };

/**
 * Attribute fetched videos to one artist. Each accepted video must have been returned by
 * the search with the same channel ID, be public and embeddable, and pass `matchRecording`.
 */
function verifyFor(artist: LookupArtist, items: SearchItem[], videos: VideoItem[], at: Date, context: string[] = []): { accepted: Verified[]; ambiguous?: string } {
  const searched = new Map(items.map((i, order) => [i.id?.videoId ?? "", { channelId: i.snippet?.channelId, order }]));
  const accepted: Verified[] = [];
  for (const video of videos) {
    const title = video.snippet?.title?.trim() ?? "";
    const channelTitle = video.snippet?.channelTitle?.trim() ?? "";
    const hit = searched.get(video.id ?? "");
    if (!isVideoId(video.id) || !title || !channelTitle || !hit?.channelId || hit.channelId !== video.snippet?.channelId) continue;
    if (video.status?.embeddable !== true || video.status.privacyStatus !== "public") continue;
    const durationSeconds = parseIsoDuration(video.contentDetails?.duration);
    const tier = matchRecording({ title, channelTitle, description: video.snippet?.description, durationSeconds }, artist.name);
    if (!tier) continue;
    accepted.push({
      tier,
      channelId: hit.channelId,
      order: hit.order,
      corroborated: context.length > 0 && corroborates({ title, channelTitle, description: video.snippet?.description }, artist.name, context),
      video: { videoId: video.id, title: title.slice(0, 300), channelTitle: channelTitle.slice(0, 200), channelKind: KIND[tier], provenance: "youtube_data_api", watchUrl: watchUrl(video.id), verifiedAt: at.toISOString(), ...(durationSeconds ? { durationSeconds } : {}) },
    });
  }
  // Two auto-generated (or two own-name) channels for one name means two different artists
  // share it. Then only recordings corroborated by the artist's Qloo context are kept, and
  // a Topic channel counts only if one of its recordings is corroborated.
  const topics = new Set(accepted.filter((v) => v.tier === "topic").map((v) => v.channelId));
  const owners = new Set(accepted.filter((v) => v.tier === "artist_channel").map((v) => v.channelId));
  let pool = accepted;
  if (topics.size > 1 || owners.size > 1) {
    const trustedChannels = new Set(accepted.filter((v) => v.corroborated && (v.tier === "topic" || v.tier === "artist_channel")).map((v) => v.channelId));
    pool = accepted.filter((v) => v.corroborated || trustedChannels.has(v.channelId));
    if (!pool.length) return { accepted: [], ambiguous: topics.size > 1 ? "multiple_topic_channels" : "multiple_artist_channels" };
  }
  const seenSongs = new Set<string>();
  // Within a tier, corroborated recordings come first; a corroborated credit outranks an uncorroborated own-name channel.
  const rank = (v: Verified) => TIER_RANK[v.tier] - (v.corroborated && v.tier !== "topic" && v.tier !== "vevo" ? 1.5 : 0);
  const ordered = pool
    .sort((a, b) => rank(a) - rank(b) || Number(b.corroborated) - Number(a.corroborated) || a.order - b.order)
    .filter((v) => {
      const key = songKey(v.video.title, artist.name);
      if (key && seenSongs.has(key)) return false;
      seenSongs.add(key);
      return true;
    });
  return { accepted: ordered.slice(0, MAX_PER_ARTIST) };
}

const resolvedFrom = (accepted: Verified[]): DynamicOutcome => ({ kind: "resolved", video: accepted[0]!.video, alternates: accepted.slice(1).map((v) => v.video) });

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
  /** One search (quota-counted) plus one videos.list for every returned ID (general bucket, 1 unit). */
  const searchAndFetch = async (q: string, maxResults: number) => {
    const search = await get<{ items?: SearchItem[] }>("search", { part: "snippet", type: "video", videoEmbeddable: "true", videoCategoryId: "10", maxResults: String(maxResults), q });
    const items = (search.items ?? []).filter((i) => isVideoId(i.id?.videoId));
    if (!items.length) return { items, videos: [] as VideoItem[] };
    const ids = [...new Set(items.map((i) => i.id!.videoId!))].slice(0, 50);
    const videos = await get<{ items?: VideoItem[] }>("videos", { part: "snippet,contentDetails,status", id: ids.join(",") });
    return { items, videos: videos.items ?? [] };
  };
  const at = () => opts.now?.() ?? new Date();

  return {
    async lookupBatch(artists, explorationId, harvest = [], context = []) {
      const bounded = [...new Map(artists.map((a) => [a.entityId, a])).values()].slice(0, 6);
      const extra = [...new Map(harvest.filter((h) => !bounded.some((b) => b.entityId === h.entityId)).map((a) => [a.entityId, a])).values()].slice(0, 90);
      const outcomes: Record<string, DynamicOutcome | null> = Object.fromEntries(bounded.map((a) => [a.entityId, null]));
      try {
        if (!(await opts.quota.take(explorationId))) return Object.fromEntries(bounded.map((a) => [a.entityId, { kind: "quota" as const }]));
        const { items, videos } = await searchAndFetch(bounded.map((a) => `"${a.name.replace(/[|"\\]/g, " ").slice(0, 200)}"`).join("|"), 50);
        if (!videos.length) return outcomes;
        const everyone = [...bounded, ...extra];
        for (const artist of everyone) {
          // Same normalized name for different Qloo IDs is ambiguous, never assigned to both.
          if (everyone.filter((a) => nameKey(a.name) === nameKey(artist.name)).length !== 1) {
            if (bounded.includes(artist)) outcomes[artist.entityId] = { kind: "ambiguous", reason: "duplicate_artist_name" };
            continue;
          }
          const { accepted, ambiguous } = verifyFor(artist, items, videos, at(), context);
          if (ambiguous) { if (bounded.includes(artist)) outcomes[artist.entityId] = { kind: "ambiguous", reason: ambiguous }; continue; }
          if (accepted.length) outcomes[artist.entityId] = resolvedFrom(accepted);
        }
        return outcomes;
      } catch (error) {
        return Object.fromEntries(bounded.map((a) => [a.entityId, (error as { quota?: boolean }).quota ? { kind: "quota" as const } : { kind: "failed" as const, reason: "youtube_batch_failed" }]));
      }
    },
    async lookup(artist, explorationId, options) {
      try {
        // The shared Redis-backed quota decision is part of authorization. If it is
        // unavailable, fail closed before making any YouTube request.
        if (!(await opts.quota.take(explorationId))) return { kind: "quota" };
        const { items, videos } = await searchAndFetch(artist.name.slice(0, 200), 25);
        if (!items.length) return { kind: "none" };
        const { accepted, ambiguous } = verifyFor(artist, items, videos, at(), options?.context ?? []);
        if (ambiguous) return { kind: "ambiguous", reason: ambiguous };
        if (!accepted.length) return { kind: "ambiguous", reason: "no_verified_match" };
        return resolvedFrom(accepted);
      } catch (error) {
        if ((error as { quota?: boolean }).quota) return { kind: "quota" };
        return { kind: "failed", reason: (error as Error).name === "TimeoutError" ? "youtube_timeout" : "youtube_error" };
      }
    },
  };
}
