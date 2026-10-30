import { beforeEach, describe, expect, it, vi } from "vitest";
import { MusicResolutionSchema } from "@/lib/contracts";
import { loadConfig } from "@/lib/config/env";
import { REVIEWED_MAPPINGS, reviewedMappingFor } from "@/lib/music/mappings";
import { resolveArtistVideo, selectMoment, type ResolveOptions } from "@/lib/music/resolver";
import { deduplicated } from "@/lib/music/service";
import { QLOO_ENTITY_ID, YOUTUBE_VIDEO_ID, momentWithinBounds, searchUrl, watchUrl, type ReviewedMapping } from "@/lib/music/types";
import { corroborates, createQuotaGuard, createYouTubeDataLookup, creditsArtist, matchRecording, nameKey, parseIsoDuration, resetYouTubeKeyCooldowns, type DynamicLookup, type QuotaGuard } from "@/lib/music/youtube-data";
import { createMemoryRateLimitStore } from "@/lib/reliability/rate-limit";
import { NEGATIVE_TTL_MS, RESOLVED_TTL_MS, RESOLVER_POLICY_VERSION, cachedLookup, createMemoryLookupCache, createRedisLookupCache, lookupCacheKey } from "@/lib/music/cache";

/** S9.9 resolver, registry and optional Data API tier. Offline: no YouTube, Qloo or Gemini calls. */

// Key cooldowns are module-wide (per server instance); every test starts with all keys usable.
beforeEach(() => resetYouTubeKeyCooldowns());

const JOHANN = { entityId: "5AD69C26-F5C4-482F-9C8B-E3B7432F2FDC", name: "Jóhann Jóhannsson", provenance: "qloo" as const };
const NOW = new Date("2026-10-30T12:00:00Z");
const opts = (over: Partial<ResolveOptions> = {}): ResolveOptions => ({ explorationId: "exp-1", now: NOW, momentReview: false, ...over });
const parse = (r: unknown) => MusicResolutionSchema.parse(r);

