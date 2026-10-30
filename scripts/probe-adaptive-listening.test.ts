import { createRequire } from "node:module";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { expect, it } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { createGeminiSongSelector } from "@/lib/agent/song-selector";
import { createFetchGeminiTransport } from "@/lib/agent/gemini-transport";
import { estimateCostUsd, usageFrom } from "@/lib/agent/pricing";
import { adaptiveFixture } from "../tests/helpers/adaptive-listening";
import { createRedisSessionStore } from "@/lib/session/redis-store";
import { createSessionService } from "@/lib/session/service";
import { listeningFeedback, startListening } from "@/lib/discovery/service";
import { ARTISTS } from "./lib/qloo-stub.mjs";
import { normalizeTargetCandidates } from "@/lib/discovery/normalize";

/** Explicit opt-in; uses retained Qloo data. No Qloo/YouTube network boundary exists here. */
it.skipIf(process.env.RUN_ADAPTIVE_LISTENING_LIVE !== "1")("S9.16 real Gemini and Redis transitions", async () => {
  createRequire(import.meta.url)("@next/env").loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  const config = loadConfig({ ...process.env, NODE_ENV: "test", QLOO_MODE: "live", SESSION_STORE: "redis", ADAPTIVE_LISTENING_ENABLED: "true" });
  expect(config.llm.model).toBe("gemini-3.5-flash-lite");
  if (config.sessionStore.kind !== "redis" || !config.llm.apiKey) throw new Error("Missing live configuration");
  const dir = resolve(".artifacts/s9-16"); mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "cost-ledger.json");
  type Entry = { state: "reserved" | "measured"; reserveInr: number; usage?: unknown; estimatedUsd?: number; estimatedInr?: number; status?: number; latencyMs?: number; output?: unknown };
  const ledger: { version: number; ceilingInr: number; accountingInrPerUsd: number; calls: Entry[] } = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, ceilingInr: 250, accountingInrPerUsd: 100, calls: [] };
  const persist = () => writeFileSync(path, JSON.stringify(ledger, null, 2));
  const real = createFetchGeminiTransport(config.llm.apiKey);
  let calls = 0;
  const transport: typeof real = async (request) => {
    const spent = ledger.calls.reduce((s, c) => s + (c.estimatedInr ?? c.reserveInr), 0);
    if (ledger.calls.some((c) => c.state !== "measured") || spent >= 200 || spent + 5 > 250 || calls >= 3) throw new Error("Budget visibility/review gate");
    if (spent >= 150) console.warn("S9.16 budget warning: INR150 threshold");
    if (JSON.stringify(request.body).length > 40_000) throw new Error("Request exceeds reservation envelope");
    const entry: Entry = { state: "reserved", reserveInr: 5 }; ledger.calls.push(entry); persist(); calls++;
    const started = performance.now();
    const response = await real(request);
    const meta = (response.body as { usageMetadata?: unknown })?.usageMetadata;
    if (!meta) throw new Error("Missing billable usage: stop campaign");
    const usage = usageFrom(meta); const usd = estimateCostUsd(request.model, usage);
    if (usd === null) throw new Error("Unknown pricing: stop campaign");
    Object.assign(entry, { state: "measured", usage, estimatedUsd: usd, estimatedInr: usd * ledger.accountingInrPerUsd, status: response.status, latencyMs: performance.now() - started, output: (response.body as { candidates?: unknown }).candidates }); persist();
    return response;
  };
  const client = new Redis({ url: config.sessionStore.url, token: config.sessionStore.token, retry: false, automaticDeserialization: false });
  const store = createRedisSessionStore(client);
  const f = adaptiveFixture(); f.deps.config = config; f.deps.store = store;
  f.deps.songSelector = createGeminiSongSelector({ model: config.llm.model!, temperature: 0.2, timeoutMs: 15_000, transport });
  f.state.session.mode = "live";
  f.state.candidates = normalizeTargetCandidates({ payload: { success: true, results: { entities: ARTISTS } }, provenance: "qloo", requestId: "retained-s9-8-evidence" } as Parameters<typeof normalizeTargetCandidates>[0], f.state.session.anchorIds, 30, { targetType: "music_artist", provenance: "qloo" }).candidates;
  f.state.order = f.state.candidates.map((c) => c.entityId);
  const sessions = createSessionService({ store, settings: config.session, mode: "live" });
  const results: unknown[] = [];
  if (process.env.ADAPTIVE_LISTENING_COUNTERFACTUAL === "1") {
    const finalGuard = process.env.ADAPTIVE_LISTENING_COUNTERFACTUAL_FINAL === "1";
    for (const tag of finalGuard ? ["urn:tag:genre:qloo:contemporary_classical"] : ["urn:tag:genre:qloo:ambient", "urn:tag:genre:qloo:contemporary_classical"]) {
      for (const variant of ["B1", "B2"] as const) {
        const state = structuredClone(f.state); state.session.sessionId = randomUUID();
        state.session.positiveTagIds = [tag];
        state.session.answers = [{ questionId: "experiment:confirmed-tag", targetType: "tag", targetIds: [tag], response: "like", timestamp: Date.now() }];
        const deps = variant === "B2" ? f.deps : { ...f.deps, songSelector: undefined };
        try {
          // Same initial recording and inventory for all variants; paid comparison only after LOVE.
          let v = await startListening({ ...deps, songSelector: undefined }, { sessionToken: await sessions.create(state), artistId: state.candidates[0]!.entityId });
          const current = v.listening!.video!;
          v = await listeningFeedback(deps, { sessionToken: v.sessionToken, artistId: current.artistId, videoId: current.videoId, action: "LOVE" });
          const loaded = await sessions.load(v.sessionToken);
          results.push({ variant, tag, current: current.videoId, upNext: v.listening?.upNext?.videoId, decision: loaded.state.listening?.contextualDecision });
        } finally { await store.expire(state.session.sessionId); }
      }
    }
    writeFileSync(resolve(dir, finalGuard ? "live-counterfactual-final-guard.json" : "live-counterfactual.json"), JSON.stringify({ model: config.llm.model, results, calls, newQloo: 0, newYoutube: 0 }, null, 2));
    console.log("S9_16_LIVE_COUNTERFACTUAL", JSON.stringify({ calls, results, estimatedInr: ledger.calls.reduce((s, e) => s + (e.estimatedInr ?? e.reserveInr), 0) }));
    return;
  }
  try {
    let v = await startListening(f.deps, { sessionToken: await sessions.create(f.state) });
    for (const action of ["LOVE", "NEXT", "NOT_FOR_ME", "NOT_FOR_ME"] as const) {
      const before = v.listening!.video!;
      v = await listeningFeedback(f.deps, { sessionToken: v.sessionToken, artistId: before.artistId, videoId: before.videoId, action });
      results.push({ action, before: before.videoId, after: v.listening?.video?.videoId, upNext: v.listening?.upNext?.videoId, selection: v.listening?.selection, revision: v.revision });
      if (action === "LOVE") expect(v.listening!.video!.videoId).toBe(before.videoId);
      if (action === "NOT_FOR_ME") expect(v.listening!.video!.videoId).not.toBe(before.videoId);
    }
    writeFileSync(resolve(dir, "live-results.json"), JSON.stringify({ model: config.llm.model, results, calls, newQloo: 0, newYoutube: 0, usedRedis: true }, null, 2));
    console.log("S9_16_LIVE", JSON.stringify({ calls, results, estimatedInr: ledger.calls.reduce((s, e) => s + (e.estimatedInr ?? e.reserveInr), 0), conversion: "Conservative accounting INR100/USD, not an exchange-rate/billing claim" }));
  } finally { await store.expire(f.state.session.sessionId); }
}, 90_000);
