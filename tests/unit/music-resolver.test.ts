import { describe, expect, it, vi } from "vitest";
import { MusicResolutionSchema } from "@/lib/contracts";
import { REVIEWED_MAPPINGS, reviewedMappingFor } from "@/lib/music/mappings";
import { resolveArtistVideo, selectMoment, type ResolveOptions } from "@/lib/music/resolver";
import { deduplicated } from "@/lib/music/service";
import { QLOO_ENTITY_ID, YOUTUBE_VIDEO_ID, momentWithinBounds, searchUrl, watchUrl, type ReviewedMapping } from "@/lib/music/types";
import { createQuotaGuard, createYouTubeDataLookup, parseIsoDuration, type DynamicLookup, type QuotaGuard } from "@/lib/music/youtube-data";
import { createMemoryRateLimitStore } from "@/lib/reliability/rate-limit";

/** S9.9 resolver, registry and optional Data API tier. Offline: no YouTube, Qloo or Gemini calls. */

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
const videos = (items: Array<{ id: string; channel: string; embeddable?: boolean; title?: string }>) => ({
  items: items.map((i) => ({
    id: i.id,
    snippet: { title: i.title ?? "Song", channelTitle: i.channel },
    contentDetails: { duration: "PT4M5S" },
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

  it("'Official' in a title is not identity: no Topic channel → NEEDS_REVIEW", async () => {
    const { fetcher } = fakeFetch(jsonRes(search([{ id: "AAAAAAAAAAA", channel: "MusicHub" }])));
    const dynamic = createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher });
    expect(await resolveArtistVideo(unknown, opts({ dynamic }))).toMatchObject({ status: "NEEDS_REVIEW", reason: "no_topic_channel_match", video: null });
  });

  it("two Topic channels for one name are ambiguous", async () => {
    const { fetcher } = fakeFetch(
      jsonRes(search([{ id: "AAAAAAAAAAA", channel: "New Artist - Topic", channelId: "C1" }, { id: "BBBBBBBBBBB", channel: "New Artist - Topic", channelId: "C2" }])),
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
    expect(await resolveArtistVideo(unknown, opts({ dynamic }))).toMatchObject({ status: "NEEDS_REVIEW", reason: "no_embeddable_public_match" });
  });

  it("empty search → UNAVAILABLE; 403 quota → RATE_LIMITED; network error → UPSTREAM_FAILURE (no retry)", async () => {
    const empty = fakeFetch(jsonRes({ items: [] }));
    expect(await resolveArtistVideo(unknown, opts({ dynamic: createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher: empty.fetcher }) }))).toMatchObject({ status: "UNAVAILABLE", reason: "no_match" });
    const quota = fakeFetch(jsonRes({ error: { code: 403 } }, 403));
    expect(await resolveArtistVideo(unknown, opts({ dynamic: createYouTubeDataLookup({ apiKey: "k", timeoutMs: 1000, quota: okQuota, fetcher: quota.fetcher }) }))).toMatchObject({ status: "RATE_LIMITED", dynamicLookup: "QUOTA_EXHAUSTED" });
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
    await Promise.all([d.lookup("X", "e"), d.lookup("X", "e"), d.lookup("X", "e")]);
    expect(calls).toBe(1);
  });

  it("parses ISO durations", () => {
    expect(parseIsoDuration("PT6M31S")).toBe(391);
    expect(parseIsoDuration("PT1H")).toBe(3600);
    expect(parseIsoDuration("P1D")).toBeUndefined();
  });
});
