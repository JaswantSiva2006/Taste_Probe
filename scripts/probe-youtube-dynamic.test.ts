import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveArtistVideo } from "@/lib/music/resolver";
import { createQuotaGuard, createYouTubeDataLookup } from "@/lib/music/youtube-data";
import { createMemoryRateLimitStore } from "@/lib/reliability/rate-limit";

/**
 * Bounded live probe of the S9.9 Tier B (npm run probe:youtube). YouTube Data API only:
 * no Qloo, no Gemini. Hard cap of 8 HTTP requests (≤4 search.list = 4 units of the
 * 100/day search bucket, ≤4 videos.list = 4 of 10,000 units). The real resolver and
 * lookup code run unchanged; a counting fetch only observes. Prints outcomes and
 * channel names — never the key.
 */

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as typeof import("@next/env");
const MAX_REQUESTS = 8;
// Genuine Qloo artists (IDs/names from the S9.8 live probe) with NO reviewed mapping.
const ARTISTS = [
  { entityId: "326A36B8-4B9C-434B-87AA-2D9E6CF86369", name: "Julia Kent" },
  { entityId: "00600DB7-30AC-44DE-BB01-30D088C0E4AF", name: "Danny Norbury" },
  { entityId: "2BE4ECFD-05BF-40CB-92CA-D4514F083CD0", name: "Deaf Center" },
  { entityId: "A017F475-9F52-4884-AD5C-FDD7912A2A71", name: "Shawn Mendes" },
];

beforeAll(() => loadEnvConfig(process.cwd(), true, { info() {}, error() {} }));

describe.skipIf(process.env.PROBE_PART === "service")("bounded YouTube Data API probe", () => {
  it("resolves unmapped Qloo artists through Tier B within the cap", async () => {
    const apiKey = process.env.YOUTUBE_API_KEY?.trim();
    expect(apiKey, "YOUTUBE_API_KEY is required").toBeTruthy();
    const log: Array<Record<string, unknown>> = [];
    let requests = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (requests >= MAX_REQUESTS) throw new Error(`probe request cap ${MAX_REQUESTS} reached`);
      requests += 1;
      const url = new URL(String(input));
      const started = performance.now();
      const res = await fetch(input, init);
      const entry: Record<string, unknown> = { endpoint: url.pathname.split("/").pop(), status: res.status, ms: Math.round(performance.now() - started), keyInUrl: url.search.includes(apiKey!) };
      try {
        const body = await res.clone().json();
        if (entry.endpoint === "search") entry.channels = (body.items ?? []).map((i: { snippet?: { channelTitle?: string } }) => i.snippet?.channelTitle);
        if (entry.endpoint === "videos") entry.videos = (body.items ?? []).map((v: { id: string; snippet?: { title?: string; channelTitle?: string }; status?: { embeddable?: boolean; privacyStatus?: string } }) => ({ id: v.id, title: v.snippet?.title, channel: v.snippet?.channelTitle, embeddable: v.status?.embeddable, privacy: v.status?.privacyStatus }));
        if (body.error) entry.error = { code: body.error.code, reason: body.error.errors?.[0]?.reason, message: String(body.error.message ?? "").slice(0, 160) };
      } catch {}
      log.push(entry);
      return res;
    };
    const quota = createQuotaGuard(createMemoryRateLimitStore(), { dailySearchMax: 4, searchesPerExploration: 4, explorationWindowMs: 60_000 });
    const dynamic = createYouTubeDataLookup({ apiKey: apiKey!, timeoutMs: 8_000, quota, fetcher });

    const outcomes = [];
    for (const a of ARTISTS) {
      const r = await resolveArtistVideo({ ...a, provenance: "qloo" }, { explorationId: "probe", now: new Date(), momentReview: false, dynamic });
      outcomes.push({ artist: a.name, status: r.status, reason: r.reason, dynamicLookup: r.dynamicLookup, video: r.video && { videoId: r.video.videoId, title: r.video.title, channel: r.video.channelTitle, durationSeconds: r.video.durationSeconds } });
    }
    console.log(`YOUTUBE_PROBE ${JSON.stringify({ requests, outcomes, http: log }, null, 1)}`);
    expect(requests).toBeLessThanOrEqual(MAX_REQUESTS);
    expect(log.every((l) => l.keyInUrl === false)).toBe(true);
  });
});

// ---------------------------------------------------------------- the real server path (npm run probe:youtube -- -t service)