describe("reviewed mapping registry", () => {
  it("every entry is well-formed, unique and traceable", () => {
    const artistIds = REVIEWED_MAPPINGS.map((m) => m.qlooArtistId);
    expect(new Set(artistIds).size).toBe(artistIds.length);
    const videoIds = REVIEWED_MAPPINGS.flatMap((m) => [m.primary, ...m.alternates].map((v) => v.videoId));
    expect(new Set(videoIds).size).toBe(videoIds.length);
    for (const m of REVIEWED_MAPPINGS) {
      expect(m.qlooArtistId).toMatch(QLOO_ENTITY_ID);
      for (const v of [m.primary, ...m.alternates]) {
        expect(v.videoId).toMatch(YOUTUBE_VIDEO_ID);
        expect(v.evidence).toContain("oembed_200");
        expect(v.title.trim()).not.toBe("");
        expect(v.channelUrl).toMatch(/^https:\/\/www\.youtube\.com\//);
        expect(Number.isNaN(Date.parse(v.verifiedAt))).toBe(false);
        // Playable mappings never rest on a self-described channel.
        if (m.review === "RESOLVED") expect(v.channelKind).not.toBe("artist_self_described");
      }
      for (const mo of m.moments) {
        expect(mo.status === "PENDING_REVIEW" || (mo.reviewedBy && mo.reviewedAt)).toBeTruthy();
        const video = [m.primary, ...m.alternates].find((v) => v.videoId === mo.videoId);
        expect(video, "moment refers to a mapped video").toBeDefined();
        expect(momentWithinBounds(mo, video!.durationSeconds)).toBe(true);
      }
    }
  });

  it("holds 12–20 artists, the three S9.8-verified ones included, and no approved moment yet", () => {
    expect(REVIEWED_MAPPINGS.length).toBeGreaterThanOrEqual(12);
    expect(REVIEWED_MAPPINGS.length).toBeLessThanOrEqual(20);
    expect(reviewedMappingFor(JOHANN.entityId)?.primary.videoId).toBe("aXlx-YnvgKU");
    expect(reviewedMappingFor("0704ADB9-6270-4D71-B252-A42D8A4EAA47")?.primary.videoId).toBe("InyT9Gyoz_o");
    expect(reviewedMappingFor("02940707-9635-45DA-B290-243F84C6B910")?.primary.videoId).toBe("xpZgtFhDbss");
    expect(REVIEWED_MAPPINGS.flatMap((m) => m.moments).filter((m) => m.status === "APPROVED")).toEqual([]);
  });

  it("only produces YouTube URLs, and rejects malformed IDs", () => {
    expect(watchUrl("aXlx-YnvgKU")).toBe("https://www.youtube.com/watch?v=aXlx-YnvgKU");
    expect(() => watchUrl("https://evil.example/?v=aXlx-YnvgKU")).toThrow();
    expect(() => watchUrl("short")).toThrow();
    expect(searchUrl("Sigur Rós & co")).toBe("https://www.youtube.com/results?search_query=Sigur+R%C3%B3s+%26+co");
  });
});

describe("resolution tiers", () => {
  it("Tier A: a reviewed artist resolves with provenance, alternates and no unreviewed moment", async () => {
    const r = parse(await resolveArtistVideo(JOHANN, opts()));
    expect(r.status).toBe("RESOLVED");
    expect(r.artist).toEqual(JOHANN);
    expect(r.video).toMatchObject({ videoId: "aXlx-YnvgKU", channelTitle: "Jóhann Jóhannsson - Topic", provenance: "reviewed_mapping", channelKind: "topic" });
    expect(r.alternates.map((a) => a.videoId)).toEqual(["mPvqle7mF-U", "dCWbVxfkoKg"]);
    expect(r.featuredMoment).toBeNull(); // PENDING_REVIEW is never public
    expect(r.dynamicLookup).toBe("NOT_NEEDED");
  });

  it("review mode exposes the pending moment, labelled PENDING_REVIEW", async () => {
    const r = parse(await resolveArtistVideo(JOHANN, opts({ momentReview: true })));
    expect(r.featuredMoment).toMatchObject({ status: "PENDING_REVIEW", provenance: "human_curated", videoId: "aXlx-YnvgKU" });
  });

  it("a reviewed mapping never triggers a Data API call", async () => {
    const dynamic: DynamicLookup = { lookup: vi.fn() };
    await resolveArtistVideo(JOHANN, opts({ dynamic }));
    expect(dynamic.lookup).not.toHaveBeenCalled();
  });

  it("unknown artist without a key: UNAVAILABLE with a safe search fallback, artist kept", async () => {
    const r = parse(await resolveArtistVideo({ entityId: "00000000-0000-4000-8000-000000000000", name: "Unknown Artist", provenance: "qloo" }, opts()));
    expect(r).toMatchObject({ status: "UNAVAILABLE", video: null, reason: "no_reviewed_mapping", dynamicLookup: "DISABLED_NO_KEY" });
    expect(r.artist.name).toBe("Unknown Artist");
    expect(r.fallback.url).toBe("https://www.youtube.com/results?search_query=Unknown+Artist");
  });

  it("synthetic (mock) artists never resolve, even if an ID collides", async () => {
    const r = await resolveArtistVideo({ ...JOHANN, provenance: "mock" }, opts());
    expect(r).toMatchObject({ status: "UNAVAILABLE", reason: "synthetic_artist" });
  });

  it("a Qloo ID whose name no longer matches the registry is not played", async () => {
    const r = await resolveArtistVideo({ ...JOHANN, name: "Someone Else" }, opts());
    expect(r).toMatchObject({ status: "NEEDS_REVIEW", reason: "artist_name_mismatch", video: null });
  });

  it("a mapping held for review (self-described channel) is NEEDS_REVIEW, never played", async () => {
    const r = await resolveArtistVideo({ entityId: "75AE7DFF-0996-4522-BAEE-064A5CB73FD0", name: "Poppy Ackroyd", provenance: "qloo" }, opts());
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.video).toBeNull();
  });

  it("mappings expire: stale metadata falls back to NEEDS_REVIEW", async () => {
    const r = await resolveArtistVideo(JOHANN, opts({ now: new Date("2026-12-15T00:00:00Z") }));
    expect(r).toMatchObject({ status: "NEEDS_REVIEW", reason: "mapping_stale" });
  });

  it("a malformed registry video ID is refused", async () => {
    const bad: ReviewedMapping = { ...reviewedMappingFor(JOHANN.entityId)!, primary: { ...reviewedMappingFor(JOHANN.entityId)!.primary, videoId: "../../x" } };
    const r = await resolveArtistVideo(JOHANN, opts({ registry: () => bad }));
    expect(r).toMatchObject({ status: "NEEDS_REVIEW", reason: "invalid_video_id" });
  });

  it("duplicate resolutions are identical (idempotent, no state)", async () => {
    const [a, b] = await Promise.all([resolveArtistVideo(JOHANN, opts()), resolveArtistVideo(JOHANN, opts())]);
    expect(a).toEqual(b);
  });
});

describe("featured moments", () => {
  const base = reviewedMappingFor(JOHANN.entityId)!;
  const withMoment = (m: Partial<ReviewedMapping["moments"][number]>, durationSeconds?: number): ReviewedMapping => ({
    ...base,
    primary: { ...base.primary, ...(durationSeconds ? { durationSeconds } : {}) },
    moments: [{ videoId: base.primary.videoId, startSeconds: 60, endSeconds: 90, status: "APPROVED", provenance: "human_curated", reviewedBy: "r", reviewedAt: "2026-10-30", note: "", ...m }],
  });

  it("an APPROVED moment with a reviewer is offered", () => {
    expect(selectMoment(withMoment({}), withMoment({}).primary, false)).toMatchObject({ status: "APPROVED", startSeconds: 60, endSeconds: 90 });
  });
  it("APPROVED without a reviewer is not offered", () => {
    const m = withMoment({ reviewedBy: undefined });
    expect(selectMoment(m, m.primary, false)).toBeNull();
  });
  it("invalid bounds are never offered", () => {
    for (const bad of [{ startSeconds: -1 }, { startSeconds: 90, endSeconds: 90 }, { startSeconds: 100, endSeconds: 90 }, { endSeconds: Number.NaN }]) {
      const m = withMoment(bad);
      expect(selectMoment(m, m.primary, true)).toBeNull();
    }
    const tooLong = withMoment({ endSeconds: 500 }, 391);
    expect(selectMoment(tooLong, tooLong.primary, true)).toBeNull();
  });
  it("a moment for another video is ignored", () => {
    const m = withMoment({ videoId: "mPvqle7mF-U" });
    expect(selectMoment(m, m.primary, true)).toBeNull();
  });
  it("no moment: normal playback (null)", () => {
    expect(selectMoment({ ...base, moments: [] }, base.primary, true)).toBeNull();
  });
});

