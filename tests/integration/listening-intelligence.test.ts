import { describe, expect, it, vi } from "vitest";
import type { DiscoveryView, ListeningAction, ResolvedVideo } from "@/lib/contracts";
import { listeningFeedback, startListening } from "@/lib/discovery/service";
import { artistSignals, implicitWeight, rankRecordings } from "@/lib/music/adaptive-listening";
import { interpretAffinityResponse, type ArtistAffinityInput, type SongSelector } from "@/lib/agent/song-selector";
import type { DynamicLookup, DynamicOutcome } from "@/lib/music/youtube-data";
import { supplyArtist, supplyFixture, supplyVideo } from "../helpers/discovery-supply";
import type { RecommendationRequest } from "@/lib/qloo/provider";

/** S9.17 offline: listening time, model affinity, priority resolution and loved-artist depth. No provider calls. */

const usage = { promptTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 };
const meta = { requests: 1, usage, costUsd: 0, latencyMs: 1, requestId: "FIXTURE" };
const resolved = (artistIndex: number, first: number, n = 3): DynamicOutcome => {
  const artist = supplyArtist(artistIndex);
  const videos: ResolvedVideo[] = Array.from({ length: n }, (_, i) => {
    const o = supplyVideo(artist, first + i);
    return { videoId: o.videoId, title: o.title, channelTitle: "FIXTURE Label", channelKind: "credited_upload", provenance: "youtube_data_api", watchUrl: o.watchUrl, verifiedAt: o.verifiedAt, durationSeconds: 240 };
  });
  return { kind: "resolved", video: videos[0]!, alternates: videos.slice(1) };
};
const act = (f: ReturnType<typeof supplyFixture>, v: DiscoveryView, action: ListeningAction, extra: { listenedSeconds?: number; playbackMode?: "preview" | "full" } = {}) =>
  listeningFeedback(f.deps, { sessionToken: v.sessionToken, artistId: v.listening!.video!.artistId, videoId: v.listening!.video!.videoId, action, ...extra });

function selector(favoured: (input: ArtistAffinityInput) => string[]) {
  const rankArtists = vi.fn(async (input: ArtistAffinityInput) => ({ ok: true as const, favoured: favoured(input), disfavoured: [], reasonCode: "close_to_loved_artists" as const, ...meta }));
  const s: SongSelector = { model: "FIXTURE", select: async (input) => ({ ok: true, videoId: input.options[0]!.videoId, reasonCode: "unheard_verified_recording", ...meta }), rankArtists };
  return { s, rankArtists };
}