describe.skipIf(process.env.PROBE_PART !== "service")("service path with the real key", () => {
  it("resolveMusic: Tier B wiring, per-artist cache, in-flight dedup and the per-exploration cap", async () => {
    const { randomUUID } = await import("node:crypto");
    const { testConfig } = await import("../tests/helpers");
    const { startDiscovery } = await import("@/lib/discovery/service");
    const { resolveMusic } = await import("@/lib/music/service");
    const { createDeterministicMockAgent } = await import("@/lib/agent/mock-agent");
    const { deterministicDecision } = await import("@/lib/agent/bounded");
    const { createMemorySessionStore } = await import("@/lib/session/memory-store");
    const res = <T>(payload: T) => ({ provenance: "qloo" as const, requestId: randomUUID(), requestCount: 1, payload });
    const entities = ARTISTS.map((a, i) => ({ entity_id: a.entityId, name: a.name, subtype: "urn:entity:artist", query: { affinity: 0.9 - i * 0.01 }, tags: [] }));
    const deps = {
      config: testConfig({ QLOO_MODE: "live", QLOO_API_KEY: "fake", LLM_PROVIDER: "none", YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY!, YOUTUBE_SEARCHES_PER_EXPLORATION: "2" }),
      provider: {
        mode: "live" as const,
        searchEntities: async () => res({ results: [{ entity_id: "SEED", name: "Interstellar", types: ["urn:entity:movie"] }] }),
        getEntity: async () => res(null),
        getRecommendations: async () => res({ success: true, results: { entities } }),
      },
      agent: createDeterministicMockAgent(),
      store: createMemorySessionStore(),
      boundedAgent: {
        name: "fake",
        mode: "LIVE_GEMINI" as const,
        decide: async (context: Parameters<typeof deterministicDecision>[0]) => ({
          decision: deterministicDecision(context), mode: "LIVE_GEMINI" as const, model: "fake", requestId: randomUUID(),
          toolCalls: { allowed: [], attempted: 1, accepted: null, names: [] }, validation: "valid" as const,
          usage: { promptTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0, requests: 1, latencyMs: 0, estimatedCostUsd: 0 },
          questionCandidates: context.questions.length,
        }),
      },
    };
    const v = await startDiscovery(deps as never, { entityQuery: "Interstellar", sourceType: "movie", targetType: "music_artist", maxQuestions: 3, selectedEntityId: "SEED" });

    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      if (!u.hostname.endsWith("googleapis.com")) throw new Error(`unexpected host ${u.hostname}`);
      if (calls.length >= 4) throw new Error("service probe cap reached");
      calls.push(u.pathname.split("/").pop()!);
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const resolve = (artistId: string) => resolveMusic(deps as never, { sessionToken: v.sessionToken, artistId });
      const danny = await resolve("00600DB7-30AC-44DE-BB01-30D088C0E4AF");
      const callsAfterFirst = calls.length;
      const dannyAgain = await resolve("00600DB7-30AC-44DE-BB01-30D088C0E4AF");
      const cachedCost = calls.length - callsAfterFirst;
      const [deaf1, deaf2] = await Promise.all([resolve("2BE4ECFD-05BF-40CB-92CA-D4514F083CD0"), resolve("2BE4ECFD-05BF-40CB-92CA-D4514F083CD0")]);
      const callsBeforeCap = calls.length;
      const julia = await resolve("326A36B8-4B9C-434B-87AA-2D9E6CF86369");
      const summary = (r: Awaited<ReturnType<typeof resolve>>) => ({ artist: r.artist.name, status: r.status, reason: r.reason, dynamicLookup: r.dynamicLookup, videoId: r.video?.videoId ?? null, provenance: r.video?.provenance ?? null });
      console.log(`YOUTUBE_SERVICE_PROBE ${JSON.stringify({ calls, cachedCost, results: [danny, dannyAgain, deaf1, deaf2, julia].map(summary) }, null, 1)}`);
      expect(danny).toMatchObject({ status: "RESOLVED", dynamicLookup: "USED", video: { provenance: "youtube_data_api" } });
      expect(dannyAgain).toMatchObject({ status: "RESOLVED", dynamicLookup: "CACHED", video: { videoId: danny.video!.videoId } });
      expect(cachedCost).toBe(0); // the cache hit spent no quota and made no request
      expect(deaf1).toEqual(deaf2); // one shared lookup
      expect(callsBeforeCap).toBe(4); // 2 searches + 2 videos.list
      expect(julia).toMatchObject({ status: "RATE_LIMITED", dynamicLookup: "QUOTA_EXHAUSTED" });
      expect(calls.length).toBe(4); // the capped lookup made no request
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
