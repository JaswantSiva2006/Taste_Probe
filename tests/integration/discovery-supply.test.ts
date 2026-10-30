import { describe, it, expect, vi } from "vitest";
import type { DiscoveryView, ListeningAction } from "@/lib/contracts";
import { startListening, listeningFeedback } from "@/lib/discovery/service";
import { supplyFixture, supplyArtist, supplyVideo } from "../helpers/discovery-supply";
import { initializeAdaptivePool } from "@/lib/discovery/adaptive-pool";
import type { RecommendationRequest } from "@/lib/qloo/provider";

const act = (f: ReturnType<typeof supplyFixture>, v: DiscoveryView, action: ListeningAction) => listeningFeedback(f.deps, { sessionToken: v.sessionToken, artistId: v.listening!.video!.artistId, videoId: v.listening!.video!.videoId, action });
describe("S9.16R supply controller inside signed session transactions", () => {
  it("keeps all six recordings for every artist at full reservoir capacity", async () => {
    const f = supplyFixture(90, 90, 6);
    const v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const loaded = await f.sessions.load(v.sessionToken);
    expect(loaded.state.listening!.inventory).toHaveLength(540);
    expect(Buffer.byteLength(JSON.stringify(loaded.state))).toBeLessThan(1_000_000);
    console.log("S9_16R_FULL_RECORDING_STATE_BYTES", Buffer.byteLength(JSON.stringify(loaded.state)));
  });
  it.each(["dislike10", "next15", "love5", "mixed20"])("%s: global unseen inventory sustains distinct recommendations beyond top five", async (sequence) => {
    const f = supplyFixture();
    // Supply retrieval is unexpected with adequate local supply; S9.18 taste-walk queries seeded by loved artists are allowed.
    const requests: RecommendationRequest[] = [];
    f.deps.provider.getRecommendations = vi.fn(async (request: RecommendationRequest) => { requests.push(request); throw new Error("FIXTURE: walk query unanswered"); });
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const videos = new Set<string>(), artists = new Set<string>(), loved = new Set<string>();
    const n = sequence === "mixed20" ? 20 : sequence === "next15" ? 15 : sequence === "love5" ? 5 : 10;
    for (let i = 0; i < n; i++) {
      const current = v.listening!.video!; expect(current).toBeTruthy();
      expect(videos.has(current.videoId)).toBe(false); videos.add(current.videoId); artists.add(current.artistId);
      const action = sequence === "love5" ? "LOVE" : sequence === "dislike10" ? "NOT_FOR_ME" : sequence === "next15" ? "NEXT" : (["LOVE", "NEXT", "NOT_FOR_ME"] as const)[i % 3]!;
      if (action === "LOVE") loved.add(current.artistId);
      v = await act(f, v, action);
      if (action === "LOVE") { expect(v.listening!.video!.videoId).toBe(current.videoId); v = await act(f, v, "NEXT"); }
    }
    expect(videos.size).toBe(n);
    // Love may legitimately retain a liked artist; it must not force one artist per click.
    expect(artists.size).toBeGreaterThanOrEqual(sequence === "love5" ? 3 : Math.min(n, 6));
    for (const r of requests) expect(r.seedEntityIds.every((id) => loved.has(id))).toBe(true);
    if (!loved.size) expect(requests).toHaveLength(0);
    const stored = await f.sessions.load(v.sessionToken);
    expect(stored.state.session.anchorIds).toEqual(f.state.session.anchorIds);
    expect(stored.state.listening!.supply!.funnel.reservoir).toBe(30);
  });

  it.each([[30, 2], [8, 0], [8, 8], [90, 90]])("%i artists / %i playable: no invented supply; bounded state", async (count, playable) => {
    const f = supplyFixture(count, playable, 1);
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const seen = new Set<string>();
    while (v.listening?.video) {
      expect(seen.has(v.listening.video.videoId)).toBe(false); seen.add(v.listening.video.videoId);
      v = await act(f, v, "NEXT");
    }
    expect(seen.size).toBe(playable); expect(v.listening!.notice).toBe("verified_inventory_exhausted");
    const stored = await f.sessions.load(v.sessionToken);
    expect(stored.state.listening!.supply!.funnel.unseenVideos).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(stored.state))).toBeLessThan(1_000_000);
    console.log("S9_16R_STATE_BYTES", count, Buffer.byteLength(JSON.stringify(stored.state)));
  });

  it("low playable runway bypasses misleading catalog tag coverage and actually merges/promotes fresh provider IDs", async () => {
    const f = supplyFixture(8, 1, 1); f.state.session.qlooCallCount = 1;
    // Earlier questions already confirmed this tag; seven unplayable catalog entries must not count as runway.
    f.state.session.positiveTagIds = ["fixture:direction:0"];
    for (const c of f.state.candidates) c.tags = f.state.candidates[0]!.tags;
    const fresh = supplyArtist(100);
    f.deps.musicLookup = { lookup: async () => ({ kind: "none" }), peek: async (a) => a.entityId === fresh.entityId ? { kind: "resolved", video: { ...supplyVideo(fresh, 600), provenance: "youtube_data_api" } } : null };
    f.deps.provider.getRecommendations = vi.fn(async (request: RecommendationRequest) => {
      expect(request.seedEntityIds).toEqual(f.state.session.anchorIds);
      return { provenance: "qloo" as const, requestId: "FIXTURE:fresh", requestCount: 1, payload: { success: true, results: { entities: [{ entity_id: fresh.entityId, name: fresh.name, subtype: "urn:entity:artist", tags: fresh.tags }] } } };
    });
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    v = await act(f, v, "NOT_FOR_ME");
    expect(v.listening!.video!.artistId).toBe(fresh.entityId);
    const stored = await f.sessions.load(v.sessionToken);
    expect(stored.state.candidates.map((c) => c.entityId)).toContain(fresh.entityId);
    expect(stored.state.listening!.trackFeedback).toHaveLength(1);
    expect(stored.state.session.qlooCallCount).toBe(2);
    expect(f.deps.provider.getRecommendations).toHaveBeenCalledTimes(1);
  });

  it("duplicate provider batches stop after two zero-yield plans; no identical request is repeated", async () => {
    const f = supplyFixture(8, 0, 1); f.state.session.qlooCallCount = 1;
    f.state.adaptivePool = initializeAdaptivePool(f.state.candidates, "music_artist", f.state.order.slice(0, 5));
    const requests: unknown[] = [];
    f.deps.provider.getRecommendations = vi.fn(async (request: RecommendationRequest) => { requests.push(request); return { provenance: "qloo" as const, requestId: `FIXTURE:duplicate${requests.length}`, requestCount: 1, payload: { success: true, results: { entities: f.state.candidates.map((c) => ({ entity_id: c.entityId, name: c.name, subtype: "urn:entity:artist", tags: c.tags })) } } }; });
    let token = await f.sessions.create(f.state);
    for (let i = 0; i < 6; i++) token = (await startListening(f.deps, { sessionToken: token })).sessionToken;
    expect(requests.length).toBe(2);
    expect(new Set(requests.map((r) => JSON.stringify(r))).size).toBe(2);
  });

  it("the Gemini comparator cannot override the supply diversity guard with an overexposed shortlist item", async () => {
    const f = supplyFixture(30, 20, 3);
    let calls = 0;
    f.deps.songSelector = { model: "FIXTURE", select: async (input) => { calls++; return { ok: true, videoId: input.options[0]!.videoId, reasonCode: "unheard_verified_recording", requests: 1, usage: { promptTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 }, costUsd: 0, latencyMs: 1, requestId: "FIXTURE:grounded" }; } };
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const initial = v.listening!.video!.videoId;
    v = await act(f, v, "LOVE");
    expect(calls).toBe(1); expect(v.listening!.video!.videoId).toBe(initial);
    expect(v.listening!.upNext).toBeTruthy();
    v = await act(f, v, "NEXT");
    expect(calls).toBe(1);
    expect(v.listening!.video!.videoId).not.toBe(initial);
  });

  it("expired and unavailable-store sessions fail before resolution or provider work", async () => {
    const f = supplyFixture(); const token = await f.sessions.create(f.state);
    f.deps.now = () => f.state.session.expiresAt + 1;
    await expect(startListening(f.deps, { sessionToken: token })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    f.deps.now = Date.now; f.deps.store = { ...f.deps.store, read: async () => { throw new Error("FIXTURE Redis unavailable"); } };
    await expect(startListening(f.deps, { sessionToken: token })).rejects.toBeTruthy();
  });
});
