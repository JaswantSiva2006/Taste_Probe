import { it, expect } from "vitest";
import { adaptiveFixture } from "../helpers/adaptive-listening";
import { startListening, listeningFeedback } from "@/lib/discovery/service";

it("records the narrow playable-supply baseline without claiming to recover the expired user session", async () => {
  const f = adaptiveFixture();
  // Genuine retained identities; mismatched names explicitly simulate unavailable resolver outcomes.
  f.state.candidates = f.state.candidates.map((c, i) => i < 2 ? c : { ...c, name: `FIXTURE unavailable ${i}` });
  let v = await startListening(f.deps, { sessionToken: await f.sessions.create(f.state) });
  const artists = new Set<string>(), videos = new Set<string>();
  for (let i = 0; i < 15 && v.listening?.video; i++) {
    artists.add(v.listening.video.artistId); videos.add(v.listening.video.videoId);
    v = await listeningFeedback(f.deps, { sessionToken: v.sessionToken, artistId: v.listening.video.artistId, videoId: v.listening.video.videoId, action: "NEXT" });
  }
  expect(artists.size).toBe(2); expect(videos.size).toBe(5);
  console.log("S9_16R_NARROW_BASELINE", JSON.stringify({ retainedArtists: f.state.candidates.length, playableArtists: artists.size, servedVideos: videos.size, notice: v.listening?.notice, namesHidden: true, source: "retained Interstellar identities, controlled resolver availability; not the expired Dua Lipa session" }));
});
