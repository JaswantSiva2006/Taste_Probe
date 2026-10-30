import { describe, expect, it, vi } from "vitest";
import type { DiscoveryView, ListeningAction, RecommendationCandidate, ResolvedVideo } from "@/lib/contracts";
import { listeningFeedback, startListening } from "@/lib/discovery/service";
import type { RecommendationRequest } from "@/lib/qloo/provider";
import type { DynamicLookup } from "@/lib/music/youtube-data";
import { emptyListening } from "@/lib/music/listening";
import { supplySnapshot } from "@/lib/music/supply";
import { createSession, type SessionState } from "@/lib/session/state";
import { createSessionService } from "@/lib/session/service";
import { testConfig, testDeps } from "../helpers";

/**
 * S9.18 offline benchmark (mechanics, not human satisfaction). A synthetic Qloo graph:
 * the starting point's top 50 is mostly a "popular" cluster P plus five edge artists of
 * a cluster H; H's core (30 artists) is only reachable through H's own neighbourhood —
 * the shape of "A.R. Rahman → Harris Jayaraj → Anirudh". A simulated listener loves H and
 * passes on P. Every artist has two fixture recordings. No provider is contacted.
 */

const ANCHOR = "057DA9D9-399B-437E-8BCA-A80E499125EF";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const artist = (n: number, cluster: "P" | "H" | "X"): RecommendationCandidate => ({ entityId: id(n), name: `FIXTURE ${cluster}${n}`, entityType: "music_artist", rank: 1, tags: [{ id: `fixture:${cluster === "H" ? "h" : "p"}:${n % 3}`, name: `FIXTURE ${cluster} ${n % 3}`, type: "fixture" }], evidence: { source: "qloo", requestId: "FIXTURE:base", seedEntityIds: [ANCHOR] } });
const P = Array.from({ length: 40 }, (_, i) => artist(1 + i, "P"));
const H_EDGE = Array.from({ length: 5 }, (_, i) => artist(41 + i, "H"));
const X = Array.from({ length: 5 }, (_, i) => artist(46 + i, "X"));
const H_CORE = Array.from({ length: 30 }, (_, i) => artist(100 + i, "H"));
const P_DEEP = Array.from({ length: 30 }, (_, i) => artist(200 + i, "P"));
// Base order: the H edge sits at ranks 21–25, behind twenty popular artists.
const BASE = [...P.slice(0, 20), ...H_EDGE, ...P.slice(20), ...X].map((c, i) => ({ ...c, rank: i + 1 }));
const inH = (artistId: string) => [...H_EDGE, ...H_CORE].some((c) => c.entityId === artistId);
const isCore = (artistId: string) => H_CORE.some((c) => c.entityId === artistId);

const entity = (c: RecommendationCandidate) => ({ entity_id: c.entityId, name: c.name, subtype: "urn:entity:artist", tags: c.tags.map((t) => ({ id: t.id, name: t.name, type: t.type })) });
function graph(request: RecommendationRequest) {
  const seeds = request.seedEntityIds;
  const list = seeds.some(inH) ? [...H_CORE, ...H_EDGE, ...P.slice(0, 15)] : seeds.includes(ANCHOR) ? [...BASE, ...P_DEEP] : [...P_DEEP, ...P];
  const excluded = new Set(request.excludedEntityIds ?? []);
  return { provenance: "qloo" as const, requestId: `FIXTURE:${seeds.join("+").slice(-12)}`, requestCount: 1, payload: { success: true, results: { entities: list.filter((c) => !excluded.has(c.entityId) && !seeds.includes(c.entityId)).slice(0, 50).map(entity) } } };
}
const recordings = (artistId: string) => {
  const n = Number(artistId.slice(-6));
  const v = (k: number): ResolvedVideo => { const videoId = `WK${String(n * 10 + k).padStart(9, "0")}`; return { videoId, title: `FIXTURE recording ${n}.${k}`, channelTitle: "FIXTURE - Topic", channelKind: "topic", provenance: "youtube_data_api", watchUrl: `https://www.youtube.com/watch?v=${videoId}`, verifiedAt: new Date().toISOString(), durationSeconds: 240 }; };
  return { kind: "resolved" as const, video: v(1), alternates: [v(2)] };
};

