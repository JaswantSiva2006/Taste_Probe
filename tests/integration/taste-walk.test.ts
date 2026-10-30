import { describe, expect, it, vi } from "vitest";
import type { DiscoveryView, ListeningAction } from "@/lib/contracts";
import { listeningFeedback, startListening } from "@/lib/discovery/service";
import type { RecommendationRequest } from "@/lib/qloo/provider";
import { interpretWalkResponse, type SongSelector, type WalkPlanInput } from "@/lib/agent/song-selector";
import { bucketSamples, entryRelevance, planWalk, relevanceOf } from "@/lib/music/taste-walk";
import { emptyListening, withTrackFeedback } from "@/lib/music/listening";
import { supplyArtist, supplyFixture } from "../helpers/discovery-supply";

/** S9.18 taste-graph walk over Qloo, offline (fixture providers only). */

const ANCHOR = "057DA9D9-399B-437E-8BCA-A80E499125EF";
const meta = { requests: 1, usage: { promptTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 }, costUsd: 0, latencyMs: 1, requestId: "FIXTURE" };
const neighbourhood = (from: number, n = 10) => Array.from({ length: n }, (_, i) => supplyArtist(from + i));
const insights = (artists: ReturnType<typeof supplyArtist>[]) => ({ provenance: "qloo" as const, requestId: "FIXTURE:walk", requestCount: 1, payload: { success: true, results: { entities: artists.map((c) => ({ entity_id: c.entityId, name: c.name, subtype: "urn:entity:artist", tags: c.tags })) } } });
const act = (f: ReturnType<typeof supplyFixture>, v: DiscoveryView, action: ListeningAction) => listeningFeedback(f.deps, { sessionToken: v.sessionToken, artistId: v.listening!.video!.artistId, videoId: v.listening!.video!.videoId, action });
const fixture = (env: Record<string, string> = {}) => {
  const f = supplyFixture(30, 20, 3);
  f.deps.config = { ...f.deps.config, limits: { ...f.deps.config.limits, maxQlooWalkCalls: Number(env.MAX_QLOO_WALK_CALLS ?? 15) } };
  return f;
};

