#!/usr/bin/env node
/** S9.11 bounded production-browser proof: max 5 Qloo, 2 Gemini, $0.01. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { begin, chooseSource, chooseWorld, searchAndSelect } from "./lib/ui-flow.mjs";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
if (!process.argv.includes("--confirm-live")) {
  console.error("This spends bounded live Qloo/Gemini requests. Re-run with --confirm-live.");
  process.exit(2);
}
const CAP = { qloo: 5, gemini: 2, costUsd: 0.01 };
const OUT = resolve(".artifacts/s9-11-live");
const LEDGER = resolve(OUT, "ledger.json");
await mkdir(OUT, { recursive: true });
const ledger = existsSync(LEDGER) ? JSON.parse(await readFile(LEDGER, "utf8")) : { campaign: CAP, qloo: 0, gemini: 0, costUsd: 0, runs: [] };
if (ledger.qloo >= CAP.qloo || ledger.gemini >= CAP.gemini || ledger.costUsd >= CAP.costUsd) throw new Error("S9.11 live campaign budget exhausted");

const secretValues = ["QLOO_API_KEY", "GOOGLE_API_KEY", "UPSTASH_REDIS_REST_TOKEN", "SESSION_SIGNING_SECRET", "UPSTASH_REDIS_REST_URL"].map((key) => process.env[key]).filter((value) => value?.length >= 8);
const redact = (value) => secretValues.reduce((text, secret) => text.split(secret).join("[REDACTED]"), String(value)).replace(/v\d\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[SESSION_TOKEN]");
const missing = ["QLOO_API_KEY", "GOOGLE_API_KEY", "LLM_MODEL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "SESSION_SIGNING_SECRET"].filter((key) => !process.env[key]?.trim());
if (missing.length) throw new Error(`BLOCKED: missing ${missing.join(", ")}`);
if (!existsSync(resolve(".next/BUILD_ID"))) throw new Error("BLOCKED: run npm run build first");

const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.unref(); server.on("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolvePort(value)); });
});
const logs = [];
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--port", String(port), "--hostname", "127.0.0.1"], {
  env: { ...process.env, NODE_ENV: "production", QLOO_MODE: "live", SESSION_STORE: "redis", RATE_LIMIT_ENABLED: "true", ADAPTIVE_POOL_ENABLED: "true", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
});
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { logs.push(redact(chunk)); if (logs.length > 300) logs.shift(); });
const stop = () => process.platform === "win32" ? spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }) : child.kill("SIGTERM");
const base = `http://127.0.0.1:${port}`;
let health;
for (let i = 0; i < 240; i += 1) {
  try { const response = await fetch(`${base}/api/health`); if (response.ok) { health = (await response.json()).data; break; } } catch {}
  await new Promise((done) => setTimeout(done, 500));
}
assert.equal(health?.mode, "live"); assert.equal(health?.readiness?.sessionStore, "redis");

const evidence = { at: new Date().toISOString(), source: null, initialIds: [], followUpIds: [], newIds: [], promotedIds: [], retainedIds: [], decision: null, family: null, revisions: [], usage: { qloo: 0, gemini: 0, costUsd: 0 }, replayStatus: null, latencyMs: {}, browser: null };
let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(120_000);
  const responses = new Map(); const started = new Map();
  page.on("request", (request) => { if (request.url().includes("/api/")) started.set(request, performance.now()); });
  page.on("response", async (response) => {
    if (!response.url().includes("/api/")) return;
    const route = new URL(response.url()).pathname.replace("/api/", "");
    try { responses.set(route, { status: response.status(), json: JSON.parse(await response.text()), ms: Math.round(performance.now() - (started.get(response.request()) ?? performance.now())) }); } catch {}
  });
  const waitResponse = async (route) => { for (let i = 0; i < 400 && !responses.has(route); i += 1) await page.waitForTimeout(50); assert.ok(responses.has(route), `missing ${route}`); return responses.get(route); };
  const charge = (trace) => {
    evidence.usage.qloo += trace?.qlooRequests ?? 0; evidence.usage.gemini += trace?.geminiRequests ?? 0; evidence.usage.costUsd += trace?.estimatedGeminiCostUsd ?? 0;
    ledger.qloo += trace?.qlooRequests ?? 0; ledger.gemini += trace?.geminiRequests ?? 0; ledger.costUsd += trace?.estimatedGeminiCostUsd ?? 0;
  };

  await page.goto(base, { waitUntil: "networkidle" });
  await chooseWorld(page, "Music artists"); await chooseSource(page, "a movie");
  await searchAndSelect(page, "Interstellar", "Interstellar", { timeout: 60_000 });
  const search = await waitResponse("entities/search"); ledger.qloo += 1; evidence.usage.qloo += 1; evidence.latencyMs.search = search.ms;
  const source = search.json.data.results.find((item) => item.name === "Interstellar");
  assert.ok(source?.entityId && source.provenance === "qloo"); evidence.source = { entityId: source.entityId, name: source.name };
  responses.delete("discovery/start"); await begin(page, { timeout: 120_000 });
  const start = await waitResponse("discovery/start"); assert.equal(start.status, 200); const v0 = start.json.data; charge(v0.trace); evidence.latencyMs.start = start.ms;
  assert.equal(v0.revision, 0); assert.equal(v0.trace.sessionStore, "redis"); assert.equal(v0.targetType, "music_artist");
  evidence.initialIds = v0.recommendations.map((item) => item.candidate.entityId); evidence.revisions.push(0);
  assert.ok(v0.currentQuestion, "live start returned no grounded question");
  const question = v0.currentQuestion;
  const label = question.targetType === "tag" ? "Yes, more of this" : /^I'd pick /;
  const responseValue = question.targetType === "tag" ? "like" : "prefer_a";
  responses.delete("discovery/answer");
  await page.getByRole("button", { name: label }).first().click();
  await page.waitForSelector(".tp-notice, #tp-programme-title, .tp-error", { timeout: 120_000 });
  assert.equal(await page.locator(".tp-error").count(), 0, "answer rendered an error");
  const answer = await waitResponse("discovery/answer"); assert.equal(answer.status, 200); const v1 = answer.json.data; charge(v1.trace); evidence.latencyMs.answer = answer.ms;
  assert.equal(v1.revision, 1); assert.equal(v1.trace.sessionStore, "redis"); evidence.revisions.push(1);
  const transition = v1.recommendationUpdate?.poolTransition; assert.ok(transition, "adaptive transition missing");
  evidence.followUpIds = v1.recommendations.map((item) => item.candidate.entityId); evidence.newIds = transition.newReservoirIds; evidence.promotedIds = transition.newlyDisplayedIds;
  evidence.retainedIds = evidence.initialIds.filter((id) => evidence.followUpIds.includes(id)); evidence.decision = transition.decision; evidence.family = transition.queryFamily;
  assert.ok(v1.preferences[question.targetType === "tag" ? "positiveTagIds" : "positiveEntityIds"].includes(question.targetIds[0]));
  assert.equal(transition.qlooCallsMade <= 1, true); assert.equal(v1.currentQuestion ? v1.currentQuestion.targetIds.every((id) => v1.currentQuestion.targetType === "tag" ? v1.recommendations.some((item) => item.candidate.tags.some((tag) => tag.id === id)) : v1.recommendations.some((item) => item.candidate.entityId === id)) : true, true);
  const replay = await page.evaluate(async ({ token, questionId, response }) => fetch("/api/discovery/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionToken: token, questionId, response }) }).then(async (r) => ({ status: r.status, body: await r.json() })), { token: v0.sessionToken, questionId: question.questionId, response: responseValue });
  evidence.replayStatus = replay.status; assert.equal(replay.status, 409);
  await page.screenshot({ path: resolve(OUT, "adaptive-after-answer.png"), fullPage: true }); evidence.browser = "PASS";
  await context.close();
  assert.ok(ledger.qloo <= CAP.qloo && ledger.gemini <= CAP.gemini && ledger.costUsd <= CAP.costUsd, "campaign cap exceeded");
  ledger.runs.push({ at: evidence.at, status: "PASS", usage: evidence.usage, decision: evidence.decision, family: evidence.family, newIds: evidence.newIds.length });
  console.log(redact(`S9.11 LIVE PASS decision=${evidence.decision} family=${evidence.family} newIds=${evidence.newIds.length} promoted=${evidence.promotedIds.length} retained=${evidence.retainedIds.length} qloo=${evidence.usage.qloo} gemini=${evidence.usage.gemini} cost=$${evidence.usage.costUsd.toFixed(6)}`));
} catch (error) {
  ledger.runs.push({ at: evidence.at, status: "FAIL", error: redact(error instanceof Error ? error.message : error), usage: evidence.usage });
  console.error(redact(error instanceof Error ? error.stack : error));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close(); stop();
  ledger.costUsd = Math.round(ledger.costUsd * 1e8) / 1e8;
  await writeFile(LEDGER, JSON.stringify(ledger, null, 2));
  await writeFile(resolve(OUT, `evidence-${Date.now()}.json`), redact(JSON.stringify({ campaign: CAP, ledger: { qloo: ledger.qloo, gemini: ledger.gemini, costUsd: ledger.costUsd }, evidence }, null, 2)));
}
