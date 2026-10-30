import { REVIEWED_MAPPINGS } from "@/lib/music/mappings";
import { createSession, type SessionState } from "@/lib/session/state";
import { createSessionService } from "@/lib/session/service";
import { testDeps, testConfig } from "../helpers";

/** Real reviewed identity inventory; tag assignments below are explicitly synthetic counterfactual fixtures. */
export function adaptiveFixture(enabled = true) {
  const deps = testDeps({ config: testConfig({ ADAPTIVE_LISTENING_ENABLED: String(enabled) }) });
  const at = Date.now();
  const sourceId = "057DA9D9-399B-437E-8BCA-A80E499125EF";
  const state: SessionState = {
    session: { ...createSession({ anchorIds: [sourceId], sourceType: "movie", targetType: "music_artist", maxQuestions: 3, mode: "mock", now: at, ttlSeconds: 1800 }), status: "finished", qlooCallCount: 6 },
    seed: { entityId: sourceId, entityType: "movie", name: "Interstellar", provenance: "qloo" },
    candidates: REVIEWED_MAPPINGS.filter((m) => m.review === "RESOLVED").map((m, i) => ({
      entityId: m.qlooArtistId, name: m.artistName, entityType: "music_artist", rank: i + 1,
      tags: [{ id: i % 2 ? "fixture:energetic" : "fixture:quiet", name: i % 2 ? "FIXTURE energetic" : "FIXTURE quiet", type: "fixture" }],
      evidence: { source: "qloo", requestId: "recorded-identities-synthetic-tags", seedEntityIds: [sourceId] },
    })),
    order: [], finishReason: "question_budget_exhausted",
  };
  state.order = state.candidates.map((c) => c.entityId);
  const sessions = createSessionService({ store: deps.store, settings: deps.config.session, mode: deps.config.mode });
  return { deps, state, sessions };
}
