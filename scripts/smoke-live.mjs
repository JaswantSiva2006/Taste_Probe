#!/usr/bin/env node
/**
 * S7 genuine live HTTP E2E smoke (npm run smoke:live).
 *
 * Starts `next dev` in QLOO_MODE=live with the real Qloo provider and the real
 * Gemini agent, then drives the actual HTTP routes:
 *   search -> start -> answer -> finish   (Interstellar -> books)
 *
 * Hard limits for one run: <= 5 Qloo network requests, <= 3 Gemini requests,
 * < $0.05 estimated Gemini cost. Counts come from the server's per-request trace
 * (plus the smoke's own search). Exceeding a limit FAILS the run; limits are never raised.
 *
 * Session storage: Redis if UPSTASH_* is configured, otherwise the non-production
 * in-memory development store (labelled as such). Never prints tokens or credentials.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd(), true, { info() {}, error() {} });

const LIMITS = { qloo: 5, gemini: 3, costUsd: 0.05 };
const secrets = [process.env.QLOO_API_KEY, process.env.GOOGLE_API_KEY, process.env.SESSION_SIGNING_SECRET, process.env.UPSTASH_REDIS_REST_TOKEN].filter(
  (s) => s && s.length >= 6,
);
const redact = (v) => secrets.reduce((t, s) => t.split(s).join("[REDACTED]"), String(v));
const say = (v = "") => console.log(redact(v));
const logs = [];
let child;

const usage = { qloo: 0, gemini: 0, costUsd: 0, tokens: { input: 0, output: 0, thinking: 0 } };
function account(label, trace) {
  usage.qloo += trace.qlooRequests;
  usage.gemini += trace.geminiRequests;
  usage.costUsd += trace.estimatedGeminiCostUsd ?? 0;
  for (const k of ["input", "output", "thinking"]) usage.tokens[k] += trace.geminiTokens[k];
  say(`  ${label}: qloo=${trace.qlooRequests} gemini=${trace.geminiRequests} latency=${trace.latencyMs}ms decisions=${JSON.stringify(trace.decisions)}`);
  assert.ok(usage.qloo <= LIMITS.qloo, `Qloo request budget exceeded (${usage.qloo} > ${LIMITS.qloo}); not raising the limit`);
  assert.ok(usage.gemini <= LIMITS.gemini, `Gemini request budget exceeded (${usage.gemini} > ${LIMITS.gemini}); not raising the limit`);
  assert.ok(usage.costUsd < LIMITS.costUsd, `Gemini cost budget exceeded ($${usage.costUsd})`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function stop() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}

async function startServer() {
  const missing = ["QLOO_API_KEY", "GOOGLE_API_KEY", "LLM_MODEL"].filter((k) => !process.env[k]?.trim());
  assert.deepEqual(missing, [], `missing environment variables: ${missing.join(", ")}`);
  const port = await freePort();
  child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--port", String(port), "--hostname", "127.0.0.1"], {
    env: {
      ...process.env,
      QLOO_MODE: "live",
      QLOO_BASE_URL: process.env.QLOO_BASE_URL || "https://hackathon.api.qloo.com",
      // Ephemeral in-memory secret if none is configured (development only).
      SESSION_SIGNING_SECRET: process.env.SESSION_SIGNING_SECRET || randomBytes(32).toString("hex"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const keep = (c) => {
    logs.push(redact(c));
    if (logs.length > 200) logs.shift();
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  return `http://127.0.0.1:${port}`;
}

async function call(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  assert.equal(json.meta?.mode, "live", `${path}: response not in live mode`);
  assert.equal(res.status, 200, `${path}: HTTP ${res.status} ${json.error?.code}: ${json.error?.message}`);
  return json.data;
}

async function waitForHealth(base) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/api/health`);
      const json = await res.json();
      if (res.ok) return json.data;
      if (json?.error) throw new Error(`health: ${json.error.code}: ${json.error.message}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("health:")) throw e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server startup timed out");
}

function assertGrounded(view, label) {
  assert.ok(view.recommendations.length > 0, `${label}: no recommendations`);
  for (const { candidate: c } of view.recommendations) {
    assert.equal(c.evidence.source, "qloo", `${label}: non-Qloo provenance`);
    assert.ok(!c.entityId.startsWith("mock:"), `${label}: mock entity in live results`);
    assert.equal(c.entityType, "book", `${label}: wrong entity type`);
    assert.match(c.evidence.requestId, /^[0-9a-f-]{36}$/, `${label}: missing internal correlation ID`);
  }
}

const top = (view) => view.recommendations.slice(0, 5).map((r) => `${r.candidate.name} [${r.candidate.entityId.slice(0, 8)}]`);

async function main() {
  const t0 = Date.now();
  const base = await startServer();
  say(`smoke:live against ${base} (next dev, QLOO_MODE=live, real Qloo + real Gemini)`);
  try {
    const health = await waitForHealth(base);
    assert.equal(health.mode, "live");
    assert.match(health.agent, /^gemini-agent/, `agent is "${health.agent}", expected the real Gemini agent`);
    say(`  health: mode=${health.mode} agent=${health.agent}`);

    // 1. Search (1 Qloo request, made by the smoke itself)
    const search = await call(base, "GET", "/api/entities/search?q=Interstellar&type=movie");
    usage.qloo += 1;
    const seed = search.results.find((r) => r.name === "Interstellar");
    assert.ok(seed && !seed.entityId.startsWith("mock:") && seed.provenance === "qloo", "real Interstellar not found");
    say(`  search: Interstellar -> ${seed.entityId}`);

    // 2-5. Start: verified seed, real books, Gemini decision, approved question
    const v0 = await call(base, "POST", "/api/discovery/start", {
      entityQuery: seed.name, sourceType: "movie", targetType: "book", maxQuestions: 3, selectedEntityId: seed.entityId,
    });
    account("start", v0.trace);
    assertGrounded(v0, "start");
    assert.equal(v0.recommendationUpdate.mechanism, "INITIAL_RETRIEVAL");
    assert.equal(v0.agent.mode, "LIVE_GEMINI", `start decision was ${v0.agent.mode} (${v0.agent.fallbackReason}), not a real Gemini decision`);
    const store = v0.trace.sessionStore;
    say(`  session store: ${store === "memory" ? "IN-MEMORY DEVELOPMENT STORE (non-production; no cross-instance guarantees)" : "Upstash Redis"}`);
    say(`  start: ${v0.recommendations.length} Qloo books; top5 = ${top(v0).join(" | ")}`);
    say(`  gemini decision: ${v0.agent.decision.action} ${v0.agent.decision.selectedQuestionId ?? ""} (mode ${v0.agent.mode})`);
    assert.equal(v0.status, "asking", "Gemini finished immediately; no question to answer in this run");
    const q = v0.currentQuestion;
    assert.ok(q && q.questionId === v0.agent.decision.selectedQuestionId, "displayed question is not the selected approved question");
    assert.equal(q.text, v0.agent.decision.questionText, "displayed text is not the approved S5 wording");
    say(`  question: ${q.questionId} — "${q.text}"`);

    // 6-8. Answer with an explicit positive preference
    const response = q.allowedResponses.includes("like") ? "like" : "prefer_a";
    const v1 = await call(base, "POST", "/api/discovery/answer", { sessionToken: v0.sessionToken, questionId: q.questionId, response });
    account("answer", v1.trace);
    assertGrounded(v1, "answer");
    const prefs = [...v1.preferences.positiveTagIds, ...v1.preferences.positiveEntityIds];
    assert.ok(prefs.length > 0, "explicit preference was not recorded");
    assert.deepEqual(v1.recommendationUpdate.preferenceIds.sort(), prefs.sort());
    const u = v1.recommendationUpdate;
    // Truthfulness: reretrieval claimed iff a Qloo Insights request ran in this request.
    if (u.mechanism === "QLOO_RERETRIEVAL") {
      assert.ok(u.qlooRequested && u.internalCorrelationIds.length > 0 && v1.trace.qlooRequests > 0, "reretrieval claimed without a Qloo request");
    } else {
      assert.equal(u.qlooRequested, false);
      assert.equal(v1.trace.qlooRequests, 0, "Qloo was called but the update is not labelled as reretrieval");
      assert.ok(["LOCAL_RERANK", "UNCHANGED"].includes(u.mechanism), `unexpected mechanism ${u.mechanism}`);
      if (u.mechanism === "UNCHANGED") assert.deepEqual(u.updatedTopIds, u.previousTopIds, "UNCHANGED reported but the top 5 moved");
    }
    say(`  answer: ${response} -> preferences ${JSON.stringify(prefs)}`);
    say(`  update: ${u.mechanism} (qlooRequested=${u.qlooRequested}); top5 before = ${u.previousTopIds.map((i) => i.slice(0, 8)).join(",")}`);
    say(`                                      top5 after  = ${u.updatedTopIds.map((i) => i.slice(0, 8)).join(",")}`);
    say(`  next decision: ${v1.agent.decision.action} ${v1.agent.decision.selectedQuestionId ?? ""} (mode ${v1.agent.mode}${v1.agent.fallbackReason ? `, ${v1.agent.fallbackReason}` : ""})${v1.degraded ? ` DEGRADED=${v1.degraded.reason}` : ""}`);

    // 9-10. Finish and verify grounded final recommendations
    const done = await call(base, "POST", "/api/discovery/finish", { sessionToken: v1.sessionToken });
    assert.equal(done.status, "finished");
    assert.ok(done.recommendations.length <= 5);
    assertGrounded(done, "finish");
    say(`  finish: ${done.recommendations.length} grounded books: ${top(done).join(" | ")}`);
    say(`  session usage: qlooCallCount=${done.usage.qlooCallCount}/${done.usage.maxQlooCalls} geminiRequestCount=${done.usage.geminiRequestCount}`);

    say("");
    say(`USAGE: qloo=${usage.qloo}/${LIMITS.qloo} gemini=${usage.gemini}/${LIMITS.gemini} tokens(in/out/thinking)=${usage.tokens.input}/${usage.tokens.output}/${usage.tokens.thinking} estGeminiCost=$${usage.costUsd.toFixed(6)} wall=${Date.now() - t0}ms`);
    say("SMOKE LIVE PASSED");
  } catch (error) {
    console.error(redact(`SMOKE LIVE FAILED: ${error instanceof Error ? error.message : error}`));
    console.error(redact(`usage so far: qloo=${usage.qloo} gemini=${usage.gemini} estCost=$${usage.costUsd.toFixed(6)}`));
    if (logs.length) console.error(redact(logs.join("").slice(-3000)));
    process.exitCode = 1;
  } finally {
    stop();
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stop(); process.exit(130); });
await main();