// ---------------------------------------------------------------- Tier B (only with a dedicated key)

const okQuota: QuotaGuard = { take: async () => true };
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const search = (items: Array<{ id: string; channel: string; channelId?: string }>) => ({
  items: items.map((i) => ({ id: { videoId: i.id }, snippet: { channelTitle: i.channel, channelId: i.channelId ?? "C1" } })),
});
const videos = (items: Array<{ id: string; channel: string; embeddable?: boolean; title?: string; channelId?: string; description?: string; duration?: string }>) => ({
  items: items.map((i) => ({
    id: i.id,
    snippet: { title: i.title ?? "Song", channelTitle: i.channel, channelId: i.channelId ?? "C1", ...(i.description ? { description: i.description } : {}) },
    contentDetails: { duration: i.duration ?? "PT4M5S" },
    status: { embeddable: i.embeddable ?? true, privacyStatus: "public" },
  })),
});

function fakeFetch(...responses: Response[]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    return next;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("optional YouTube Data API tier", () => {
  const unknown = { entityId: "11111111-1111-4111-8111-111111111111", name: "New Artist", provenance: "qloo" as const };

  it("batch lookup verifies multiple exact artists with one quota reservation and rejects unsearched or label videos", async () => {
    const artists = [unknown, { entityId: "22222222-2222-4222-8222-222222222222", name: "Second Artist" }];
    const { fetcher, calls } = fakeFetch(
      jsonRes(search([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic" }, { id: "BBBBBBBBBBB", channel: "SecondArtistVEVO" }, { id: "CCCCCCCCCCC", channel: "Unreviewed Label" }])),
      jsonRes(videos([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic" }, { id: "BBBBBBBBBBB", channel: "SecondArtistVEVO", title: "Second Artist - Track" }, { id: "CCCCCCCCCCC", channel: "Unreviewed Label" }, { id: "DDDDDDDDDDD", channel: "New Artist - Topic" }])),
    );
    const quota = { take: vi.fn(async () => true) };
    const resolver = createYouTubeDataLookup({ apiKey: "FIXTURE", timeoutMs: 1000, quota, fetcher });
    const out = await resolver.lookupBatch!(artists, "fixture");
    expect(out[artists[0]!.entityId]).toMatchObject({ kind: "resolved", video: { videoId: "AAAAAAAAAAA" } });
    expect(out[artists[1]!.entityId]).toMatchObject({ kind: "resolved", video: { videoId: "BBBBBBBBBBB" } });
    expect(quota.take).toHaveBeenCalledTimes(1); expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get("q")).toBe('"New Artist"|"Second Artist"');
  });

  it("batch omissions never become negative cache entries, and a cache-only peek spends no quota", async () => {
    const cache = createMemoryLookupCache();
    const inner: DynamicLookup = { lookup: vi.fn(async () => ({ kind: "none" as const })), lookupBatch: vi.fn(async () => ({ [unknown.entityId]: null })) };
    const resolver = cachedLookup(inner, cache);
    expect(await resolver.lookupBatch!([unknown], "fixture")).toEqual({ [unknown.entityId]: null });
    expect(await resolver.peek!(unknown)).toBeNull();
    await resolver.lookup(unknown, "fixture");
    expect(inner.lookup).toHaveBeenCalledTimes(1);
  });

  it("ambiguous duplicate artist names in a batch cannot authorize the same recording twice", async () => {
    const { fetcher } = fakeFetch(jsonRes(search([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic" }])));
    const resolver = createYouTubeDataLookup({ apiKey: "FIXTURE", timeoutMs: 1000, quota: okQuota, fetcher });
    const out = await resolver.lookupBatch!([unknown, { ...unknown, entityId: "different-id" }], "fixture");
    expect(Object.values(out).every((o) => o === null || o.kind !== "resolved")).toBe(true);
  });

  it("accepts only a single matching Topic channel, embeddable and public; key stays in a header", async () => {
    const { fetcher, calls } = fakeFetch(
      jsonRes(search([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic" }, { id: "BBBBBBBBBBB", channel: "Fan Uploads" }])),
      jsonRes(videos([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic", title: "Track" }])),
    );
    const dynamic = createYouTubeDataLookup({ apiKey: "SECRET-KEY", timeoutMs: 1000, quota: okQuota, fetcher, now: () => NOW });
    const r = parse(await resolveArtistVideo(unknown, opts({ dynamic })));
    expect(r).toMatchObject({ status: "RESOLVED", dynamicLookup: "USED", video: { videoId: "AAAAAAAAAAA", provenance: "youtube_data_api", durationSeconds: 245 } });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).not.toContain("SECRET-KEY");
      expect(c.url.startsWith("https://www.googleapis.com/youtube/v3/")).toBe(true);
      expect(c.headers["x-goog-api-key"]).toBe("SECRET-KEY");
    }
    expect(calls[0]!.url).toContain("videoEmbeddable=true");
  });

  it("'Official' in a title is not identity: an uncredited upload → NEEDS_REVIEW", async () => {
    const { fetcher } = fakeFetch(jsonRes(search([{ id: "AAAAAAAAAAA", channel: "MusicHub" }])), jsonRes(videos([{ id: "AAAAAAAAAAA", channel: "MusicHub", title: "Official Song" }])));
    const dynamic = createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher });
    expect(await resolveArtistVideo(unknown, opts({ dynamic }))).toMatchObject({ status: "NEEDS_REVIEW", reason: "no_verified_match", video: null });
  });

  it("exposes multiple recordings only from the searched verified channel and video IDs", async () => {
    const { fetcher, calls } = fakeFetch(
      jsonRes(search([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic" }, { id: "BBBBBBBBBBB", channel: "New Artist - Topic" }])),
      jsonRes(videos([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic" }, { id: "BBBBBBBBBBB", channel: "New Artist - Topic" }, { id: "CCCCCCCCCCC", channel: "New Artist - Topic" }])),
    );
    const dynamic = createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher });
    const r = await resolveArtistVideo(unknown, opts({ dynamic }));
    expect(r.status).toBe("RESOLVED");
    expect(r.alternates.map((v) => v.videoId)).toEqual(["BBBBBBBBBBB"]);
    expect(calls).toHaveLength(2);
  });

  it("accepts an exact-name VEVO channel only when video metadata corroborates the artist", async () => {
    const { fetcher } = fakeFetch(
      jsonRes(search([{ id: "AAAAAAAAAAA", channel: "NewArtistVEVO" }])),
      jsonRes(videos([{ id: "AAAAAAAAAAA", channel: "NewArtistVEVO", title: "New Artist - Northern Lights (Official Video)" }])),
    );
    const dynamic = createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher, now: () => NOW });
    expect(await resolveArtistVideo(unknown, opts({ dynamic }))).toMatchObject({
      status: "RESOLVED",
      video: { videoId: "AAAAAAAAAAA", channelKind: "vevo", channelTitle: "NewArtistVEVO" },
    });
  });

  it("rejects lookalike VEVO channels and non-corroborating or impersonation metadata", async () => {
    const lookalike = fakeFetch(jsonRes(search([{ id: "AAAAAAAAAAA", channel: "NewArtistVEVOOfficial" }])), jsonRes(videos([{ id: "AAAAAAAAAAA", channel: "NewArtistVEVOOfficial" }])));
    expect(await resolveArtistVideo(unknown, opts({ dynamic: createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher: lookalike.fetcher }) }))).toMatchObject({ status: "NEEDS_REVIEW" });

    for (const title of ["Another Artist - Song", "New Artist cover by Someone"] as const) {
      const attempt = fakeFetch(
        jsonRes(search([{ id: "AAAAAAAAAAA", channel: "New Artist VEVO" }])),
        jsonRes(videos([{ id: "AAAAAAAAAAA", channel: "New Artist VEVO", title }])),
      );
      expect(await resolveArtistVideo(unknown, opts({ dynamic: createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher: attempt.fetcher }) }))).toMatchObject({ status: "NEEDS_REVIEW", reason: "no_verified_match" });
    }
  });

  it("two Topic channels for one name are ambiguous", async () => {
    const { fetcher } = fakeFetch(
      jsonRes(search([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic", channelId: "C1" }, { id: "BBBBBBBBBBB", channel: "New Artist - Topic", channelId: "C2" }])),
      jsonRes(videos([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic", channelId: "C1" }, { id: "BBBBBBBBBBB", channel: "New Artist - Topic", channelId: "C2" }])),
    );
    const dynamic = createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher });
    expect(await resolveArtistVideo(unknown, opts({ dynamic }))).toMatchObject({ status: "NEEDS_REVIEW", reason: "multiple_topic_channels" });
  });

  it("unembeddable results are not resolved", async () => {
    const { fetcher } = fakeFetch(
      jsonRes(search([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic" }])),
      jsonRes(videos([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic", embeddable: false }])),
    );
    const dynamic = createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher });
    expect(await resolveArtistVideo(unknown, opts({ dynamic }))).toMatchObject({ status: "NEEDS_REVIEW", reason: "no_verified_match" });
  });

  it("empty search → UNAVAILABLE; 403 quota → RATE_LIMITED; network error → UPSTREAM_FAILURE (no retry)", async () => {
    const empty = fakeFetch(jsonRes({ items: [] }));
    expect(await resolveArtistVideo(unknown, opts({ dynamic: createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher: empty.fetcher }) }))).toMatchObject({ status: "UNAVAILABLE", reason: "no_match" });
    const quota = fakeFetch(jsonRes({ error: { code: 403 } }, 403));
    expect(await resolveArtistVideo(unknown, opts({ dynamic: createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher: quota.fetcher }) }))).toMatchObject({ status: "RATE_LIMITED", dynamicLookup: "QUOTA_EXHAUSTED" });
    resetYouTubeKeyCooldowns(); // the 403 set "k" aside; the next step is about an ordinary network failure
    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const failing = createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher: broken });
    expect(await resolveArtistVideo(unknown, opts({ dynamic: failing }))).toMatchObject({ status: "UPSTREAM_FAILURE", dynamicLookup: "FAILED" });
    expect(quota.calls).toHaveLength(1);
  });

  it("server-side quota: per-exploration and daily caps, counted before the call", async () => {
    const store = createMemoryRateLimitStore();
    const guard = createQuotaGuard(store, { dailySearchMax: 3, searchesPerExploration: 2, explorationWindowMs: 60_000 }, () => NOW.getTime());
    expect([await guard.take("a"), await guard.take("a"), await guard.take("a")]).toEqual([true, true, false]);
    expect([await guard.take("b"), await guard.take("c")]).toEqual([true, false]); // daily cap of 3 reached
    const off = createQuotaGuard(store, { dailySearchMax: 0, searchesPerExploration: 2, explorationWindowMs: 60_000 });
    expect(await off.take("d")).toBe(false);

    const { fetcher, calls } = fakeFetch();
    const denied = createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: { take: async () => false }, fetcher });
    expect(await resolveArtistVideo(unknown, opts({ dynamic: denied }))).toMatchObject({ status: "RATE_LIMITED" });
    expect(calls).toHaveLength(0);
  });

  it("a quota-store outage fails closed before any YouTube request", async () => {
    const { fetcher, calls } = fakeFetch();
    const dynamic = createYouTubeDataLookup({
      apiKey: "k",
      timeoutMs: 1000,
      quota: { take: async () => { throw new Error("redis unavailable"); } },
      fetcher,
    });
    expect(await resolveArtistVideo(unknown, opts({ dynamic }))).toMatchObject({ status: "UPSTREAM_FAILURE", dynamicLookup: "FAILED" });
    expect(calls).toHaveLength(0);
  });

  it("concurrent lookups for the same artist share one request", async () => {
    let calls = 0;
    const inner: DynamicLookup = {
      lookup: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return { kind: "none" };
      },
    };
    const d = deduplicated(inner);
    const x = { entityId: "X", name: "X" };
    await Promise.all([d.lookup(x, "e"), d.lookup(x, "e"), d.lookup(x, "e")]);
    expect(calls).toBe(1);
  });

  it("S9.17: accepts the artist's own channel and label uploads that credit the artist by full name", async () => {
    const { fetcher } = fakeFetch(
      jsonRes(search([
        { id: "AAAAAAAAAAA", channel: "Big Label Records", channelId: "L1" },
        { id: "BBBBBBBBBBB", channel: "New Artist", channelId: "A1" },
        { id: "CCCCCCCCCCC", channel: "Big Label Records", channelId: "L1" },
        { id: "DDDDDDDDDDD", channel: "Fan Edits", channelId: "F1" },
        { id: "EEEEEEEEEEE", channel: "Big Label Records", channelId: "L1" },
      ])),
      jsonRes(videos([
        { id: "AAAAAAAAAAA", channel: "Big Label Records", channelId: "L1", title: "Northern Lights | Film Name | New Artist" },
        { id: "BBBBBBBBBBB", channel: "New Artist", channelId: "A1", title: "Southern Skies (Official Video)" },
        { id: "CCCCCCCCCCC", channel: "Big Label Records", channelId: "L1", title: "Eastern Sea - Lyrical", description: "Song credits\nMusic: New Artist\nLyrics: Someone Else" },
        { id: "DDDDDDDDDDD", channel: "Fan Edits", channelId: "F1", title: "Northern Lights | New Artist | Slowed + Reverb" },
        { id: "EEEEEEEEEEE", channel: "Big Label Records", channelId: "L1", title: "New Artistry Live Jam" },
      ])),
    );
    const dynamic = createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher, now: () => NOW });
    const r = parse(await resolveArtistVideo(unknown, opts({ dynamic })));
    expect(r.status).toBe("RESOLVED");
    // Strongest tier first: own channel, then title credit, then description credit.
    expect([r.video!.videoId, ...r.alternates.map((v) => v.videoId)]).toEqual(["BBBBBBBBBBB", "AAAAAAAAAAA", "CCCCCCCCCCC"]);
    expect(r.video!.channelKind).toBe("artist_self_described");
    expect(r.alternates.map((v) => v.channelKind)).toEqual(["credited_upload", "credited_upload"]);
  });

  it("S9.17: a name that only begins a longer name, hashtags, shorts and non-songs are never credits", () => {
    const song = { channelTitle: "Any Channel", durationSeconds: 200 };
    expect(matchRecording({ ...song, title: "Pritam Bhartwan New Song" }, "Pritam")).toBeNull();
    expect(matchRecording({ ...song, title: "Show clip #newartist #tv" }, "New Artist")).toBeNull();
    expect(matchRecording({ ...song, title: "Track | New Artist", durationSeconds: 30 }, "New Artist")).toBeNull();
    expect(matchRecording({ ...song, title: "Track | New Artist | Karaoke" }, "New Artist")).toBeNull();
    expect(matchRecording({ ...song, title: "Track | New Artist | Audio Jukebox" }, "New Artist")).toBeNull();
    expect(matchRecording({ ...song, title: "Track (feat. A. B. Singer)" }, "AB Singer")).toBe("credited_title");
    expect(matchRecording({ ...song, title: "Track | Sky", }, "Sky")).toBeNull(); // too short to credit by text
    expect(creditsArtist("Song - Music by New Artist", "New Artist")).toBe(true);
    expect(nameKey("A.R. Example")).toBe(nameKey("AR Example"));
  });

  it("S9.18: namesakes — two Topic channels resolve only through recordings corroborated by the artist's Qloo context", async () => {
    const results = () => [
      jsonRes(search([
        { id: "AAAAAAAAAAA", channel: "New Artist - Topic", channelId: "T1" },
        { id: "BBBBBBBBBBB", channel: "New Artist - Topic", channelId: "T2" },
        { id: "CCCCCCCCCCC", channel: "Folk Label", channelId: "L1" },
        { id: "DDDDDDDDDDD", channel: "Film Label", channelId: "L2" },
      ])),
      jsonRes(videos([
        { id: "AAAAAAAAAAA", channel: "New Artist - Topic", channelId: "T1", title: "Hill Song", description: "Provided to YouTube\nHill Song · New Artist · Village Singer" },
        { id: "BBBBBBBBBBB", channel: "New Artist - Topic", channelId: "T2", title: "City Song", description: "Provided to YouTube\nCity Song · New Artist · Famous Composer" },
        { id: "CCCCCCCCCCC", channel: "Folk Label", channelId: "L1", title: "Hill Dance | New Artist | Village Singer" },
        { id: "DDDDDDDDDDD", channel: "Film Label", channelId: "L2", title: "Night Theme | New Artist | Famous Composer" },
      ])),
    ];
    const blind = fakeFetch(...results());
    expect(await createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher: blind.fetcher }).lookup(unknown, "e")).toEqual({ kind: "ambiguous", reason: "multiple_topic_channels" });
    const informed = fakeFetch(...results());
    const out = await createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher: informed.fetcher }).lookup(unknown, "e", { context: ["Famous Composer", "Another Star"] });
    expect(out.kind === "resolved" && [out.video.videoId, ...(out.alternates ?? []).map((v) => v.videoId)]).toEqual(["BBBBBBBBBBB", "DDDDDDDDDDD"]);
    expect(corroborates({ title: "Song | New Artist", channelTitle: "Famous Composer - Topic" }, "New Artist", ["Famous Composer"])).toBe(true);
    expect(corroborates({ title: "Song | New Artist", channelTitle: "Label" }, "New Artist", ["New Artist"])).toBe(false); // never self-corroboration
  });

  it("S9.17: one batch query also harvests verified recordings for other authorized reservoir artists", async () => {
    const { fetcher } = fakeFetch(
      jsonRes(search([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic" }, { id: "BBBBBBBBBBB", channel: "Label", channelId: "L1" }])),
      jsonRes(videos([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic" }, { id: "BBBBBBBBBBB", channel: "Label", channelId: "L1", title: "Duet | New Artist, Other Person" }])),
    );
    const resolver = createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher });
    const other = { entityId: "33333333-3333-4333-8333-333333333333", name: "Other Person" };
    const absent = { entityId: "44444444-4444-4444-8444-444444444444", name: "Absent Artist" };
    const out = await resolver.lookupBatch!([unknown], "fixture", [other, absent]);
    expect(out[unknown.entityId]).toMatchObject({ kind: "resolved" });
    expect(out[other.entityId]).toMatchObject({ kind: "resolved", video: { videoId: "BBBBBBBBBBB", channelKind: "credited_upload" } });
    expect(out[absent.entityId]).toBeUndefined(); // harvest is positive-only, never a negative
  });

  it("S9.18: key failover — a quota-exhausted key hands the same request to the next key, and stays set aside", async () => {
    resetYouTubeKeyCooldowns();
    const used: string[] = [];
    const responses = [jsonRes({ error: { code: 403, errors: [{ reason: "quotaExceeded" }] } }, 403), jsonRes(search([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic" }])), jsonRes(videos([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic" }]))];
    const fetcher = (async (_url: string, init?: RequestInit) => { used.push((init?.headers as Record<string, string>)["x-goog-api-key"]!); return responses.shift()!; }) as unknown as typeof fetch;
    const quota = { take: vi.fn(async () => true) };
    const lookup = createYouTubeDataLookup({ apiKeys: ["KEY-ONE", "KEY-TWO", "KEY-THREE"], timeoutMs: 1000, quota, fetcher, now: () => NOW });
    expect(await lookup.lookup(unknown, "e")).toMatchObject({ kind: "resolved", video: { videoId: "AAAAAAAAAAA" } });
    expect(used).toEqual(["KEY-ONE", "KEY-TWO", "KEY-TWO"]);
    expect(quota.take).toHaveBeenCalledTimes(1); // one logical search, whatever it took
    // Key one is skipped on the next request without spending a call on it.
    used.length = 0;
    responses.push(jsonRes({ items: [] }));
    await lookup.lookup(unknown, "e");
    expect(used).toEqual(["KEY-TWO"]);
  });

  it("S9.18: two keys with a blank or missing third is a normal configuration, never an error", () => {
    const base = { NODE_ENV: "test", QLOO_MODE: "mock", SESSION_SIGNING_SECRET: "x".repeat(40) };
    expect(loadConfig({ ...base, YOUTUBE_API_KEY: "KEY-ONE", YOUTUBE_API_KEY_2: "KEY-TWO", YOUTUBE_API_KEY_3: "" }).music).toMatchObject({ youtubeApiKey: "KEY-ONE", youtubeApiKeys: ["KEY-ONE", "KEY-TWO"] });
    expect(loadConfig({ ...base, YOUTUBE_API_KEY: "KEY-ONE", YOUTUBE_API_KEY_2: "KEY-TWO" }).music.youtubeApiKeys).toEqual(["KEY-ONE", "KEY-TWO"]);
    expect(loadConfig({ ...base, YOUTUBE_API_KEY: "KEY-ONE", YOUTUBE_API_KEY_3: "   " }).music.youtubeApiKeys).toEqual(["KEY-ONE"]);
    expect(loadConfig({ ...base, YOUTUBE_API_KEY_2: "KEY-TWO" }).music).toMatchObject({ youtubeApiKey: "KEY-TWO", youtubeApiKeys: ["KEY-TWO"] });
    expect(loadConfig(base).music).toMatchObject({ youtubeApiKey: undefined, youtubeApiKeys: [] });
  });

  it("S9.18: an invalid key fails over; when every key is out, the result is RATE_LIMITED without retries", async () => {
    resetYouTubeKeyCooldowns();
    const used: string[] = [];
    const responses = [jsonRes({ error: { message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] } }, 400), jsonRes({ error: { code: 429 } }, 429), jsonRes({ error: { code: 403 } }, 403)];
    const fetcher = (async (_url: string, init?: RequestInit) => { used.push((init?.headers as Record<string, string>)["x-goog-api-key"]!); return responses.shift()!; }) as unknown as typeof fetch;
    const lookup = createYouTubeDataLookup({ apiKeys: ["BAD", "BUSY", "SPENT"], timeoutMs: 1000, quota: okQuota, fetcher, now: () => NOW });
    expect(await resolveArtistVideo(unknown, opts({ dynamic: lookup }))).toMatchObject({ status: "RATE_LIMITED" });
    expect(used).toEqual(["BAD", "BUSY", "SPENT"]);
    // An ordinary upstream error is not a key problem: no failover.
    resetYouTubeKeyCooldowns();
    const once: string[] = [];
    const broken = (async (_u: string, init?: RequestInit) => { once.push((init?.headers as Record<string, string>)["x-goog-api-key"]!); return jsonRes({}, 500); }) as unknown as typeof fetch;
    expect(await createYouTubeDataLookup({ apiKeys: ["A", "B"], timeoutMs: 1000, quota: okQuota, fetcher: broken }).lookup(unknown, "e")).toMatchObject({ kind: "failed" });
    expect(once).toEqual(["A"]);
    resetYouTubeKeyCooldowns();
  });

  it("parses ISO durations", () => {
    expect(parseIsoDuration("PT6M31S")).toBe(391);
    expect(parseIsoDuration("PT1H")).toBe(3600);
    expect(parseIsoDuration("P1D")).toBeUndefined();
  });
});

describe("per-artist Tier B cache", () => {
  const artist = { entityId: "11111111-1111-4111-8111-111111111111", name: "New Artist", provenance: "qloo" as const };
  const video = (videoId: string) => ({ videoId, title: "Song", channelTitle: "New Artist - Topic", watchUrl: `https://www.youtube.com/watch?v=${videoId}`, provenance: "youtube_data_api" as const, channelKind: "topic" as const, verifiedAt: NOW.toISOString() });

  it("a second resolve reuses the same video, spends no quota and is labelled CACHED", async () => {
    let calls = 0;
    const take = vi.fn(async () => true);
    const inner: DynamicLookup = {
      lookup: async () => {
        if (!(await take())) return { kind: "quota" };
        calls += 1;
        return { kind: "resolved", video: video(calls === 1 ? "AAAAAAAAAAA" : "BBBBBBBBBBB") };
      },
    };
    const dynamic = cachedLookup(inner, createMemoryLookupCache());
    const first = await resolveArtistVideo(artist, opts({ dynamic }));
    const second = await resolveArtistVideo(artist, opts({ dynamic, explorationId: "another" }));
    expect(first).toMatchObject({ dynamicLookup: "USED", video: { videoId: "AAAAAAAAAAA" } });
    expect(second).toMatchObject({ status: "RESOLVED", dynamicLookup: "CACHED", video: { videoId: "AAAAAAAAAAA" } });
    expect(calls).toBe(1);
    expect(take).toHaveBeenCalledTimes(1);
    parse(second);
  });

  it("quota refusals and failures are never cached; negative outcomes are", async () => {
    const outcomes = [{ kind: "quota" as const }, { kind: "failed" as const, reason: "youtube_error" }, { kind: "ambiguous" as const, reason: "no_topic_channel_match" }];
    let i = 0;
    const inner: DynamicLookup = { lookup: async () => outcomes[Math.min(i++, outcomes.length - 1)]! };
    const dynamic = cachedLookup(inner, createMemoryLookupCache());
    expect((await resolveArtistVideo(artist, opts({ dynamic }))).status).toBe("RATE_LIMITED");
    expect((await resolveArtistVideo(artist, opts({ dynamic }))).status).toBe("UPSTREAM_FAILURE");
    expect(await resolveArtistVideo(artist, opts({ dynamic }))).toMatchObject({ status: "NEEDS_REVIEW", dynamicLookup: "USED" });
    expect(await resolveArtistVideo(artist, opts({ dynamic }))).toMatchObject({ status: "NEEDS_REVIEW", dynamicLookup: "CACHED" });
    expect(i).toBe(3);
  });

  it("entries expire (24 h resolved, 6 h negative) and a renamed artist misses", async () => {
    let now = 0;
    const cache = createMemoryLookupCache(() => now);
    let calls = 0;
    const inner: DynamicLookup = { lookup: async () => (calls++, { kind: "resolved", video: video("AAAAAAAAAAA") }) };
    const dynamic = cachedLookup(inner, cache);
    await dynamic.lookup(artist, "e");
    now = RESOLVED_TTL_MS - 1;
    await dynamic.lookup(artist, "e");
    expect(calls).toBe(1);
    now = RESOLVED_TTL_MS + 1;
    await dynamic.lookup(artist, "e");
    expect(calls).toBe(2);
    await dynamic.lookup({ ...artist, name: "Different Name" }, "e");
    expect(calls).toBe(3);
    expect(NEGATIVE_TTL_MS).toBeLessThan(RESOLVED_TTL_MS);
  });

  it("S9.17: a fresh (deeper) lookup bypasses the cache and merges new recordings with known ones", async () => {
    let calls = 0;
    const inner: DynamicLookup = { lookup: async () => (calls++, { kind: "resolved", video: video(calls === 1 ? "AAAAAAAAAAA" : "BBBBBBBBBBB") }) };
    const dynamic = cachedLookup(inner, createMemoryLookupCache());
    await dynamic.lookup(artist, "e");
    const deeper = await dynamic.lookup(artist, "e", { fresh: true });
    expect(calls).toBe(2);
    expect(deeper.kind === "resolved" && [deeper.video.videoId, ...(deeper.alternates ?? []).map((v) => v.videoId)]).toEqual(["BBBBBBBBBBB", "AAAAAAAAAAA"]);
    const cached = await dynamic.lookup(artist, "e");
    expect(cached).toMatchObject({ cached: true, alternates: [{ videoId: "AAAAAAAAAAA" }] });
  });

  it("versions cache keys so negative entries from a stricter policy cannot suppress the credited-upload policy", () => {
    expect(RESOLVER_POLICY_VERSION).toBe("v4-context");
    expect(lookupCacheKey(artist.entityId)).toContain(`:${RESOLVER_POLICY_VERSION}:`);
    expect(lookupCacheKey(artist.entityId)).not.toBe(`tp:yt:artist:${artist.entityId}`);
  });

  it("the Redis cache uses an expiring key and degrades to a miss on outage", async () => {
    const store = new Map<string, unknown>();
    const set = vi.fn(async (k: string, v: unknown) => (store.set(k, v), "OK"));
    const client = { get: vi.fn(async (k: string) => store.get(k) ?? null), set };
    const cache = createRedisLookupCache(client as never);
    await cache.set("tp:yt:artist:X", { artistName: "X", outcome: { kind: "none" } }, 1000);
    expect(set).toHaveBeenCalledWith("tp:yt:artist:X", expect.anything(), { px: 1000 });
    expect(await cache.get("tp:yt:artist:X")).toEqual({ artistName: "X", outcome: { kind: "none" } });
    const broken = createRedisLookupCache({ get: async () => { throw new Error("down"); }, set: async () => { throw new Error("down"); } } as never);
    expect(await broken.get("k")).toBeNull();
    await expect(broken.set("k", { artistName: "X", outcome: { kind: "none" } }, 1)).resolves.toBeUndefined();
  });
});