describe("S9.18 taste-graph walk", () => {
  it("a loved artist becomes a seed: Qloo is asked for its own neighbourhood, and the result carries that provenance", async () => {
    const f = fixture();
    const requests: RecommendationRequest[] = [];
    f.deps.provider.getRecommendations = vi.fn(async (r: RecommendationRequest) => (requests.push(r), insights(neighbourhood(400))));
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const loved = v.listening!.video!.artistId;
    expect(requests).toHaveLength(0); // nothing earned yet: no walk
    v = await act(f, v, "LOVE");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.seedEntityIds).toEqual([loved]); // the artist alone, not blended with the starting point
    expect(requests[0]!.seedEntityIds).not.toContain(ANCHOR);
    expect(requests[0]!.excludedEntityIds ?? []).not.toContain(loved); // heard artists are excluded, never the seed itself
    const stored = (await f.sessions.load(v.sessionToken)).state;
    const walked = stored.candidates.find((c) => c.entityId === supplyArtist(400).entityId)!;
    expect(walked.evidence.seedEntityIds).toEqual([loved]);
    expect(stored.walk!.calls).toBe(1);
    expect(stored.walk!.seeds.find((s) => s.entityId === loved)?.status).toBe("expanded");
    expect(stored.session.qlooCallCount).toBe(f.state.session.qlooCallCount); // the question budget is untouched
    expect(relevanceOf(stored, stored.listening).get(walked.entityId)).toMatchObject({ kind: "NEIGHBOURHOOD", seedIds: [loved] });
    // The same evidence never re-triggers a query.
    v = await act(f, v, "NEXT");
    expect(requests).toHaveLength(1);
  });

  it("the walk's own allowance is enforced and a failed query keeps the feedback", async () => {
    const f = fixture({ MAX_QLOO_WALK_CALLS: "1" });
    const getRecommendations = vi.fn(async () => { throw new Error("FIXTURE upstream down"); });
    f.deps.provider.getRecommendations = getRecommendations;
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const first = v.listening!.video!;
    v = await act(f, v, "LOVE");
    expect(getRecommendations).toHaveBeenCalledTimes(1);
    v = await act(f, v, "NEXT");
    if (v.listening!.video!.artistId !== first.artistId) v = await act(f, v, "LOVE");
    expect(getRecommendations).toHaveBeenCalledTimes(1);
    const stored = (await f.sessions.load(v.sessionToken)).state;
    expect(stored.walk!.calls).toBe(1);
    expect(stored.listening!.trackFeedback.some((t) => t.videoId === first.videoId && t.action === "love")).toBe(true);
  });

  it("the walk planner can scout names; only an exact Qloo music-artist match joins the reservoir", async () => {
    const f = fixture();
    f.deps.provider.getRecommendations = vi.fn(async () => insights([]));
    const scout = supplyArtist(900);
    const searchEntities = vi.fn(async (q: string) => ({ provenance: "qloo" as const, requestId: "FIXTURE:search", requestCount: 1, payload: { results: q === scout.name ? [{ entity_id: scout.entityId, name: scout.name, types: ["urn:entity:artist"] }] : [{ entity_id: supplyArtist(901).entityId, name: "Somebody Else", types: ["urn:entity:artist"] }] } }));
    f.deps.provider.searchEntities = searchEntities;
    const planWalk = vi.fn(async (input: WalkPlanInput) => ({ ok: true as const, action: "SCOUT" as const, seedIds: [input.seeds[0]!.entityId], scoutNames: [scout.name, "Invented Name"], reasonCode: "fill_missing_neighbour" as const, ...meta }));
    const selector: SongSelector = { model: "FIXTURE", select: async (i) => ({ ok: true, videoId: i.options[0]!.videoId, reasonCode: "unheard_verified_recording", ...meta }), planWalk };
    f.deps.songSelector = selector;
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const loved = v.listening!.video!.artistId;
    v = await act(f, v, "LOVE");
    expect(planWalk).toHaveBeenCalledTimes(1);
    expect(f.deps.provider.getRecommendations).not.toHaveBeenCalled(); // SCOUT spends no insights query
    expect(searchEntities).toHaveBeenCalledTimes(2);
    const stored = (await f.sessions.load(v.sessionToken)).state;
    expect(stored.candidates.some((c) => c.entityId === scout.entityId)).toBe(true);
    expect(stored.candidates.some((c) => c.entityId === supplyArtist(901).entityId)).toBe(false);
    expect(stored.walk!.seeds.find((s) => s.entityId === scout.entityId)).toMatchObject({ origin: "scouted", parentIds: [loved] });
    expect(stored.walk!.decisions.at(-1)).toMatchObject({ action: "SCOUT", mode: "GEMINI", scouted: [scout.name] });
    expect(relevanceOf(stored, stored.listening).get(scout.entityId)!.relevance).toBeGreaterThan(0.5);
  });

  it("a model that keeps proposing the same step cannot spend the walk budget twice (live regression)", async () => {
    const f = fixture();
    const requests: RecommendationRequest[] = [];
    f.deps.provider.getRecommendations = vi.fn(async (r: RecommendationRequest) => (requests.push(r), insights(neighbourhood(400 + requests.length * 20))));
    let first: string | undefined;
    const planWalk = vi.fn(async (input: WalkPlanInput) => {
      first ??= input.seeds[0]!.entityId;
      return { ok: true as const, action: "EXPAND" as const, seedIds: [first], scoutNames: [], reasonCode: "deepen_strongest_seed" as const, ...meta };
    });
    f.deps.songSelector = { model: "FIXTURE", select: async (i) => ({ ok: true, videoId: i.options[0]!.videoId, reasonCode: "unheard_verified_recording", ...meta }), planWalk };
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    for (let i = 0; i < 6 && v.listening?.video; i++) {
      v = await act(f, v, "LOVE");
      if (v.listening?.video) v = await act(f, v, "NEXT");
    }
    const seedSets = requests.map((r) => [...r.seedEntityIds].sort().join("+"));
    expect(new Set(seedSets).size).toBe(seedSets.length); // never the same seed set twice
    const stored = (await f.sessions.load(v.sessionToken)).state;
    expect(stored.walk!.decisions.some((d) => d.reason === "model_plan_redundant")).toBe(true);
  });

  it("a rejected artist never seeds the walk", async () => {
    const f = fixture();
    const requests: RecommendationRequest[] = [];
    f.deps.provider.getRecommendations = vi.fn(async (r: RecommendationRequest) => (requests.push(r), insights([])));
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const artistId = v.listening!.video!.artistId;
    v = await listeningFeedback(f.deps, { sessionToken: v.sessionToken, artistId, videoId: v.listening!.video!.videoId, action: "NOT_FOR_ME", artistIntent: "NOT_THIS_ARTIST" });
    expect(requests.every((r) => !r.seedEntityIds.includes(artistId))).toBe(true);
  });

  it("relevance is a taste-weighted noisy-OR; agreement between seeds raises it", () => {
    const f = fixture();
    const ctx = { weights: new Map([[ANCHOR, 1], ["S", 1]]), queries: new Map([["h".repeat(24), { queryHash: "h".repeat(24), kind: "NEIGHBOURHOOD" as const, seedIds: ["S"], added: 5, at: 0, requestId: "x" }]]), anchorIds: [ANCHOR] };
    const one = entryRelevance({ origins: [{ queryHash: "b".repeat(24), rank: 6 }] }, ctx);
    const both = entryRelevance({ origins: [{ queryHash: "b".repeat(24), rank: 6 }, { queryHash: "h".repeat(24), rank: 6 }] }, ctx);
    expect(one.relevance).toBeCloseTo(0.5);
    expect(both.relevance).toBeCloseTo(0.75);
    expect(both.relevance).toBeLessThan(1);
    expect(f.state).toBeTruthy();
  });

  it("the bandit is silent on a cold start, deterministic per state, and favours a bucket that keeps pleasing", () => {
    const f = fixture();
    const state = { ...f.state, adaptivePool: undefined };
    expect(bucketSamples(state, emptyListening(), new Map()).size).toBe(0);
    const rel = new Map([["A", { relevance: 0.5, bucket: "good", seedIds: [], kind: "NEIGHBOURHOOD" as const }], ["B", { relevance: 0.5, bucket: "bad", seedIds: [], kind: "NEIGHBOURHOOD" as const }]]);
    let l = emptyListening();
    for (let i = 0; i < 8; i++) {
      l = withTrackFeedback(l, { artistId: "A", videoId: `AAAAAAAAA${i}x`.slice(0, 11), action: "love", at: i, revision: i });
      l = withTrackFeedback(l, { artistId: "B", videoId: `BBBBBBBBB${i}x`.slice(0, 11), action: "not_for_me", at: i, revision: i });
    }
    const samples = bucketSamples(state, l, rel);
    expect(samples).toEqual(bucketSamples(state, l, rel));
    expect(samples.get("good")!).toBeGreaterThan(samples.get("bad")!);
  });

  it("the deterministic planner does nothing without earned seeds", () => {
    const f = fixture();
    expect(planWalk(f.state, f.state.listening!)).toBeNull();
  });

  it("walk plans from the model are validated: known seeds only, EXPAND needs an unexpanded seed, names are plain text", () => {
    const seeds = [{ entityId: "A", name: "A", strength: "strong" as const, expanded: false }, { entityId: "B", name: "B", strength: "weak" as const, expanded: true }];
    const body = (args: unknown) => ({ candidates: [{ content: { parts: [{ functionCall: { name: "plan_walk_step", args } }] } }] });
    expect(interpretWalkResponse(body({ action: "EXPAND", seedIds: ["A"], scoutNames: ["Real Artist", "https://evil.example", "x".repeat(200)], reasonCode: "deepen_strongest_seed" }), { seeds })).toEqual({ action: "EXPAND", seedIds: ["A"], scoutNames: ["Real Artist"], reasonCode: "deepen_strongest_seed" });
    expect(interpretWalkResponse(body({ action: "EXPAND", seedIds: ["B"], scoutNames: [], reasonCode: "deepen_strongest_seed" }), { seeds })).toEqual({ error: "invalid_plan" });
    expect(interpretWalkResponse(body({ action: "BLEND", seedIds: ["A", "Z"], scoutNames: [], reasonCode: "bridge_loved_artists" }), { seeds })).toEqual({ error: "invalid_plan" });
    expect(interpretWalkResponse(body({ action: "SCOUT", seedIds: [], scoutNames: [], reasonCode: "fill_missing_neighbour" }), { seeds })).toEqual({ error: "invalid_plan" });
    expect(interpretWalkResponse(body({ action: "HOLD", seedIds: [], scoutNames: [], reasonCode: "because" }), { seeds })).toEqual({ error: "invalid_reason" });
  });
});
