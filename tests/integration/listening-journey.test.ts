import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as answerRoute } from "@/app/api/discovery/answer/route";
import { POST as feedbackRoute } from "@/app/api/discovery/feedback/route";
import { POST as finishRoute } from "@/app/api/discovery/finish/route";
import { POST as listenRoute } from "@/app/api/discovery/listen/route";
import { POST as startRoute } from "@/app/api/discovery/start/route";
import { ApiFailureSchema, DiscoveryViewSchema, SavedDiscoverySchema, apiSuccessSchema, type DiscoveryView } from "@/lib/contracts";
import { REVIEWED_MAPPINGS } from "@/lib/music/mappings";
import { newTestSecret } from "../helpers";

/**
 * S9.12 listening loop through the REAL HTTP route handlers in live mode. External
 * providers are mocked at the fetch boundary only: a Qloo stub (search + Insights) and
 * a Gemini stub that answers the decision agent and the song selector. No YouTube key,
 * so recordings come from the reviewed registry. Memory session store. Offline.
 */

const INTERSTELLAR = "057DA9D9-399B-437E-8BCA-A80E499125EF";
const A = {
  johann: "5AD69C26-F5C4-482F-9C8B-E3B7432F2FDC",
  richter: "0704ADB9-6270-4D71-B252-A42D8A4EAA47",
  olafur: "02940707-9635-45DA-B290-243F84C6B910",
  goldmund: "D7918037-2D25-4990-BC34-4502B136E5AE",
  eluvium: "08ADBAF0-7267-4239-BCF8-DAD243B09BFC",
  mendes: "A017F475-9F52-4884-AD5C-FDD7912A2A71",
  frahm: "0D8EAFA4-CEEA-44D5-8E1F-26A8A9F49A77",
};
const NAMES: Record<string, string> = {
  [A.johann]: "Jóhann Jóhannsson", [A.richter]: "Max Richter", [A.olafur]: "Ólafur Arnalds", [A.goldmund]: "Goldmund",
  [A.eluvium]: "Eluvium", [A.mendes]: "Shawn Mendes", [A.frahm]: "Nils Frahm",
};
const AMBIENT = { id: "urn:tag:genre:qloo:ambient", name: "Ambient", type: "urn:tag:genre:qloo" };
const PIANO = { id: "urn:tag:instrument:qloo:piano", name: "Piano", type: "urn:tag:instrument:qloo" };
const artist = (id: string, affinity: number, tags = [AMBIENT, PIANO]) => ({ entity_id: id, name: NAMES[id], subtype: "urn:entity:artist", query: { affinity }, tags: tags.map((t) => ({ id: t.id, name: t.name, type: t.type })) });
const BASE_ARTISTS = [artist(A.johann, 0.99), artist(A.richter, 0.98), artist(A.olafur, 0.97), artist(A.goldmund, 0.96, [AMBIENT]), artist(A.eluvium, 0.95, [AMBIENT]), artist(A.mendes, 0.9, [PIANO])];
const REGISTRY_VIDEO_IDS = new Set(REVIEWED_MAPPINGS.flatMap((m) => [m.primary, ...m.alternates].map((v) => v.videoId)));

type Calls = { qlooSearch: number; qlooInsights: number; geminiDecision: number; geminiSong: number; youtube: number; other: string[] };
let calls: Calls;
/** How the stubbed Gemini answers song selection: pick the LAST eligible ID (so it differs from the deterministic first). */
let songBehaviour: "last" | "unknown_id" | "malformed" = "last";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const geminiCall = (name: string, args: Record<string, unknown>) => ({
  candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }],
  usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 20, totalTokenCount: 420 },
});

function stubFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "qloo.test" && url.pathname === "/search") {
      calls.qlooSearch += 1;
      return json({ results: [{ entity_id: INTERSTELLAR, name: "Interstellar", types: ["urn:entity:movie"], properties: { release_year: 2014 } }] });
    }
    if (url.hostname === "qloo.test" && url.pathname === "/v2/insights") {
      calls.qlooInsights += 1;
      const signal = url.searchParams.get("signal.interests.entities") ?? "";
      // A profile refresh (anchor + a liked artist) also returns a new verified artist.
      const entities = signal.includes(",") ? [...BASE_ARTISTS, artist(A.frahm, 0.985)] : BASE_ARTISTS;
      return json({ success: true, results: { entities } });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      const body = JSON.parse(String(init?.body)) as { tools: Array<{ functionDeclarations: Array<{ name: string; parameters: { properties: Record<string, { enum?: string[] }> } }> }>; toolConfig: { functionCallingConfig: { allowedFunctionNames: string[] } } };
      const decls = body.tools[0]!.functionDeclarations;
      const song = decls.find((d) => d.name === "select_verified_song");
      if (song) {
        calls.geminiSong += 1;
        const ids = song.parameters.properties.videoId!.enum!;
        if (songBehaviour === "malformed") return json({ candidates: [{ content: { parts: [{ text: "I think the second one sounds dreamier." }] } }] });
        return json(geminiCall("select_verified_song", { videoId: songBehaviour === "unknown_id" ? "ZZZZZZZZZZZ" : ids.at(-1), reasonCode: "closest_to_loved_recordings" }));
      }
      calls.geminiDecision += 1;
      const allowed = body.toolConfig.functionCallingConfig.allowedFunctionNames;
      if (allowed.includes("ask_question")) {
        const q = decls.find((d) => d.name === "ask_question")!.parameters.properties.questionId!.enum![0];
        return json(geminiCall("ask_question", { questionId: q, reasonCode: "informative_question" }));
      }
      return json(geminiCall("finish_discovery", { reasonCode: "stable_recommendations" }));
    }
    if (url.hostname.endsWith("googleapis.com")) calls.youtube += 1;
    calls.other.push(url.hostname);
    throw new Error(`unexpected network call to ${url.hostname}`);
  });
}

const BASE = "http://localhost/api";
const post = (path: string, body: unknown) => new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function ok(res: Response): Promise<DiscoveryView> {
  const body = await res.json();
  expect(res.status, JSON.stringify(body.error)).toBe(200);
  return apiSuccessSchema(DiscoveryViewSchema).parse(body).data;
}
async function fail(res: Response, status: number, code: string) {
  const body = ApiFailureSchema.parse(await res.json());
  expect(body.error.code).toBe(code);
  expect(res.status).toBe(status);
}
const listen = (v: DiscoveryView, artistId?: string) => listenRoute(post("/discovery/listen", artistId ? { sessionToken: v.sessionToken, artistId } : { sessionToken: v.sessionToken }));
const act = (v: DiscoveryView, action: string, extra: Record<string, unknown> = {}) =>
  feedbackRoute(post("/discovery/feedback", { sessionToken: v.sessionToken, artistId: v.listening!.artist!.entityId, videoId: v.listening!.video!.videoId, action, ...extra }));

/** Interstellar → music artists: start (asks), answer "like", finish. Returns the presenting view. */
async function explore(): Promise<DiscoveryView> {
  let v = await ok(await startRoute(post("/discovery/start", { entityQuery: "Interstellar", sourceType: "movie", targetType: "music_artist", maxQuestions: 3, selectedEntityId: INTERSTELLAR })));
  if (v.status === "asking") {
    const q = v.currentQuestion!;
    v = await ok(await answerRoute(post("/discovery/answer", { sessionToken: v.sessionToken, questionId: q.questionId, response: q.targetType === "tag" ? "like" : "prefer_a" })));
  }
  if (v.status === "asking") v = await ok(await finishRoute(post("/discovery/finish", { sessionToken: v.sessionToken })));
  expect(v.status).toBe("finished");
  return v;
}

