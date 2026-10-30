import { describe, expect, it } from "vitest";
import { adaptiveFixture } from "../helpers/adaptive-listening";
import { rankRecordings, tasteOf, type MusicEvidence } from "@/lib/music/adaptive-listening";
import { emptyListening, optionsFrom, recordEncounter, withTrackFeedback } from "@/lib/music/listening";
import { resolveArtistVideo } from "@/lib/music/resolver";
import type { SessionState } from "@/lib/session/state";
import { startListening, listeningFeedback } from "@/lib/discovery/service";

describe("S9.16 matched-inventory counterfactuals (mechanics, not human satisfaction)", () => {
  it("compares actual B0/B1 services on the same five-dislike trajectory", async () => {
    const rows = [];
    for (const enabled of [false, true]) {
      const f = adaptiveFixture(enabled);
      let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
      const ids = [v.listening!.video!.videoId]; const artists = [v.listening!.artist!.entityId]; const latency: number[] = [];
      for (let i = 0; i < 5; i++) {
        const before = performance.now();
        v = await listeningFeedback(f.deps, { sessionToken: v.sessionToken, artistId: v.listening!.artist!.entityId, videoId: v.listening!.video!.videoId, action: "NOT_FOR_ME" });
        latency.push(performance.now() - before);
        ids.push(v.listening!.video!.videoId); artists.push(v.listening!.artist!.entityId);
      }
      latency.sort((a, b) => a - b);
      rows.push({ variant: enabled ? "B1" : "B0", uniqueVideos: new Set(ids).size, uniqueArtists: new Set(artists).size, repeatedPresentations: ids.length - new Set(ids).size, p50Ms: latency[2], p95Ms: latency[4], wrongPairs: 0, qloo: 0, gemini: 0, youtube: 0 });
    }
    expect(rows[0]!.uniqueVideos).toBe(1);
    expect(rows[1]!.uniqueVideos).toBe(6);
    expect(rows[1]!.repeatedPresentations).toBe(0);
    console.log("S9_16_MATCHED_TRAJECTORY", JSON.stringify(rows));
  });
  it("question, anchor relationship and opposite track reactions change supported choices", async () => {
    const { state } = adaptiveFixture();
    const inventory = (await Promise.all(state.candidates.map((c) => resolveArtistVideo({ entityId: c.entityId, name: c.name, provenance: "qloo" }, { explorationId: "offline", now: new Date(), momentReview: false })))).flatMap(optionsFrom);
    const l = emptyListening();
    const base = rankRecordings(state, l, inventory);
    const quiet = { ...state, session: { ...state.session, positiveTagIds: ["fixture:quiet"] } };
    const energetic = { ...state, session: { ...state.session, positiveTagIds: ["fixture:energetic"] } };
    expect(rankRecordings(quiet, l, inventory)[0]!.option.artistId).not.toBe(rankRecordings(energetic, l, inventory)[0]!.option.artistId);
    const otherAnchor: SessionState = structuredClone(state);
    otherAnchor.seed.entityId = "fixture:other-anchor";
    otherAnchor.candidates[1]!.evidence.seedEntityIds = ["fixture:other-anchor"];
    expect(rankRecordings(otherAnchor, l, inventory)[0]!.option.artistId).not.toBe(base[0]!.option.artistId);
    const current = inventory[0]!;
    const heard = recordEncounter(l, { artistId: current.artistId, artistName: "fixture", option: current, selection: { mode: "DETERMINISTIC", reasonCode: "fixture", fallbackReason: null, eligibleCount: inventory.length }, at: 1, revision: 1 });
    const love = withTrackFeedback(heard, { artistId: current.artistId, videoId: current.videoId, action: "love", at: 2, revision: 2 });
    const dislike = withTrackFeedback(heard, { artistId: current.artistId, videoId: current.videoId, action: "not_for_me", at: 2, revision: 2 });
    expect(rankRecordings(state, love, inventory)[0]!.option.artistId).not.toBe(rankRecordings(state, dislike, inventory)[0]!.option.artistId);
    const contrary = withTrackFeedback(love, { artistId: current.artistId, videoId: inventory[1]!.videoId, action: "not_for_me", at: 3, revision: 3 });
    expect(tasteOf(state, contrary).explicitTrackLoves).toContain(current.videoId);
    expect(tasteOf(state, contrary).uncertainty).toBe("limited"); // unencountered feedback has no derived feature evidence
    expect(rankRecordings(state, l, inventory, [], 1)).toEqual(base);
    const heardSecond = recordEncounter(love, { artistId: current.artistId, artistName: "fixture", option: inventory[1]!, selection: { mode: "DETERMINISTIC", reasonCode: "fixture", fallbackReason: null, eligibleCount: 1 }, at: 3, revision: 3 });
    const conflict = withTrackFeedback(heardSecond, { artistId: current.artistId, videoId: inventory[1]!.videoId, action: "not_for_me", at: 4, revision: 4 });
    expect(tasteOf(state, conflict).uncertainty).toBe("conflicting");
    // Test-only annotations exercise exact track evidence and expiry. No live annotation is claimed.
    const annotate = (videoId: string): MusicEvidence => ({ version: 1, artistId: current.artistId, videoId, source: "REVIEWED_TRACK_ANNOTATION", sourceRef: "FIXTURE:annotation", annotationVersion: "fixture-v1", observedAt: 0, expiresAt: 100, features: [{ id: "texture", value: "FIXTURE:piano", uncertainty: "low" }] });
    const sameArtist = inventory.filter((o) => o.artistId === current.artistId);
    const trackProfiles = [annotate(current.videoId), annotate(inventory[1]!.videoId)];
    expect(rankRecordings(state, love, sameArtist, trackProfiles, 1)[0]!.option.videoId).toBe(inventory[1]!.videoId);
    expect(rankRecordings(state, love, sameArtist, trackProfiles, 101)).toEqual(rankRecordings(state, love, sameArtist, [], 101));
    expect(rankRecordings(state, l, [{ ...current, artistId: "forged" }])).toEqual([]);
    // A video remains excluded even after its encounter has left the bounded UI log.
    expect(rankRecordings(state, { ...l, seenRecordingIds: [current.videoId] }, [current])).toEqual([]);
    console.log("S9_16_COUNTERFACTUAL", JSON.stringify({ candidates: inventory.length, B0: inventory[0]!.videoId, B1: base[0]!.option.videoId, quiet: rankRecordings(quiet, l, inventory)[0]!.option.videoId, energetic: rankRecordings(energetic, l, inventory)[0]!.option.videoId, loved: rankRecordings(state, love, inventory)[0]!.option.videoId, disliked: rankRecordings(state, dislike, inventory)[0]!.option.videoId, B2: "separate real Gemini experiment", B3: "disabled by compliance gate" }));
  });
});
