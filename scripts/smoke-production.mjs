#!/usr/bin/env node
/** Bounded production-build E2E: real Redis, Qloo and Gemini through HTTP routes. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
const secretValues = [process.env.QLOO_API_KEY, process.env.GOOGLE_API_KEY, process.env.UPSTASH_REDIS_REST_TOKEN, process.env.SESSION_SIGNING_SECRET].filter(Boolean);
const redact = (value) => secretValues.reduce((text, secret) => text.split(secret).join("[REDACTED]"), String(value)).replace(/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[SESSION_TOKEN]");
let child;
const logs = [];

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.unref();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

function stop() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}

async function launch() {
  const required = ["QLOO_API_KEY", "GOOGLE_API_KEY", "LLM_MODEL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "SESSION_SIGNING_SECRET"];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing production variable(s): ${missing.join(", ")}`);
  const port = await freePort();
  child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--port", String(port), "--hostname", "127.0.0.1"], {
    env: { ...process.env, NODE_ENV: "production", QLOO_MODE: "live", SESSION_STORE: "redis", RATE_LIMIT_ENABLED: "true", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
  });
  const keep = (chunk) => { logs.push(redact(chunk)); if (logs.length > 100) logs.shift(); };
  child.stdout.on("data", keep); child.stderr.on("data", keep);
  return `http://127.0.0.1:${port}`;
}

async function call(base, path, init) {
  const started = performance.now();
  const response = await fetch(base + path, init);
  const json = await response.json();
  return { response, json, latencyMs: Math.round(performance.now() - started) };
}

async function wait(base) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production server exited (${child.exitCode})`);
    try { const result = await call(base, "/api/health"); if (result.response.ok) return result; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("production server startup timed out");
}

const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function main() {
  const usage = { qloo: 0, gemini: 0, costUsd: 0 };
  const latency = {};
  try {
    const base = await launch();
    const health = await wait(base);
    assert.equal(health.json.data.mode, "live");
    assert.equal(health.json.data.readiness.sessionStore, "redis", "production did not select Redis");

    const search = await call(base, "/api/entities/search?q=Interstellar&type=movie");
    latency.search = search.latencyMs; usage.qloo += 1;
    assert.equal(search.response.status, 200, JSON.stringify(search.json.error));
    const seed = search.json.data.results.find((item) => item.name === "Interstellar");
    assert.ok(seed?.entityId && seed.provenance === "qloo");

    const start = await call(base, "/api/discovery/start", post({ entityQuery: seed.name, selectedEntityId: seed.entityId, sourceType: "movie", targetType: "book", maxQuestions: 3 }));
    latency.start = start.latencyMs;
    assert.equal(start.response.status, 200, JSON.stringify(start.json.error));
    const v0 = start.json.data;
    assert.equal(v0.revision, 0); assert.equal(v0.trace.sessionStore, "redis");
    assert.ok(v0.recommendations.length > 0 && v0.recommendations.every((item) => item.candidate.evidence.source === "qloo"));
    usage.qloo += v0.trace.qlooRequests; usage.gemini += v0.trace.geminiRequests; usage.costUsd += v0.trace.estimatedGeminiCostUsd ?? 0;

    const response = v0.currentQuestion.targetType === "tag" ? "like" : "prefer_a";
    const answer = await call(base, "/api/discovery/answer", post({ sessionToken: v0.sessionToken, questionId: v0.currentQuestion.questionId, response }));
    latency.answer = answer.latencyMs;
    assert.equal(answer.response.status, 200, JSON.stringify(answer.json.error));
    const v1 = answer.json.data;
    assert.equal(v1.revision, 1); assert.equal(v1.trace.sessionStore, "redis");
    assert.equal(v1.lastAnswer.questionId, v0.currentQuestion.questionId);
    usage.qloo += v1.trace.qlooRequests; usage.gemini += v1.trace.geminiRequests; usage.costUsd += v1.trace.estimatedGeminiCostUsd ?? 0;

    const replay = await call(base, "/api/discovery/answer", post({ sessionToken: v0.sessionToken, questionId: v0.currentQuestion.questionId, response }));
    assert.equal(replay.response.status, 409); assert.equal(replay.json.error.code, "SESSION_REVISION_CONFLICT");

    const finish = await call(base, "/api/discovery/finish", post({ sessionToken: v1.sessionToken }));
    latency.finish = finish.latencyMs;
    assert.equal(finish.response.status, 200, JSON.stringify(finish.json.error));
    assert.equal(finish.json.data.status, "finished"); assert.equal(finish.json.data.revision, 2);

    assert.ok(usage.qloo <= 5, `Qloo request cap exceeded: ${usage.qloo}`);
    assert.ok(usage.gemini <= 3, `Gemini request cap exceeded: ${usage.gemini}`);
    assert.ok(usage.costUsd < 0.05, `Gemini cost cap exceeded: ${usage.costUsd}`);
    console.log(JSON.stringify({ status: "PASS", sessionStore: "redis", revisions: [0, 1, 2], groundedRecommendations: v0.recommendations.length, usage: { ...usage, costUsd: Math.round(usage.costUsd * 1e8) / 1e8 }, latencyMs: latency }, null, 2));
  } catch (error) {
    console.error(redact(`PRODUCTION SMOKE FAILED: ${error instanceof Error ? error.message : error}`));
    if (logs.length) console.error(logs.join("").slice(-5000));
    process.exitCode = 1;
  } finally { stop(); }
}

await main();