beforeEach(() => {
  calls = { qlooSearch: 0, qlooInsights: 0, geminiDecision: 0, geminiSong: 0, youtube: 0, other: [] };
  songBehaviour = "last";
  for (const [k, val] of Object.entries({
    NODE_ENV: "test", QLOO_MODE: "live", QLOO_API_KEY: "qloo-test-key", QLOO_BASE_URL: "https://qloo.test",
    LLM_PROVIDER: "google", LLM_MODEL: "gemini-3.5-flash-lite", GOOGLE_API_KEY: "gemini-test-key", YOUTUBE_API_KEY: "",
    SESSION_STORE: "memory", SESSION_SIGNING_SECRET: newTestSecret(), RATE_LIMIT_ENABLED: "false", ADAPTIVE_POOL_ENABLED: "false",
  })) vi.stubEnv(k, val);
  stubFetch();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("S9.12 listening journey over HTTP", () => {
  it("Interstellar → Gemini-chosen verified song → NOT_FOR_ME → ANOTHER_SONG → DIFFERENT_ARTIST → LOVE → SAVE → FINISH", async () => {
    const programme = await explore();
    const explorationId = programme.sessionId;
    const qlooAfterExplore = calls.qlooSearch + calls.qlooInsights;
    const tagLikes = programme.preferences.positiveTagIds;
    expect(tagLikes.length + programme.preferences.positiveEntityIds.length).toBeGreaterThan(0); // explicit evidence exists

    // 1. Listen to Jóhann Jóhannsson: 3 verified recordings, Gemini chooses one (the last, validated).
    const s1 = await ok(await listen(programme, A.johann));
    expect(s1.revision).toBe(programme.revision + 1);
    expect(s1.listening).toMatchObject({ status: "listening", artist: { entityId: A.johann }, verifiedSongCount: 3, selection: { mode: "GEMINI", eligibleCount: 3, fallbackReason: null } });
    const first = s1.listening!.video!;
    expect(first.videoId).toBe("dCWbVxfkoKg");
    expect(first.artistId).toBe(A.johann);
    expect(calls.geminiSong).toBe(1);

    // 2. NOT_FOR_ME is a track reaction: artist kept, nothing moves.
    const s2 = await ok(await act(s1, "NOT_FOR_ME"));
    expect(s2.revision).toBe(s1.revision + 1);
    expect(s2.listening).toMatchObject({ currentFeedback: "not_for_me", notice: "recording_disliked_choose_next", artist: { entityId: A.johann }, video: { videoId: first.videoId } });
    expect(s2.preferences.rejectedEntityIds).not.toContain(A.johann);
    expect(s2.recommendations.map((r) => r.candidate.entityId)).toContain(A.johann);

    // 3. ANOTHER_SONG: same artist, a different verified recording, no Qloo call.
    const qlooBefore = calls.qlooInsights;
    const s3 = await ok(await act(s2, "ANOTHER_SONG"));
    expect(s3.listening!.artist!.entityId).toBe(A.johann);
    const second = s3.listening!.video!;
    expect(second.videoId).not.toBe(first.videoId);
    expect(s3.listening!.selection).toMatchObject({ mode: "GEMINI", eligibleCount: 2 });
    expect(calls.qlooInsights).toBe(qlooBefore);

    // Replay of the previous token (double click) is refused; nothing advances twice.
    await fail(await act(s2, "ANOTHER_SONG"), 409, "SESSION_REVISION_CONFLICT");

    // 4. DIFFERENT_ARTIST: the next verified artist in programme order.
    const s4 = await ok(await act(s3, "DIFFERENT_ARTIST"));
    const nextArtist = s4.listening!.artist!.entityId;
    expect(nextArtist).not.toBe(A.johann);
    expect(programme.recommendations.map((r) => r.candidate.entityId)).toContain(nextArtist);
    const third = s4.listening!.video!;
    expect(third.artistId).toBe(nextArtist);
    // The previous artist's recording is no longer accepted.
    await fail(await feedbackRoute(post("/discovery/feedback", { sessionToken: s4.sessionToken, artistId: A.johann, videoId: second.videoId, action: "LOVE" })), 409, "LISTENING_STATE_CONFLICT");
    // A forged (well-formed) video ID is refused.
    await fail(await feedbackRoute(post("/discovery/feedback", { sessionToken: s4.sessionToken, artistId: nextArtist, videoId: "ZZZZZZZZZZZ", action: "SAVE" })), 409, "LISTENING_STATE_CONFLICT");

    // 5. LOVE (track) → 6. SAVE → duplicate SAVE does not duplicate.
    const s5 = await ok(await act(s4, "LOVE"));
    expect(s5.listening!.currentFeedback).toBe("love");
    expect(s5.preferences.positiveEntityIds).not.toContain(nextArtist); // a track love is not an artist endorsement
    const s6 = await ok(await act(s5, "SAVE"));
    expect(s6.listening!.saved).toHaveLength(1);
    await fail(await act(s5, "SAVE"), 409, "SESSION_REVISION_CONFLICT");
    const s6b = await ok(await act(s6, "SAVE"));
    expect(s6b.listening).toMatchObject({ notice: "already_saved" });
    expect(s6b.listening!.saved).toHaveLength(1);
    const saved = SavedDiscoverySchema.parse(s6b.listening!.saved[0]);
    expect(saved).toMatchObject({ artist: { qlooId: nextArtist, name: NAMES[nextArtist], provenance: "qloo" }, video: { videoId: third.videoId, provenance: "reviewed_mapping" }, anchor: { qlooId: INTERSTELLAR, name: "Interstellar", domain: "movie" } });

    // 7. FINISH: summary with exactly the saved recording; later actions are refused.
    const done = await ok(await act(s6b, "FINISH"));
    expect(done.listening).toMatchObject({ status: "finished", notice: "finished" });
    await fail(await act(done, "NEXT"), 409, "LISTENING_FINISHED");

    // Cumulative context and identity.
    for (const v of [s1, s2, s3, s4, s5, s6, s6b, done]) expect(v.sessionId).toBe(explorationId);
    expect([s1, s2, s3, s4, s5, s6, s6b, done].map((v) => v.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => programme.revision + n));
    expect(done.preferences.positiveTagIds).toEqual(tagLikes); // question answers survive listening
    expect(done.listening!.history.map((h) => [h.artistId, h.videoId, h.feedback])).toEqual([
      [A.johann, first.videoId, "not_for_me"],
      [A.johann, second.videoId, null],
      [nextArtist, third.videoId, "love"],
    ]);
    for (const h of done.listening!.history) expect(REGISTRY_VIDEO_IDS.has(h.videoId)).toBe(true);
    expect(new Set(done.listening!.history.map((h) => h.videoId)).size).toBe(3);
    // Provider accounting: no Qloo for listening, Gemini only for song choices, no YouTube Data API.
    expect(calls.qlooSearch + calls.qlooInsights).toBe(qlooAfterExplore);
    expect(done.usage.geminiRequestCount).toBe(calls.geminiDecision + calls.geminiSong);
    expect(done.listening!.geminiSongRequests).toBe(calls.geminiSong);
    expect(calls.youtube).toBe(0);
    expect(calls.other).toEqual([]);
  });

  it("invalid Gemini output never enters the system: unknown ID and malformed output fall back deterministically", async () => {
    const programme = await explore();
    songBehaviour = "unknown_id";
    const v1 = await ok(await listen(programme, A.johann));
    expect(v1.listening!.selection).toMatchObject({ mode: "DETERMINISTIC", fallbackReason: "gemini_invalid_video_id" });
    expect(v1.listening!.video!.videoId).toBe("aXlx-YnvgKU"); // registry primary
    songBehaviour = "malformed";
    const v2 = await ok(await act(v1, "ANOTHER_SONG"));
    expect(v2.listening!.selection).toMatchObject({ mode: "DETERMINISTIC", fallbackReason: "gemini_missing_function_call" });
    expect(REGISTRY_VIDEO_IDS.has(v2.listening!.video!.videoId)).toBe(true);
    expect(v2.usage.geminiRequestCount).toBe(calls.geminiDecision + calls.geminiSong); // failed calls still charged
  });

  it("single verified recording: no Gemini call, ANOTHER_SONG says so; NEXT is neutral; finish with zero saves", async () => {
    const programme = await explore();
    const before = calls.geminiSong;
    const v1 = await ok(await listen(programme, A.eluvium));
    expect(v1.listening).toMatchObject({ verifiedSongCount: 1, selection: { mode: "SINGLE_OPTION" } });
    expect(calls.geminiSong).toBe(before);
    const v2 = await ok(await act(v1, "ANOTHER_SONG"));
    expect(v2.listening).toMatchObject({ notice: "only_one_verified_song", artist: { entityId: A.eluvium }, video: { videoId: v1.listening!.video!.videoId } });
    const v3 = await ok(await act(v2, "NEXT"));
    expect(v3.listening!.artist!.entityId).not.toBe(A.eluvium);
    expect(v3.preferences).toEqual(v2.preferences); // NEXT records no preference
    expect(v3.listening!.history[0]!.feedback).toBeNull();
    const done = await ok(await act(v3, "FINISH"));
    expect(done.listening).toMatchObject({ status: "finished", notice: "finished_without_saves", saved: [] });
  });

  it("an unmapped artist is reported truthfully; explicit NOT_THIS_ARTIST is the only artist rejection", async () => {
    const programme = await explore();
    const v1 = await ok(await listen(programme, A.mendes));
    expect(v1.listening).toMatchObject({ status: "no_verified_song", video: null, notice: "no_verified_song", artist: { entityId: A.mendes } });
    const v2 = await ok(await listen(v1, A.richter));
    const v3 = await ok(await act(v2, "NOT_FOR_ME", { artistIntent: "NOT_THIS_ARTIST" }));
    expect(v3.preferences.rejectedEntityIds).toContain(A.richter);
    expect(v3.listening!.artist!.entityId).not.toBe(A.richter);
    await fail(await listen(v3, A.richter), 403, "ARTIST_NOT_IN_EXPLORATION");
    await fail(await listen(v3, "00000000-0000-4000-8000-000000000000"), 403, "ARTIST_NOT_IN_EXPLORATION");
  });

  it("explicit LIKE_ARTIST feeds the S9.11 controller (one PROFILE_REFRESH); song changes never call Qloo", async () => {
    vi.stubEnv("ADAPTIVE_POOL_ENABLED", "true");
    const programme = await explore();
    const v1 = await ok(await listen(programme, A.johann));
    const insightsBefore = calls.qlooInsights;
    const v2 = await ok(await act(v1, "ANOTHER_SONG"));
    expect(calls.qlooInsights).toBe(insightsBefore);
    const v3 = await ok(await act(v2, "LOVE", { artistIntent: "LIKE_ARTIST" }));
    expect(v3.preferences.positiveEntityIds).toContain(A.johann);
    expect(calls.qlooInsights).toBe(insightsBefore + 1);
    expect(v3.usage.qlooCallCount).toBeLessThanOrEqual(v3.usage.maxQlooCalls);
    // Track history survives the retrieval; the new verified artist is now reachable.
    expect(v3.listening!.history.map((h) => h.videoId)).toEqual(v2.listening!.history.map((h) => h.videoId));
    expect(v3.listening!.currentFeedback).toBe("love");
    // A second like of the same artist is a duplicate plan: no further Qloo call.
    const v4 = await ok(await act(v3, "LOVE", { artistIntent: "LIKE_ARTIST" }));
    expect(calls.qlooInsights).toBe(insightsBefore + 1);
    expect(v4.listening!.history).toHaveLength(2);
  });

  it("two concurrent actions on the same revision: exactly one commits", async () => {
    const v1 = await ok(await listen(await explore(), A.johann));
    const results = await Promise.all([act(v1, "NEXT"), act(v1, "NEXT"), act(v1, "SAVE")]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(2);
  });

  it("rejects listening before results, on non-music explorations, and with forged tokens", async () => {
    const asking = await ok(await startRoute(post("/discovery/start", { entityQuery: "Interstellar", sourceType: "movie", targetType: "music_artist", maxQuestions: 3, selectedEntityId: INTERSTELLAR })));
    if (asking.status === "asking") await fail(await listen(asking), 409, "ROUND_IN_PROGRESS");
    const programme = await explore();
    await fail(await listenRoute(post("/discovery/listen", { sessionToken: `${programme.sessionToken}x` })), 401, "INVALID_SESSION_TOKEN");
    await fail(await feedbackRoute(post("/discovery/feedback", { sessionToken: programme.sessionToken, artistId: A.johann, videoId: "aXlx-YnvgKU", action: "LOVE" })), 409, "LISTENING_NOT_STARTED");
    await fail(await feedbackRoute(post("/discovery/feedback", { sessionToken: programme.sessionToken, artistId: A.johann, videoId: "../../etc", action: "LOVE" })), 400, "VALIDATION_ERROR");
  });
});
