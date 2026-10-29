#!/usr/bin/env node
/** Real Qloo-only HTTP smoke. Makes three Qloo calls: Search, ID resolution, Insights. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd(), true, { info() {}, error() {} });

const secrets = [process.env.QLOO_API_KEY].filter(Boolean);
const redact = (value) => secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), String(value));
const say = (value) => console.log(redact(value));
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
  assert.ok(process.env.QLOO_API_KEY, "QLOO_API_KEY is required");
  const port = await freePort();
  child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--port", String(port), "--hostname", "127.0.0.1"], {
    env: {
      ...process.env,
      QLOO_MODE: "live",
      SESSION_SIGNING_SECRET: process.env.SESSION_SIGNING_SECRET || randomBytes(32).toString("hex"),
      GOOGLE_API_KEY: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const keep = (chunk) => { logs.push(redact(chunk)); if (logs.length > 100) logs.shift(); };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  return `http://127.0.0.1:${port}`;
}

async function call(base, path, init) {
  const response = await fetch(`${base}${path}`, init);
  const json = await response.json();
  return { response, json };
}

async function wait(base) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const result = await call(base, "/api/health");
      if (result.response.ok) return result.json;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("server startup timed out");
}

async function main() {
  const base = await start();
  try {
    const health = await wait(base);
    assert.equal(health.data.mode, "live");
    assert.equal(health.data.qloo.implemented, true);
    assert.match(health.data.agent, /mock|deterministic/i, "agent must remain truthfully labelled as a placeholder");

    const search = await call(base, "/api/entities/search?q=Interstellar&type=movie");
    assert.equal(search.response.status, 200, JSON.stringify(search.json.error));
    const seed = search.json.data.results.find((item) => item.name === "Interstellar");
    assert.ok(seed?.entityId && !seed.entityId.startsWith("mock:"), "real Interstellar ID not found");
    assert.equal(seed.provenance, "qloo");

    const startResult = await call(base, "/api/discovery/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entityQuery: seed.name, sourceType: "movie", targetType: "book", maxQuestions: 3, selectedEntityId: seed.entityId }),
    });
    assert.equal(startResult.response.status, 200, JSON.stringify(startResult.json.error));
    const candidates = startResult.json.data.recommendations.map((item) => item.candidate);
    assert.ok(candidates.length > 0, "no normalized Qloo candidates");
    for (const candidate of candidates) {
      assert.ok(candidate.entityId && !candidate.entityId.startsWith("mock:"));
      assert.equal(candidate.entityType, "book");
      assert.equal(candidate.evidence.source, "qloo");
      assert.match(candidate.evidence.requestId, /^[0-9a-f-]{36}$/);
    }
    say(`SMOKE PASSED: search=PASS insights=PASS candidates=${candidates.length} tags=${candidates.reduce((n, c) => n + c.tags.length, 0)} qlooRequests=3 geminiCalls=0`);
  } catch (error) {
    console.error(redact(`SMOKE FAILED: ${error instanceof Error ? error.message : error}`));
    if (logs.length) console.error(logs.join("").slice(-4000));
    process.exitCode = 1;
  } finally {
    stop();
  }
}

await main();
