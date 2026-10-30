import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as answerRoute } from "@/app/api/discovery/answer/route";
import { POST as finishRoute } from "@/app/api/discovery/finish/route";
import { POST as rejectRoute } from "@/app/api/discovery/reject/route";
import { POST as startRoute } from "@/app/api/discovery/start/route";
import { POST as resolveRoute } from "@/app/api/music/resolve/route";
import { deterministicDecision, type AgentResult, type BoundedAgent } from "@/lib/agent/bounded";
import { createDeterministicMockAgent } from "@/lib/agent/mock-agent";
import { ApiFailureSchema, DiscoveryViewSchema, MusicResolutionSchema, apiSuccessSchema, type DiscoveryView } from "@/lib/contracts";
import { startDiscovery, type DiscoveryDeps } from "@/lib/discovery/service";
import { resolveMusic } from "@/lib/music/service";
import type { QlooProvider } from "@/lib/qloo/provider";
import type { RawInsightEntity } from "@/lib/qloo/raw-types";
import { createMemorySessionStore } from "@/lib/session/memory-store";
import { newTestSecret, testConfig } from "../helpers";

/** S9.9 POST /api/music/resolve through the real route handler (mock providers, memory store, offline). */

const BASE = "http://localhost/api";
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function view(res: Response): Promise<DiscoveryView> {
  const json = await res.json();
  expect(res.status, JSON.stringify(json.error)).toBe(200);
  return apiSuccessSchema(DiscoveryViewSchema).parse(json).data;
}
async function failure(res: Response, status: number, code: string) {
  const json = ApiFailureSchema.parse(await res.json());
  expect(json.error.code).toBe(code);
  expect(res.status).toBe(status);
}
const resolve = (sessionToken: string, artistId: string) => resolveRoute(post("/music/resolve", { sessionToken, artistId }));

const MUSIC = { entityQuery: "Interstellar", sourceType: "movie", targetType: "music_artist", maxQuestions: 3, selectedEntityId: "mock:movie:interstellar" };
const BOOKS = { ...MUSIC, targetType: "book" };