describe("S9.17 listening intelligence", () => {
  it("an unresolved artist the model favours is looked up first even when other supply is adequate", async () => {
    const f = supplyFixture(30, 20, 3);
    const target = supplyArtist(22).entityId;
    f.state.listening!.supply!.resolutions = f.state.listening!.supply!.resolutions.filter((r) => r.artistId !== target);
    const lookupBatch = vi.fn(async (artists: Array<{ entityId: string }>) => Object.fromEntries(artists.map((a) => [a.entityId, a.entityId === target ? resolved(22, 900) : null])));
    f.deps.musicLookup = { lookup: vi.fn(async () => ({ kind: "none" as const })), peek: async () => null, lookupBatch } as DynamicLookup;
    const { s, rankArtists } = selector(() => [target]);
    f.deps.songSelector = s;
    const v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    expect(rankArtists).toHaveBeenCalledTimes(1);
    expect(lookupBatch).toHaveBeenCalledTimes(1);
    expect(lookupBatch.mock.calls[0]![0][0]!.entityId).toBe(target);
    const stored = (await f.sessions.load(v.sessionToken)).state.listening!;
    expect(stored.inventory!.filter((o) => o.artistId === target)).toHaveLength(3);
    expect(stored.artistAffinity!.favoured).toEqual([target]);
    // The model term lifts the favoured artist's recordings above an otherwise equal neighbour.
    const ranks = rankRecordings((await f.sessions.load(v.sessionToken)).state, stored, stored.inventory!);
    const favoured = ranks.find((r) => r.option.artistId === target)!;
    const neighbour = ranks.find((r) => r.option.artistId === supplyArtist(21).entityId);
    expect(favoured.model).toBe(1);
    expect(neighbour?.model ?? 0).toBe(0);
  });

  it("an artist crowded out of a shared query gets a focused search on the next turn", async () => {
    const f = supplyFixture(30, 20, 3);
    const target = supplyArtist(22).entityId;
    f.state.listening!.supply!.resolutions = f.state.listening!.supply!.resolutions.filter((r) => r.artistId !== target);
    const lookup = vi.fn(async (a: { entityId: string }) => (a.entityId === target ? resolved(22, 900) : { kind: "none" as const }));
    f.deps.musicLookup = { lookup, peek: async () => null, lookupBatch: vi.fn(async (artists: Array<{ entityId: string }>) => Object.fromEntries(artists.map((a) => [a.entityId, null]))) } as DynamicLookup;
    f.deps.songSelector = selector(() => [target]).s;
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    expect(lookup).not.toHaveBeenCalled();
    v = await act(f, v, "NEXT");
    expect(lookup.mock.calls.some(([a]) => a.entityId === target)).toBe(true);
    expect((await f.sessions.load(v.sessionToken)).state.listening!.inventory!.some((o) => o.artistId === target)).toBe(true);
  });

  it("listening time is stored per recording, bounded by its duration, and becomes an implicit artist signal", async () => {
    const f = supplyFixture(30, 20, 3);
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const skipped = v.listening!.video!;
    v = await act(f, v, "NEXT", { listenedSeconds: 5, playbackMode: "full" });
    const stayed = v.listening!.video!;
    v = await act(f, v, "NEXT", { listenedSeconds: 99_999 > 21_600 ? 21_600 : 0, playbackMode: "full" });
    const l = (await f.sessions.load(v.sessionToken)).state.listening!;
    expect(l.engagement!.find((e) => e.videoId === skipped.videoId)!.listenedSeconds).toBe(5);
    expect(l.engagement!.find((e) => e.videoId === stayed.videoId)!.listenedSeconds).toBe(240); // never more than one full play
    const signals = artistSignals(l);
    if (skipped.artistId !== stayed.artistId) {
      expect(signals.get(skipped.artistId)!.score).toBeLessThan(0);
      expect(signals.get(stayed.artistId)!.score).toBeGreaterThan(0);
    }
    expect(signals.get(skipped.artistId)!.strong).toBe(false);
  });

  it("implicit weights: no play is no evidence; a finished preview counts against the preview's length", () => {
    const e = (action: string, listenedSeconds: number, mode?: "preview" | "full") => implicitWeight({ action, listenedSeconds, durationSeconds: 240, mode }, 30);
    expect(e("NEXT", 0)).toBe(0);
    expect(e("NEXT", 6)).toBeLessThan(0);
    expect(e("NEXT", 30)).toBeLessThan(0); // 30 s of a 4-minute song in full mode
    expect(e("NEXT", 30, "preview")).toBeGreaterThan(0); // the whole preview
    expect(e("NEXT", 230)).toBeGreaterThan(0);
    expect(e("LOVE", 5)).toBe(0); // explicit reactions are recorded separately and always win
  });

  it("an explicit reaction outweighs listening time for the same recording", async () => {
    const f = supplyFixture(30, 20, 3);
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const first = v.listening!.video!;
    v = await act(f, v, "NOT_FOR_ME", { listenedSeconds: 240, playbackMode: "full" });
    const l = (await f.sessions.load(v.sessionToken)).state.listening!;
    expect(artistSignals(l).get(first.artistId)!.score).toBeLessThan(0);
  });

  it("Gemini affinity is refreshed only when the evidence changes, and never twice in one turn with song comparison", async () => {
    const f = supplyFixture(30, 20, 3);
    const { s, rankArtists } = selector((input) => [input.candidates[3]!.entityId]);
    const select = vi.spyOn(s, "select");
    f.deps.songSelector = s;
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    expect(rankArtists).toHaveBeenCalledTimes(1); // the starting point alone
    v = await act(f, v, "NEXT"); // neutral: same evidence
    expect(rankArtists).toHaveBeenCalledTimes(1);
    v = await act(f, v, "NOT_FOR_ME"); // one new negative: not yet worth a request
    expect(rankArtists).toHaveBeenCalledTimes(1);
    v = await act(f, v, "LOVE"); // any new positive refreshes
    expect(rankArtists).toHaveBeenCalledTimes(2);
    expect(select).not.toHaveBeenCalled();
    const stored = (await f.sessions.load(v.sessionToken)).state;
    expect(stored.session.geminiRequestCount).toBe(2);
    expect(rankArtists.mock.calls[1]![0].liked).toHaveLength(1);
    expect(rankArtists.mock.calls[1]![0].disliked).toHaveLength(1);
  });

  it("loving a recording deepens that artist's catalogue once, merging rather than replacing", async () => {
    const f = supplyFixture(30, 20, 3);
    const lookup = vi.fn(async (a: { entityId: string }, _e: string, o?: { fresh?: boolean }) => {
      const i = Number(a.entityId.slice(-3));
      return o?.fresh ? resolved(i, 5_000 + i * 10, 8) : ({ kind: "none" } as const);
    });
    f.deps.musicLookup = { lookup, peek: async () => null } as DynamicLookup;
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const loved = v.listening!.video!;
    v = await act(f, v, "LOVE");
    expect(lookup.mock.calls.filter(([a, , o]) => a.entityId === loved.artistId && o?.fresh)).toHaveLength(1);
    const inventory = (await f.sessions.load(v.sessionToken)).state.listening!.inventory!;
    expect(inventory.filter((o) => o.artistId === loved.artistId).length).toBe(3 + 8);
    v = await act(f, v, "LOVE", {});
    expect(lookup.mock.calls.filter(([a, , o]) => a.entityId === loved.artistId && o?.fresh)).toHaveLength(1);
  });

  it("the first loved recording of an artist widens the reservoir around that artist, once, within the Qloo allowance", async () => {
    const f = supplyFixture(30, 20, 3);
    f.state.session.qlooCallCount = 1;
    const neighbour = supplyArtist(200);
    const requests: RecommendationRequest[] = [];
    f.deps.provider.getRecommendations = vi.fn(async (request: RecommendationRequest) => {
      requests.push(request);
      return { provenance: "qloo" as const, requestId: "FIXTURE:neighbourhood", requestCount: 1, payload: { success: true, results: { entities: [{ entity_id: neighbour.entityId, name: neighbour.name, subtype: "urn:entity:artist", tags: neighbour.tags }] } } };
    });
    let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
    const loved = v.listening!.video!;
    v = await act(f, v, "LOVE");
    expect(requests).toHaveLength(1);
    expect([...requests[0]!.seedEntityIds, ...(requests[0]!.positiveEntityIds ?? [])]).toContain(loved.artistId);
    const stored = (await f.sessions.load(v.sessionToken)).state;
    expect(stored.candidates.map((c) => c.entityId)).toContain(neighbour.entityId);
    expect(stored.session.positiveEntityIds).not.toContain(loved.artistId); // a track love is not an artist preference
    v = await act(f, v, "NEXT");
    if (v.listening!.video!.artistId === loved.artistId) {
      await act(f, v, "LOVE");
      expect(requests).toHaveLength(1); // the same artist is not re-expanded
    }
  });

  it("the model can only return authorized candidate IDs", () => {
    const body = (args: unknown) => ({ candidates: [{ content: { parts: [{ functionCall: { name: "rank_candidate_artists", args } }] } }] });
    expect(interpretAffinityResponse(body({ favoured: ["A", "A", "B"], disfavoured: ["B", "C"], reasonCode: "close_to_loved_artists" }), ["A", "B", "C"])).toEqual({ favoured: ["A", "B"], disfavoured: ["C"], reasonCode: "close_to_loved_artists" });
    expect(interpretAffinityResponse(body({ favoured: ["Z"], disfavoured: [], reasonCode: "close_to_loved_artists" }), ["A"])).toEqual({ error: "invalid_candidate" });
    expect(interpretAffinityResponse(body({ favoured: ["A"], disfavoured: [], reasonCode: "because" }), ["A"])).toEqual({ error: "invalid_reason" });
    expect(interpretAffinityResponse({ candidates: [{ content: { parts: [{ text: "Try artist Z" }] } }] }, ["A"])).toEqual({ error: "missing_function_call" });
  });
});