async function journey(walkCalls: number, turns = 24) {
  const config = testConfig({ QLOO_MODE: "live", QLOO_API_KEY: "FIXTURE", LLM_PROVIDER: "none", ADAPTIVE_POOL_ENABLED: "true", ADAPTIVE_LISTENING_ENABLED: "true", MAX_QLOO_WALK_CALLS: String(walkCalls) });
  const deps = testDeps({ config });
  const requests: RecommendationRequest[] = [];
  deps.provider.getRecommendations = vi.fn(async (r: RecommendationRequest) => (requests.push(r), graph(r)));
  const lookup: DynamicLookup = { lookup: async (a) => recordings(a.entityId), peek: async (a) => recordings(a.entityId) };
  deps.musicLookup = lookup;
  const session = { ...createSession({ anchorIds: [ANCHOR], sourceType: "music_artist", targetType: "music_artist", maxQuestions: 3, mode: "live", now: Date.now(), ttlSeconds: 1800 }), status: "finished" as const, qlooCallCount: 2 };
  const l = emptyListening();
  l.supply = supplySnapshot(BASE, l, Date.now());
  const state: SessionState = { session, seed: { entityId: ANCHOR, name: "FIXTURE anchor", entityType: "music_artist", provenance: "qloo" }, candidates: BASE, order: BASE.map((c) => c.entityId), finishReason: "question_budget_exhausted", listening: l };
  const sessions = createSessionService({ store: deps.store, settings: config.session, mode: "live" });
  let v: DiscoveryView = await startListening(deps, { sessionToken: await sessions.create(state) });
  const presented: string[] = [];
  const act = (action: ListeningAction) => listeningFeedback(deps, { sessionToken: v.sessionToken, artistId: v.listening!.video!.artistId, videoId: v.listening!.video!.videoId, action, listenedSeconds: action === "NOT_FOR_ME" ? 8 : 200, playbackMode: "full" });
  for (let i = 0; i < turns && v.listening?.video; i++) {
    const current = v.listening.video.artistId;
    presented.push(current);
    if (inH(current)) { v = await act("LOVE"); if (v.listening?.video?.artistId === current && v.listening.video) v = await act("NEXT"); }
    else v = await act("NOT_FOR_ME");
  }
  const stored = (await sessions.load(v.sessionToken)).state;
  const firstCore = presented.findIndex(isCore);
  return {
    presented: presented.length,
    bucketShare: presented.filter(inH).length / presented.length,
    secondHalfShare: presented.slice(presented.length / 2).filter(inH).length / Math.max(1, presented.length - presented.length / 2),
    coreArtists: new Set(presented.filter(isCore)).size,
    firstCoreTurn: firstCore < 0 ? null : firstCore + 1,
    walkQueries: requests.filter((r) => !r.seedEntityIds.includes(ANCHOR)).length,
    walkCalls: stored.walk?.calls ?? 0,
    reservoir: stored.candidates.length,
    decisions: stored.walk?.decisions.map((d) => `${d.action}:${d.added}`) ?? [],
  };
}

describe("S9.18 taste-graph walk benchmark (synthetic graph, simulated listener)", () => {
  it("walking from loved artists reaches the listener's cluster beyond the starting point's list", async () => {
    const off = await journey(0);
    const on = await journey(15);
    console.log("S9_18_WALK_BENCHMARK", JSON.stringify({ off, on }));
    expect(off.coreArtists).toBe(0); // unreachable without moving the seed
    expect(on.coreArtists).toBeGreaterThanOrEqual(5);
    expect(on.firstCoreTurn).not.toBeNull();
    expect(on.bucketShare).toBeGreaterThan(off.bucketShare);
    expect(on.secondHalfShare).toBeGreaterThanOrEqual(0.7); // settles into the bucket it likes
    expect(on.walkCalls).toBeLessThanOrEqual(15);
    expect(on.reservoir).toBeLessThanOrEqual(90);
  }, 60_000);
});
