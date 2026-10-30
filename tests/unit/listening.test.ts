import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { deterministicDecision, type AgentResult, type BoundedAgent } from "@/lib/agent/bounded";
import { GeminiTransportError } from "@/lib/agent/gemini-transport";
import { createDeterministicMockAgent } from "@/lib/agent/mock-agent";
import { buildSongRequest, createGeminiSongSelector, interpretSongResponse, type SongSelector } from "@/lib/agent/song-selector";
import type { VerifiedSongOption } from "@/lib/contracts";
import { continueExploration, finishDiscovery, listeningFeedback, startDiscovery, startListening, type DiscoveryDeps } from "@/lib/discovery/service";
import { deterministicSong, eligibleOptions, emptyListening, optionsFrom, withTrackFeedback } from "@/lib/music/listening";
import { resolveArtistVideo } from "@/lib/music/resolver";
import type { QlooProvider } from "@/lib/qloo/provider";
import type { RawInsightEntity } from "@/lib/qloo/raw-types";
import { createMemorySessionStore } from "@/lib/session/memory-store";
import type { SessionStore } from "@/lib/session/store";
import { testConfig } from "../helpers";

/** S9.12 song options, selector validation, fallbacks and service edge cases. Offline. */

const JOHANN = "5AD69C26-F5C4-482F-9C8B-E3B7432F2FDC";
const RICHTER = "0704ADB9-6270-4D71-B252-A42D8A4EAA47";
const opt = (videoId: string, provenance: VerifiedSongOption["provenance"] = "reviewed_mapping", artistId = JOHANN): VerifiedSongOption => ({
  artistId, videoId, title: `T ${videoId}`, channelTitle: "C", channelKind: "topic", provenance, watchUrl: `https://www.youtube.com/watch?v=${videoId}`, verifiedAt: "2026-10-30",
});

describe("verified song options", () => {
  it("come only from a RESOLVED resolution: primary first, alternates, bounded, tagged with the Qloo artist", async () => {
    const r = await resolveArtistVideo({ entityId: JOHANN, name: "Jóhann Jóhannsson", provenance: "qloo" }, { explorationId: "e", now: new Date("2026-10-30T12:00:00Z"), momentReview: false });
    const options = optionsFrom(r);
    expect(options.map((o) => o.videoId)).toEqual(["aXlx-YnvgKU", "mPvqle7mF-U", "dCWbVxfkoKg"]);
    expect(options.every((o) => o.artistId === JOHANN && o.provenance === "reviewed_mapping")).toBe(true);
    expect(optionsFrom({ ...r, status: "NEEDS_REVIEW", video: null })).toEqual([]);
  });

  it("eligible = not current, not heard, not disliked; deterministic prefers reviewed, then registry order", () => {
    let l = emptyListening();
    l = { ...l, encounters: [{ artistId: JOHANN, artistName: "J", videoId: "BBBBBBBBBBB", title: "b", at: 0, revision: 1, selection: "DETERMINISTIC" }] };
    l = withTrackFeedback(l, { artistId: JOHANN, videoId: "CCCCCCCCCCC", action: "not_for_me", at: 0, revision: 2 });
    const options = [opt("AAAAAAAAAAA"), opt("BBBBBBBBBBB"), opt("CCCCCCCCCCC"), opt("DDDDDDDDDDD", "youtube_data_api"), opt("EEEEEEEEEEE")];
    const eligible = eligibleOptions(l, options, "AAAAAAAAAAA");
    expect(eligible.map((o) => o.videoId)).toEqual(["DDDDDDDDDDD", "EEEEEEEEEEE"]);
    expect(deterministicSong(eligible)!.videoId).toBe("EEEEEEEEEEE");
    expect(deterministicSong([])).toBeNull();
  });
});

