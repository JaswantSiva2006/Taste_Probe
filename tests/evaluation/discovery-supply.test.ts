import { describe, it, expect } from "vitest";
import { supplyFixture } from "../helpers/discovery-supply";
import { rankRecordings } from "@/lib/music/adaptive-listening";
import { recordEncounter, withTrackFeedback } from "@/lib/music/listening";
import { createQueryPlan, initializeAdaptivePool, mergeAdaptiveCandidates, planAdaptiveRetrieval } from "@/lib/discovery/adaptive-pool";
import { startListening, listeningFeedback } from "@/lib/discovery/service";
import { supplySnapshot, supplyPolicy } from "@/lib/music/supply";

describe("S9.16R matched supply/ranking evaluation", () => {
  it("many songs from two weakly fitting artists are not mistaken for broad runway; a strong local choice still prevents spending", () => {
    const f = supplyFixture(30, 2, 6);
    const snapshot = supplySnapshot(f.state.candidates, f.state.listening!, Date.now());
    const input = { snapshot, bestScore: 0.2, unresolved: 28, canLookup: true, canFetch: true };
    expect(supplyPolicy(input).decision).toBe("LOCAL_RESOLVE");
    expect(supplyPolicy({ ...input, bestScore: 0.6 }).decision).toBe("KEEP_SUPPLY");
  });
  it("compares B1/B2/B3 through the real transaction with matched adequate inventory; B3 responses are explicitly mocked", async () => {
    const rows = [];
    for (const variant of ["B1", "B2", "B3"]) {
      const f = supplyFixture(); f.state.session.qlooCallCount = 1;
      f.deps.config.features.adaptivePool = variant !== "B1";
      let qloo = 0, gemini = 0;
      f.deps.provider.getRecommendations = async () => { qloo++; throw new Error("Unnecessary Qloo request"); };
      if (variant === "B3") f.deps.songSelector = { model: "FIXTURE:Gemini", select: async (input) => { gemini++; return { ok: true, videoId: input.options[0]!.videoId, reasonCode: "unheard_verified_recording", requests: 1, usage: { promptTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 }, costUsd: 0, latencyMs: 0, requestId: "FIXTURE:comparison" }; } };
      let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
      const videos = new Set<string>(), artists = new Set<string>(), latencies: number[] = [];
      for (let i = 0; i < 20; i++) {
        const current = v.listening!.video!; videos.add(current.videoId); artists.add(current.artistId);
        const start = performance.now();
        v = await listeningFeedback(f.deps, { sessionToken: v.sessionToken, artistId: current.artistId, videoId: current.videoId, action: "NOT_FOR_ME" });
        latencies.push(performance.now() - start);
      }
      rows.push({ variant, uniqueVideos: videos.size, uniqueArtists: artists.size, qloo, mockedGeminiRequests: gemini, actualPaidRequests: 0, meanTransactionMs: latencies.reduce((a, b) => a + b) / 20 });
      expect(videos.size).toBe(20); expect(qloo).toBe(0);
    }
    expect(rows[2]!.mockedGeminiRequests).toBe(20);
    console.log("S9_16R_MATCHED_SERVICE_B1_B2_B3", JSON.stringify(rows));
  });
  it("compares S9.16 base score with contextual diversity on identical explicit feedback and inventory", () => {
    const rows = [];
    for (const variant of ["B0", "B1"]) {
      const f = supplyFixture(); let l = f.state.listening!; const artists: string[] = [], videos: string[] = [], times: number[] = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        const ranked = rankRecordings(f.state, l, l.inventory!);
        const winner = (variant === "B0" ? [...ranked].sort((a, b) => b.baseScore - a.baseScore || a.option.videoId.localeCompare(b.option.videoId)) : ranked)[0]!;
        times.push(performance.now() - start); artists.push(winner.option.artistId); videos.push(winner.option.videoId);
        l = recordEncounter(l, { artistId: winner.option.artistId, artistName: "FIXTURE", option: winner.option, selection: { mode: "DETERMINISTIC", reasonCode: "FIXTURE", eligibleCount: ranked.length, fallbackReason: null }, at: i, revision: i });
        l = withTrackFeedback(l, { artistId: winner.option.artistId, videoId: winner.option.videoId, action: "not_for_me", at: i, revision: i });
      }
      const counts = new Map<string, number>(); for (const a of artists) counts.set(a, (counts.get(a) ?? 0) + 1);
      rows.push({ variant, availableArtists: 30, playableArtists: 20, eligibleSongs: 60, uniqueSongs: new Set(videos).size, uniqueArtists: counts.size, maxArtistShare: Math.max(...counts.values()) / 20, repeatRate: 1 - new Set(videos).size / 20, meanRankMs: times.reduce((a, b) => a + b) / times.length, qloo: 0, youtube: 0, gemini: 0 });
    }
    expect(rows.every((r) => r.repeatRate === 0)).toBe(true);
    expect(rows[1]!.maxArtistShare).toBeLessThanOrEqual(rows[0]!.maxArtistShare);
    console.log("S9_16R_MATCHED_RANKING", JSON.stringify(rows));
  });

  it("protects current/saved IDs at the 90-entry bound and reports only retained new IDs", () => {
    const f = supplyFixture(90, 90, 1);
    const pool = initializeAdaptivePool(f.state.candidates, "music_artist", f.state.order.slice(0, 5));
    const protectedIds = f.state.order.slice(-2);
    const incoming = f.state.candidates.slice(0, 20).map((c, i) => ({ ...c, entityId: c.entityId.replace(/\d{12}$/, String(100 + i).padStart(12, "0")), rank: i + 1 }));
    const known = new Set([...f.state.session.anchorIds, ...f.state.order]);
    const plan = createQueryPlan({ family: "PAGINATE", cursor: "page:2", targetType: "music_artist", seedEntityIds: f.state.session.anchorIds, knownEntityIds: known, knownTagIds: new Set(), executable: true });
    const merged = mergeAdaptiveCandidates({ current: f.state.candidates, incoming, pool, plan, requestId: "FIXTURE:page2", round: 1, at: 1, qlooCalls: 1, protectedIds });
    expect(merged.candidates).toHaveLength(90);
    expect(protectedIds.every((id) => merged.candidates.some((c) => c.entityId === id))).toBe(true);
    expect(merged.pool.pinnedIds).toEqual([]); // retention never manufactures an explicit preference
    expect(merged.addedIds.every((id) => merged.candidates.some((c) => c.entityId === id))).toBe(true);
  });

  it("gates supply expansion by verified endpoint capabilities and canonical attempted plans", () => {
    const f = supplyFixture(8, 0); const pool = initializeAdaptivePool(f.state.candidates, "music_artist", []);
    const input = { pool, candidates: f.state.candidates, anchorIds: f.state.session.anchorIds, targetType: "music_artist", newPositiveEntityIds: [], newPositiveTagIds: [], take: 50, includeExplainability: true };
    expect(planAdaptiveRetrieval({ ...input, supplyExpansion: { verified: false, exhaustedArtistIds: f.state.order } }).plan).toBeNull();
    const first = planAdaptiveRetrieval({ ...input, supplyExpansion: { verified: true, exhaustedArtistIds: f.state.order } });
    expect(first.plan!.family).toBe("VALIDATED_EXCLUSION_REFRESH");
    pool.attemptedQueryHashes.push(first.plan!.queryHash);
    const second = planAdaptiveRetrieval({ ...input, supplyExpansion: { verified: true, exhaustedArtistIds: [...f.state.order].reverse() } });
    expect(second.plan!.family).toBe("PAGINATE"); expect(second.plan!.cursor).toBe("page:2");
  });
});
