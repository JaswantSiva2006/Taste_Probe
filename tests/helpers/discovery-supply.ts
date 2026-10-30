import type { RecommendationCandidate, VerifiedSongOption } from "@/lib/contracts";
import { createSession, type SessionState } from "@/lib/session/state";
import { createSessionService } from "@/lib/session/service";
import { emptyListening } from "@/lib/music/listening";
import { supplySnapshot } from "@/lib/music/supply";
import { testConfig, testDeps } from "../helpers";

/** All generated identities/recordings are TEST FIXTURES, not assertions of real Qloo/YouTube identities. */
export const supplyArtist = (n: number): RecommendationCandidate => ({ entityId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, name: `FIXTURE artist ${n}`, entityType: "music_artist", rank: n + 1, tags: [{ id: `fixture:direction:${n % 4}`, name: `FIXTURE direction ${n % 4}`, type: "fixture" }], evidence: { source: "qloo", requestId: "FIXTURE:provider", seedEntityIds: ["057DA9D9-399B-437E-8BCA-A80E499125EF"] } });
export const supplyVideo = (artist: RecommendationCandidate, n: number): VerifiedSongOption => ({ artistId: artist.entityId, videoId: `FX${String(n).padStart(9, "0")}`, title: `FIXTURE recording ${n}`, channelTitle: `${artist.name} - Topic`, channelKind: "topic", provenance: "youtube_data_api", watchUrl: `https://www.youtube.com/watch?v=FX${String(n).padStart(9, "0")}`, verifiedAt: new Date().toISOString(), durationSeconds: 240 });

export function supplyFixture(count = 30, playable = 20, perArtist = 3) {
  const config = testConfig({ QLOO_MODE: "live", QLOO_API_KEY: "FIXTURE", LLM_PROVIDER: "none", ADAPTIVE_POOL_ENABLED: "true", ADAPTIVE_LISTENING_ENABLED: "true" });
  const deps = testDeps({ config });
  const candidates = Array.from({ length: count }, (_, i) => supplyArtist(i));
  const l = emptyListening(); l.inventory = candidates.slice(0, playable).flatMap((c, i) => Array.from({ length: perArtist }, (_, j) => supplyVideo(c, i * 6 + j)));
  const session = { ...createSession({ anchorIds: ["057DA9D9-399B-437E-8BCA-A80E499125EF"], sourceType: "movie", targetType: "music_artist", maxQuestions: 3, mode: "live", now: Date.now(), ttlSeconds: 1800 }), status: "finished" as const, qlooCallCount: 6 };
  l.supply = { ...supplySnapshot(candidates, l, Date.now()), resolutions: candidates.slice(playable).map((c) => ({ artistId: c.entityId, status: "UNAVAILABLE", reason: "FIXTURE no verified recording", lookup: "CACHED", checkedAt: Date.now(), retryAt: session.expiresAt, options: 0 })) };
  const state: SessionState = { session, seed: { entityId: session.anchorIds[0]!, name: "Interstellar", entityType: "movie", provenance: "qloo" }, candidates, order: candidates.map((c) => c.entityId), finishReason: "question_budget_exhausted", listening: l };
  const sessions = createSessionService({ store: deps.store, settings: config.session, mode: "live" });
  return { deps, state, sessions };
}