describe("Gemini song-selection validation", () => {
  const ids = ["aXlx-YnvgKU", "mPvqle7mF-U"];
  const call = (args: Record<string, unknown>, name = "select_verified_song") => ({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] });

  it("accepts only an eligible ID with an allowed reason", () => {
    expect(interpretSongResponse(call({ videoId: "mPvqle7mF-U", reasonCode: "fits_confirmed_preferences" }), ids)).toEqual({ videoId: "mPvqle7mF-U", reasonCode: "fits_confirmed_preferences" });
    expect(interpretSongResponse(call({ videoId: "InyT9Gyoz_o", reasonCode: "fits_confirmed_preferences" }), ids)).toEqual({ error: "invalid_video_id" }); // another artist's verified video
    expect(interpretSongResponse(call({ videoId: "ZZZZZZZZZZZ", reasonCode: "fits_confirmed_preferences" }), ids)).toEqual({ error: "invalid_video_id" });
    expect(interpretSongResponse(call({ videoId: ids[0], reasonCode: "it_sounds_dreamy" }), ids)).toEqual({ error: "invalid_reason" });
    expect(interpretSongResponse(call({ videoId: ids[0], reasonCode: "fits_confirmed_preferences" }, "ask_question"), ids)).toEqual({ error: "missing_function_call" });
    expect(interpretSongResponse({ candidates: [{ content: { parts: [{ text: "Play the second one" }] } }] }, ids)).toEqual({ error: "missing_function_call" });
    expect(interpretSongResponse("not json", ids)).toEqual({ error: "malformed" });
  });

  it("the request enumerates only verified IDs, states the model has not listened, and asks for no free text", () => {
    const req = buildSongRequest(
      { sessionRef: "s", anchor: { name: "Interstellar", domain: "movie" }, artist: { entityId: JOHANN, name: "J" }, options: [opt(ids[0]!), opt(ids[1]!)], lovedRecordings: [], dislikedRecordings: [{ artistName: "J", title: "x" }], confirmedLikes: ["Ambient"], confirmedDislikes: [] },
      0.2,
    );
    const decl = req.tools[0]!.functionDeclarations[0]!;
    expect(decl.parameters.properties.videoId.enum).toEqual(ids);
    expect(Object.keys(decl.parameters.properties)).toEqual(["videoId", "reasonCode"]);
    expect(req.systemInstruction.parts[0]!.text).toMatch(/NOT listened/);
    expect(req.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(["select_verified_song"]);
  });

  it("timeouts and HTTP errors are failures (one request, no retry)", async () => {
    const timeout = createGeminiSongSelector({ model: "gemini-3.5-flash-lite", temperature: 0.2, timeoutMs: 10, transport: async () => { throw new GeminiTransportError("timeout"); } });
    const input = { sessionRef: "s", anchor: { name: "I", domain: "movie" }, artist: { entityId: JOHANN, name: "J" }, options: [opt(ids[0]!), opt(ids[1]!)], lovedRecordings: [], dislikedRecordings: [], confirmedLikes: ["Ambient"], confirmedDislikes: [] };
    expect(await timeout.select(input)).toMatchObject({ ok: false, error: "timeout", requests: 1 });
    const transport = vi.fn(async () => ({ status: 429, body: {} }));
    const limited = createGeminiSongSelector({ model: "gemini-3.5-flash-lite", temperature: 0.2, timeoutMs: 10, transport });
    expect(await limited.select(input)).toMatchObject({ ok: false, error: "http_error" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- service level (fake Qloo + fake Gemini)

const TAGS = [
  { id: "urn:tag:genre:qloo:ambient", name: "Ambient", type: "urn:tag:genre:qloo" },
  { id: "urn:tag:instrument:qloo:piano", name: "Piano", type: "urn:tag:instrument:qloo" },
  { id: "urn:tag:genre:qloo:minimalism", name: "Minimalism", type: "urn:tag:genre:qloo" },
];
const artist = (id: string, name: string, affinity: number, tags = TAGS): RawInsightEntity => ({ entity_id: id, name, subtype: "urn:entity:artist", query: { affinity }, tags });
const ARTISTS = [
  artist(JOHANN, "Jóhann Jóhannsson", 0.99),
  artist(RICHTER, "Max Richter", 0.98),
  ...["A", "B", "C", "D", "E", "F", "G", "H"].map((x, i) => artist(`${x}0000000-0000-4000-8000-000000000000`, `Artist ${x}`, 0.9 - i * 0.01, [TAGS[i % 3]!])),
];

function deps(opts: { geminiPerDecision?: number; maxGemini?: string; selector?: SongSelector; store?: SessionStore; now?: () => number } = {}): DiscoveryDeps {
  const res = <T>(payload: T) => ({ provenance: "qloo" as const, requestId: randomUUID(), requestCount: 1, payload });
  const provider: QlooProvider = {
    mode: "live",
    searchEntities: async () => res({ results: [{ entity_id: "SEED", name: "Interstellar", types: ["urn:entity:movie"] }] }),
    getEntity: async () => res(null),
    getRecommendations: async () => res({ success: true, results: { entities: structuredClone(ARTISTS) } }),
  };
  const agent: BoundedAgent = {
    name: "fake-gemini",
    mode: "LIVE_GEMINI",
    async decide(context): Promise<AgentResult> {
      return {
        decision: deterministicDecision(context), mode: "LIVE_GEMINI", model: "fake", requestId: randomUUID(),
        toolCalls: { allowed: [], attempted: 1, accepted: null, names: [] }, validation: "valid",
        usage: { promptTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0, requests: opts.geminiPerDecision ?? 1, latencyMs: 0, estimatedCostUsd: 0 },
        questionCandidates: context.questions.length,
      };
    },
  };
  return {
    config: testConfig({ QLOO_MODE: "live", QLOO_API_KEY: "k", LLM_PROVIDER: "none", ...(opts.maxGemini ? { MAX_GEMINI_REQUESTS_PER_EXPLORATION: opts.maxGemini } : {}) }),
    provider, agent: createDeterministicMockAgent(), store: opts.store ?? createMemorySessionStore(), boundedAgent: agent,
    ...(opts.selector ? { songSelector: opts.selector } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  };
}
const START = { entityQuery: "Interstellar", sourceType: "movie" as const, targetType: "music_artist" as const, maxQuestions: 3 as const, selectedEntityId: "SEED" };
async function presenting(d: DiscoveryDeps) {
  const v = await startDiscovery(d, START);
  return v.status === "finished" ? v : finishDiscovery(d, v.sessionToken);
}
const spySelector = (): SongSelector & { select: ReturnType<typeof vi.fn> } => ({
  model: "fake",
  select: vi.fn(async (input) => ({ ok: true as const, videoId: input.options.at(-1)!.videoId, reasonCode: "fits_confirmed_preferences" as const, requests: 1, usage: { promptTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 }, costUsd: 0, latencyMs: 1, requestId: "r" })),
});

describe("listening service", () => {
  it("no explicit evidence → deterministic first verified recording, no Gemini call", async () => {
    const selector = spySelector();
    const d = deps({ selector });
    const v = await startListening(d, { sessionToken: (await presenting(d)).sessionToken, artistId: JOHANN });
    expect(v.listening!.selection).toMatchObject({ mode: "DETERMINISTIC", fallbackReason: "insufficient_evidence" });
    expect(v.listening!.video!.videoId).toBe("aXlx-YnvgKU");
    expect(selector.select).not.toHaveBeenCalled();
  });

  it("track evidence enables Gemini; an exhausted exploration Gemini budget falls back without calling it", async () => {
    const selector = spySelector();
    const d = deps({ selector });
    const v1 = await startListening(d, { sessionToken: (await presenting(d)).sessionToken, artistId: JOHANN });
    const v2 = await listeningFeedback(d, { sessionToken: v1.sessionToken, artistId: JOHANN, videoId: v1.listening!.video!.videoId, action: "NOT_FOR_ME" });
    const v3 = await listeningFeedback(d, { sessionToken: v2.sessionToken, artistId: JOHANN, videoId: v1.listening!.video!.videoId, action: "ANOTHER_SONG" });
    expect(v3.listening!.selection!.mode).toBe("GEMINI");
    expect(selector.select).toHaveBeenCalledTimes(1);
    const input = selector.select.mock.calls[0]![0];
    expect(input.dislikedRecordings).toEqual([{ artistName: "Jóhann Jóhannsson", title: "Jóhannsson: Flight from the City" }]);
    expect(input.options.map((o: VerifiedSongOption) => o.videoId)).toEqual(["mPvqle7mF-U", "dCWbVxfkoKg"]); // disliked one excluded

    const tight = spySelector();
    const d2 = deps({ selector: tight, geminiPerDecision: 2, maxGemini: "2" });
    const w1 = await startListening(d2, { sessionToken: (await presenting(d2)).sessionToken, artistId: JOHANN });
    const w2 = await listeningFeedback(d2, { sessionToken: w1.sessionToken, artistId: JOHANN, videoId: w1.listening!.video!.videoId, action: "NOT_FOR_ME" });
    const w3 = await listeningFeedback(d2, { sessionToken: w2.sessionToken, artistId: JOHANN, videoId: w1.listening!.video!.videoId, action: "ANOTHER_SONG" });
    expect(w3.listening!.selection).toMatchObject({ mode: "DETERMINISTIC", fallbackReason: "exploration_gemini_budget_exhausted" });
    expect(tight.select).not.toHaveBeenCalled();
  });

  it("listening history survives a new question round; the three-question cap is per round, not per song", async () => {
    const d = deps();
    const v1 = await startListening(d, { sessionToken: (await presenting(d)).sessionToken, artistId: JOHANN });
    const v2 = await listeningFeedback(d, { sessionToken: v1.sessionToken, artistId: JOHANN, videoId: v1.listening!.video!.videoId, action: "LOVE" });
    const round2 = await continueExploration(d, { sessionToken: v2.sessionToken });
    expect(round2.listening!.history).toEqual(v2.listening!.history);
    expect(round2.listening!.currentFeedback).toBe("love");
  });

  it("expired sessions and a failing store are refused without provider work", async () => {
    let now = Date.now();
    const selector = spySelector();
    const d = deps({ selector, now: () => now });
    const p = await presenting(d);
    now += 31 * 60_000;
    await expect(startListening(d, { sessionToken: p.sessionToken, artistId: JOHANN })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    const base = createMemorySessionStore();
    const healthy = deps({ store: base });
    const ok = await presenting(healthy);
    const broken: SessionStore = { ...base, kind: base.kind, read: async () => { throw new Error("redis down"); } } as SessionStore;
    await expect(startListening({ ...healthy, store: broken, songSelector: selector }, { sessionToken: ok.sessionToken, artistId: JOHANN })).rejects.toBeTruthy();
    expect(selector.select).not.toHaveBeenCalled();
  });
});