beforeEach(() => {
  vi.stubEnv("QLOO_MODE", "mock");
  vi.stubEnv("SESSION_SIGNING_SECRET", newTestSecret());
  vi.stubEnv("SESSION_STORE", "memory");
  vi.stubEnv("RATE_LIMIT_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/music/resolve (route)", () => {
  it("authorizes an artist of the exploration; synthetic artists get an honest fallback; the session is not advanced", async () => {
    const v = await view(await startRoute(post("/discovery/start", MUSIC)));
    const artist = v.recommendations[0]!.candidate;
    const res = await resolve(v.sessionToken, artist.entityId);
    expect(res.status).toBe(200);
    const r = apiSuccessSchema(MusicResolutionSchema).parse(await res.json()).data;
    expect(r).toMatchObject({ status: "UNAVAILABLE", reason: "synthetic_artist", video: null, artist: { entityId: artist.entityId, name: artist.name, provenance: "mock" } });
    expect(r.fallback.url.startsWith("https://www.youtube.com/results?")).toBe(true);
    // Read-only: the same token still drives the exploration.
    const next = v.status === "asking"
      ? await view(await answerRoute(post("/discovery/answer", { sessionToken: v.sessionToken, questionId: v.currentQuestion!.questionId, response: "unknown" })))
      : await view(await finishRoute(post("/discovery/finish", { sessionToken: v.sessionToken })));
    expect(next.revision).toBe(v.revision + 1);
  });

  it("refuses an artist that is not part of this exploration", async () => {
    const v = await view(await startRoute(post("/discovery/start", MUSIC)));
    await failure(await resolve(v.sessionToken, "5AD69C26-F5C4-482F-9C8B-E3B7432F2FDC"), 403, "ARTIST_NOT_IN_EXPLORATION");
  });

  it("refuses an artist the user set aside", async () => {
    let v = await view(await startRoute(post("/discovery/start", MUSIC)));
    if (v.status === "asking") v = await view(await finishRoute(post("/discovery/finish", { sessionToken: v.sessionToken })));
    const id = v.recommendations[0]!.candidate.entityId;
    const after = await view(await rejectRoute(post("/discovery/reject", { sessionToken: v.sessionToken, entityId: id })));
    await failure(await resolve(after.sessionToken, id), 403, "ARTIST_NOT_IN_EXPLORATION");
  });

  it("is only available for music-artist explorations", async () => {
    const v = await view(await startRoute(post("/discovery/start", BOOKS)));
    await failure(await resolve(v.sessionToken, v.recommendations[0]!.candidate.entityId), 400, "UNSUPPORTED_DOMAIN");
  });

  it("rejects forged, stale and malformed requests", async () => {
    const v = await view(await startRoute(post("/discovery/start", MUSIC)));
    const id = v.recommendations[0]!.candidate.entityId;
    await failure(await resolve(`${v.sessionToken}x`, id), 401, "INVALID_SESSION_TOKEN");
    const moved = v.status === "asking"
      ? await view(await answerRoute(post("/discovery/answer", { sessionToken: v.sessionToken, questionId: v.currentQuestion!.questionId, response: "unknown" })))
      : await view(await finishRoute(post("/discovery/finish", { sessionToken: v.sessionToken })));
    expect(moved.revision).toBe(1);
    await failure(await resolve(v.sessionToken, id), 409, "SESSION_REVISION_CONFLICT");
    await failure(await resolveRoute(post("/music/resolve", { sessionToken: v.sessionToken })), 400, "VALIDATION_ERROR");
    await failure(await resolveRoute(post("/music/resolve", { sessionToken: v.sessionToken, artistId: "x".repeat(500) })), 400, "VALIDATION_ERROR");
  });

  it("is rate limited in its own bucket", async () => {
    vi.stubEnv("RATE_LIMIT_ENABLED", "true");
    vi.stubEnv("RATE_LIMIT_RESOLVE_MAX", "2");
    vi.stubEnv("RATE_LIMIT_START_MAX", "10");
    const v = await view(await startRoute(post("/discovery/start", MUSIC)));
    const id = v.recommendations[0]!.candidate.entityId;
    expect((await resolve(v.sessionToken, id)).status).toBe(200);
    expect((await resolve(v.sessionToken, id)).status).toBe(200);
    await failure(await resolve(v.sessionToken, id), 429, "RATE_LIMITED");
  });
});

// ---------------------------------------------------------------- service level with genuine Qloo artist IDs

const artist = (id: string, name: string, affinity: number): RawInsightEntity => ({ entity_id: id, name, subtype: "urn:entity:artist", query: { affinity }, tags: [] });
// IDs and names exactly as Qloo returned them for Interstellar in the S9.8 live probe.
const ARTISTS = [
  artist("5AD69C26-F5C4-482F-9C8B-E3B7432F2FDC", "Jóhann Jóhannsson", 0.99),
  artist("0704ADB9-6270-4D71-B252-A42D8A4EAA47", "Max Richter", 0.98),
  artist("02940707-9635-45DA-B290-243F84C6B910", "Ólafur Arnalds", 0.97),
  artist("A017F475-9F52-4884-AD5C-FDD7912A2A71", "Shawn Mendes", 0.9),
];

function liveDeps(): DiscoveryDeps {
  const res = <T>(payload: T) => ({ provenance: "qloo" as const, requestId: randomUUID(), requestCount: 1, payload });
  const provider: QlooProvider = {
    mode: "live",
    async searchEntities() {
      return res({ results: [{ entity_id: "SEED-1", name: "Interstellar", types: ["urn:entity:movie"] }] });
    },
    async getEntity() {
      return res(null);
    },
    async getRecommendations() {
      return res({ success: true, results: { entities: structuredClone(ARTISTS) } });
    },
  };
  const agent: BoundedAgent = {
    name: "fake-gemini",
    mode: "LIVE_GEMINI",
    async decide(context): Promise<AgentResult> {
      return {
        decision: deterministicDecision(context),
        mode: "LIVE_GEMINI",
        model: "fake",
        requestId: randomUUID(),
        toolCalls: { allowed: [], attempted: 1, accepted: null, names: [] },
        validation: "valid",
        usage: { promptTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0, requests: 1, latencyMs: 0, estimatedCostUsd: 0 },
        questionCandidates: context.questions.length,
      };
    },
  };
  return {
    config: testConfig({ QLOO_MODE: "live", QLOO_API_KEY: "k", LLM_PROVIDER: "none" }),
    provider,
    agent: createDeterministicMockAgent(),
    store: createMemorySessionStore(),
    boundedAgent: agent,
  };
}

describe("resolveMusic with verified Qloo artists (service level)", () => {
  it("resolves the three reviewed artists to their verified videos and keeps an unmapped artist honest", async () => {
    const deps = liveDeps();
    const v = await startDiscovery(deps, { entityQuery: "Interstellar", sourceType: "movie", targetType: "music_artist", maxQuestions: 3, selectedEntityId: "SEED-1" });
    const expected: Record<string, string> = {
      "5AD69C26-F5C4-482F-9C8B-E3B7432F2FDC": "aXlx-YnvgKU",
      "0704ADB9-6270-4D71-B252-A42D8A4EAA47": "InyT9Gyoz_o",
      "02940707-9635-45DA-B290-243F84C6B910": "xpZgtFhDbss",
    };
    for (const [artistId, videoId] of Object.entries(expected)) {
      const r = MusicResolutionSchema.parse(await resolveMusic(deps, { sessionToken: v.sessionToken, artistId }, { dynamic: undefined }));
      expect(r.status).toBe("RESOLVED");
      expect(r.video?.videoId).toBe(videoId);
      expect(r.artist.provenance).toBe("qloo");
      expect(r.featuredMoment).toBeNull();
    }
    const mendes = await resolveMusic(deps, { sessionToken: v.sessionToken, artistId: "A017F475-9F52-4884-AD5C-FDD7912A2A71" }, { dynamic: undefined });
    expect(mendes).toMatchObject({ status: "UNAVAILABLE", reason: "no_reviewed_mapping", dynamicLookup: "DISABLED_NO_KEY", artist: { name: "Shawn Mendes" } });
  });

  it("with no YOUTUBE_API_KEY the dynamic tier is never constructed", async () => {
    const deps = liveDeps();
    expect(deps.config.music.youtubeApiKey).toBeUndefined();
    const v = await startDiscovery(deps, { entityQuery: "Interstellar", sourceType: "movie", targetType: "music_artist", maxQuestions: 3, selectedEntityId: "SEED-1" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await resolveMusic(deps, { sessionToken: v.sessionToken, artistId: "A017F475-9F52-4884-AD5C-FDD7912A2A71" });
    expect(r.dynamicLookup).toBe("DISABLED_NO_KEY");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("refuses moment review mode in production configuration", () => {
    expect(() =>
      testConfig({ NODE_ENV: "production", MUSIC_MOMENT_REVIEW: "true", UPSTASH_REDIS_REST_URL: "https://r.example", UPSTASH_REDIS_REST_TOKEN: "t" }),
    ).toThrow(/MUSIC_MOMENT_REVIEW/);
  });
});
