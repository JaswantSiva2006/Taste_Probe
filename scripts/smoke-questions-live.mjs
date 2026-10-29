#!/usr/bin/env node
/** Route-level S8.5 smoke: real Qloo retrieval + one Gemini proposal call + S6 decision. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
const secrets = [process.env.QLOO_API_KEY, process.env.GOOGLE_API_KEY].filter(Boolean);
const redact = (value) => secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), String(value));
let child;
const logs = [];

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function stop() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}

async function start() {
  const missing = ["QLOO_API_KEY", "GOOGLE_API_KEY", "LLM_MODEL"].filter((key) => !process.env[key]?.trim());
  assert.deepEqual(missing, [], "Missing live variable(s): " + missing.join(", "));
  const port = await freePort();
  child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--port", String(port), "--hostname", "127.0.0.1"], {
    env: {
      ...process.env,
      QLOO_MODE: "live",
      LLM_PROVIDER: "google",
      QUESTION_GENERATION_MODE: "llm_grounded",
      MAX_RECOMMENDATION_CANDIDATES: "30",
      SESSION_STORE: "memory",
      SESSION_SIGNING_SECRET: process.env.SESSION_SIGNING_SECRET || randomBytes(32).toString("hex"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const keep = (chunk) => { logs.push(redact(chunk)); if (logs.length > 100) logs.shift(); };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  return "http://127.0.0.1:" + port;
}

async function call(base, path, init) {
  const response = await fetch(base + path, init);
  const json = await response.json();
  return { response, json };
}

async function waitForHealth(base) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("server exited with " + child.exitCode);
    try {
      const result = await call(base, "/api/health");
      if (result.response.ok) return result.json;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("server startup timed out");
}

async function main() {
  const wallStarted = Date.now();
  const base = await start();
  try {
    const health = await waitForHealth(base);
    assert.equal(health.data.mode, "live");
    const search = await call(base, "/api/entities/search?q=Interstellar&type=movie");
    assert.equal(search.response.status, 200, JSON.stringify(search.json.error));
    const seed = search.json.data.results.find((item) => item.name === "Interstellar");
    assert.ok(seed?.entityId && !seed.entityId.startsWith("mock:"));
    const startResult = await call(base, "/api/discovery/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entityQuery: seed.name,
        sourceType: "movie",
        targetType: "book",
        maxQuestions: 3,
        selectedEntityId: seed.entityId,
      }),
    });
    assert.equal(startResult.response.status, 200, JSON.stringify(startResult.json.error));
    const view = startResult.json.data;
    const generation = view.trace?.questionGeneration;
    assert.equal(generation?.mode, "llm_grounded");
    assert.ok(generation.generated > 0, "Gemini returned no structured proposals");
    assert.ok(generation.accepted > 0, "evidence validation accepted no proposals");
    assert.ok(generation.selected, "S5 selected no validated proposal");
    assert.equal(view.currentQuestion?.questionId, generation.selected.questionId, "S6 did not receive the highest-scoring question only");
    assert.ok(generation.selected.evidenceIds.every((id) =>
      view.recommendations.some((item) =>
        item.candidate.entityId === id || item.candidate.tags.some((tag) => tag.id === id),
      ),
    ), "selected evidence ID is absent from Qloo candidates");
    assert.notDeepEqual(generation.selected.positiveTop, generation.selected.negativeTop, "answer mapping does not change ranking");
    assert.ok(view.trace.qlooRequests <= 2, "start exceeded two Qloo requests");
    assert.ok(view.trace.geminiRequests <= 3, "start exceeded three Gemini requests");
    assert.ok((view.trace.estimatedGeminiCostUsd ?? 1) < 0.5, "Gemini cost cap exceeded");
    const before = view.recommendations.map((item) => item.candidate.entityId);
    const answerValue = view.currentQuestion.targetType === "tag" ? "like" : "prefer_a";
    const answer = await call(base, "/api/discovery/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionToken: view.sessionToken, questionId: view.currentQuestion.questionId, response: answerValue }),
    });
    assert.equal(answer.response.status, 200, JSON.stringify(answer.json.error));
    const updated = answer.json.data;
    const after = updated.recommendations.map((item) => item.candidate.entityId);
    assert.notDeepEqual(after, before, "executable answer mapping did not update recommendation order");
    const totalCost = (view.trace.estimatedGeminiCostUsd ?? 0) + (updated.trace?.estimatedGeminiCostUsd ?? 0);
    assert.ok(totalCost < 0.5, "combined live trial Gemini cost cap exceeded");
    console.log(JSON.stringify({
      status: "PASS",
      level: "HTTP routes",
      generated: generation.generated,
      accepted: generation.accepted,
      rejected: generation.rejected,
      fallbackReason: generation.fallbackReason,
      selectedQuestion: view.currentQuestion.text,
      availableCandidateCount: view.recommendations.length,
      evidenceIds: generation.selected.evidenceIds,
      components: generation.selected.components,
      counterfactualTop5: { positive: generation.selected.positiveTop, negative: generation.selected.negativeTop },
      recommendationUpdate: { response: answerValue, rankingChanged: updated.rankingChanged, before: before.slice(0, 5), after: after.slice(0, 5) },
      qlooRequests: 3 + (updated.trace?.qlooRequests ?? 0),
      geminiRequests: view.trace.geminiRequests + (updated.trace?.geminiRequests ?? 0),
      tokens: view.trace.geminiTokens,
      estimatedGeminiCostUsd: totalCost,
      routeLatencyMs: view.trace.latencyMs + (updated.trace?.latencyMs ?? 0),
      wallLatencyMs: Date.now() - wallStarted,
    }, null, 2));
  } catch (error) {
    console.error(redact("SMOKE FAILED: " + (error instanceof Error ? error.message : error)));
    if (logs.length) console.error(logs.join("").slice(-5000));
    process.exitCode = 1;
  } finally {
    stop();
  }
}

await main();
