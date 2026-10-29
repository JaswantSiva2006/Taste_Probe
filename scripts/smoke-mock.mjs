#!/usr/bin/env node
/**
 * HTTP end-to-end smoke test in mock mode.
 *
 * Default: starts `next dev` on a free port with QLOO_MODE=mock, an ephemeral
 * in-memory SESSION_SIGNING_SECRET and blanked API keys. Explicit process env
 * values take precedence over .env files in Next.js, so a live-mode
 * .env.local cannot switch this run to live. The server is killed on exit.
 *
 * Alternative: SMOKE_BASE_URL=http://localhost:3000 uses an already-running
 * server, which must report mode=mock via /api/health or the smoke aborts.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const STARTUP_TIMEOUT_MS = 180_000;
let child = null;
const serverLog = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function stopServer() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    // Kill the whole tree: next dev forks worker processes.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

async function startServer() {
  const port = await freePort();
  const nextBin = require.resolve("next/dist/bin/next");
  child = spawn(process.execPath, [nextBin, "dev", "--port", String(port), "--hostname", "127.0.0.1"], {
    env: {
      ...process.env,
      QLOO_MODE: "mock",
      SESSION_SIGNING_SECRET: randomBytes(32).toString("hex"),
      QLOO_API_KEY: "",
      GOOGLE_API_KEY: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const keep = (chunk) => {
    serverLog.push(chunk.toString());
    if (serverLog.length > 200) serverLog.shift();
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  return `http://127.0.0.1:${port}`;
}

async function waitForHealth(base) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let serverErrors = 0;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}`);
    let res = null;
    try {
      res = await fetch(`${base}/api/health`);
    } catch {
      // not listening yet
    }
    if (res?.ok) return res.json();
    // A listening server that keeps failing (e.g. a compile error) will not recover on its own.
    if (res && ++serverErrors >= 20) throw new Error(`/api/health kept failing (HTTP ${res.status})`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for /api/health");
}

async function call(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  assert.ok(json.meta?.requestId, `${path}: missing meta.requestId`);
  assert.equal(json.meta.mode, "mock", `${path}: meta.mode must be mock`);
  return { status: res.status, json };
}

const order = (view) => view.recommendations.map((r) => r.candidate.entityId);
const allMock = (view) => view.recommendations.every((r) => r.candidate.evidence.source === "mock");
const step = (msg) => console.log(`  [ok] ${msg}`);

async function run(base) {
  const health = await waitForHealth(base);
  assert.equal(health.data.mode, "mock", "server is not in mock mode; refusing to run");
  step(`health: mode=${health.data.mode}`);

  const search = await call(base, "GET", "/api/entities/search?q=Interstellar&type=movie");
  assert.equal(search.status, 200);
  const seed = search.json.data.results.find((r) => r.name === "Interstellar");
  assert.ok(seed, "Interstellar not found in search");
  assert.equal(seed.provenance, "mock");
  step(`search: selected ${seed.entityId}`);

  const start = await call(base, "POST", "/api/discovery/start", {
    entityQuery: seed.name,
    sourceType: "movie",
    targetType: "book",
    maxQuestions: 3,
    selectedEntityId: seed.entityId,
  });
  assert.equal(start.status, 200, JSON.stringify(start.json.error));
  const v0 = start.json.data;
  assert.equal(v0.status, "asking");
  assert.ok(v0.currentQuestion, "no question generated");
  assert.ok(v0.recommendations.length >= 2, "shortlist too small");
  assert.ok(allMock(v0), "initial shortlist must be mock-labelled");
  step(`start: ${v0.recommendations.length} candidates, question "${v0.currentQuestion.text}"`);

  const badQ = await call(base, "POST", "/api/discovery/answer", {
    sessionToken: v0.sessionToken,
    questionId: "tag:mock:tag:not-real",
    response: "like",
  });
  assert.equal(badQ.status, 400);
  assert.equal(badQ.json.error.code, "INVALID_QUESTION");
  step("answer: invalid question rejected (400)");

  const a1 = await call(base, "POST", "/api/discovery/answer", {
    sessionToken: v0.sessionToken,
    questionId: v0.currentQuestion.questionId,
    response: "like",
  });
  assert.equal(a1.status, 200, JSON.stringify(a1.json.error));
  const v1 = a1.json.data;
  assert.deepEqual(v1.preferences.positiveTagIds, v0.currentQuestion.targetIds);
  assert.equal(v1.rankingChanged, true, "rankingChanged should be true after a liked tag");
  assert.notDeepEqual(order(v1), order(v0), "recommendation order did not change");
  step(`answer: order changed\n      before ${order(v0).join(", ")}\n      after  ${order(v1).join(", ")}`);

  const fin = await call(base, "POST", "/api/discovery/finish", { sessionToken: v1.sessionToken });
  assert.equal(fin.status, 200, JSON.stringify(fin.json.error));
  const done = fin.json.data;
  assert.equal(done.status, "finished");
  assert.equal(done.finishReason, "user_finished");
  assert.ok(done.recommendations.length > 0 && done.recommendations.length <= 5);
  assert.ok(allMock(done), "final recommendations must be mock-labelled");
  assert.ok(done.questionCount <= 3);
  step(`finish: ${done.recommendations.length} final mock recommendations, top = ${done.recommendations[0].candidate.name}`);

  // S9.2: additive Discovery Path over the same final list.
  const path = done.discoveryPath;
  const ids = done.recommendations.map((r) => r.candidate.entityId);
  const pathIds = [...path.featured.map((f) => f.recommendationEntityId), ...path.remainingEntityIds];
  assert.equal(path.featured[0].role, "START_HERE");
  assert.equal(path.featured[0].recommendationEntityId, ids[0]);
  assert.equal(new Set(pathIds).size, pathIds.length, "discovery path must not repeat an entity");
  assert.deepEqual([...pathIds].sort(), [...ids].sort(), "discovery path must cover exactly the final recommendations");
  assert.ok(path.featured.every((f) => f.explanation.evidence.provenance === "mock" && !/Qloo returned/.test(f.explanation.text)));
  step(`discovery path: ${path.featured.map((f) => f.role).join(" > ")} + ${path.remainingEntityIds.length} more`);

  const after = await call(base, "POST", "/api/discovery/answer", {
    sessionToken: done.sessionToken,
    questionId: v1.currentQuestion?.questionId ?? v0.currentQuestion.questionId,
    response: "like",
  });
  assert.equal(after.status, 409);
  step(`answer after finish rejected (409 ${after.json.error.code})`);
}

async function main() {
  const external = process.env.SMOKE_BASE_URL;
  const base = external ?? (await startServer());
  console.log(`smoke:mock against ${base}${external ? " (existing server)" : " (spawned next dev, QLOO_MODE=mock)"}`);
  try {
    await run(base);
    console.log("SMOKE PASSED");
  } catch (error) {
    console.error(`SMOKE FAILED: ${error instanceof Error ? error.message : error}`);
    if (serverLog.length) console.error("--- server output (tail) ---\n" + serverLog.join("").slice(-4000));
    process.exitCode = 1;
  } finally {
    stopServer();
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopServer();
    process.exit(130);
  });
}

await main();
