import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { it, expect } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { createSession, type SessionState } from "@/lib/session/state";
import { createSessionService } from "@/lib/session/service";
import { startListening, listeningFeedback } from "@/lib/discovery/service";

it.skipIf(process.env.RUN_SUPPLY_LISTENING_LIVE !== "1")("retained Qloo + real quota-guarded YouTube + real Redis listening funnel", async () => {
  createRequire(import.meta.url)("@next/env").loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  const dir = resolve(".artifacts/s9-16r"), path = resolve(dir, "listening-live.json");
  if (existsSync(path)) { console.log("Existing S9.16R listening run retained; no repeated provider campaign"); return; }
  const recorded = JSON.parse(readFileSync(resolve(dir, "qloo-ledger.json"), "utf8"));
  const config = loadConfig({ ...process.env, NODE_ENV: "test", QLOO_MODE: "live", SESSION_STORE: "redis", ADAPTIVE_LISTENING_ENABLED: "true", ADAPTIVE_POOL_ENABLED: "false", LLM_PROVIDER: "none", MAX_RECOMMENDATION_CANDIDATES: "50" });
  const deps = createDiscoveryDeps(config);
  deps.provider = { mode: "live", searchEntities: async () => { throw new Error("Qloo campaign exhausted"); }, getEntity: async () => { throw new Error("Qloo campaign exhausted"); }, getRecommendations: async () => { throw new Error("Qloo campaign exhausted"); } };
  const state: SessionState = { session: { ...createSession({ anchorIds: [recorded.results.anchor.entityId], sourceType: "music_artist", targetType: "music_artist", maxQuestions: 3, mode: "live", now: Date.now(), ttlSeconds: 1800 }), status: "finished", qlooCallCount: 6 }, seed: recorded.results.anchor, candidates: recorded.results.base.candidates, order: recorded.results.base.candidates.map((c: { entityId: string }) => c.entityId), finishReason: "question_budget_exhausted" };
  const sessions = createSessionService({ store: deps.store, settings: config.session, mode: "live" });
  const snapshots: unknown[] = [], rows: unknown[] = [];
  const counts = { youtubeSearch: 0, youtubeVideos: 0, qloo: 0, gemini: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname.includes("qloo.com") || url.hostname === "generativelanguage.googleapis.com") throw new Error("Unexpected paid provider");
    if (url.hostname === "www.googleapis.com") {
      if (url.pathname.endsWith("/search")) counts.youtubeSearch++; else counts.youtubeVideos++;
      if (counts.youtubeSearch > 2 || counts.youtubeVideos > 2) throw new Error("S9.16R live listening request ceiling");
      writeFileSync(path, JSON.stringify({ status: "running", counts, snapshots, rows }, null, 2));
    }
    return realFetch(input, init);
  };
  // Reconstruct so the lookup captures the audited fetch boundary.
  deps.musicLookup = createDiscoveryDeps(config).musicLookup;
  try {
    let v = await startListening(deps, { sessionToken: await sessions.create(state) });
    for (let i = 0; i < 20; i++) {
      const loaded = await sessions.load(v.sessionToken); snapshots.push(loaded.state.listening?.supply);
      if (!v.listening?.video) break;
      const current = v.listening.video; rows.push({ artistId: current.artistId, videoId: current.videoId, title: current.title });
      v = await listeningFeedback(deps, { sessionToken: v.sessionToken, artistId: current.artistId, videoId: current.videoId, action: "NOT_FOR_ME" });
    }
    expect(counts.youtubeSearch).toBeLessThanOrEqual(2);
    writeFileSync(path, JSON.stringify({ status: "complete", counts, snapshots, rows, notice: v.listening?.notice }, null, 2));
    console.log("S9_16R_REAL_LISTENING", JSON.stringify({ counts, verifiedEncounters: rows.length, uniqueArtists: new Set((rows as Array<{ artistId: string }>).map((r) => r.artistId)).size, finalFunnel: (await sessions.load(v.sessionToken)).state.listening?.supply, notice: v.listening?.notice }));
  } finally { globalThis.fetch = realFetch; await deps.store.expire(state.session.sessionId); }
}, 90_000);
