#!/usr/bin/env node
/**
 * npm run qa:live -- --confirm-live [--journeys movie-book,artist-book,movie-artist]
 *
 * PAID, OPT-IN live browser verification (S9.5). Builds nothing; requires an
 * existing `npm run build`. Starts `next start` with NODE_ENV=production,
 * QLOO_MODE=live, SESSION_STORE=redis and production rate limits, then drives the
 * REAL universal UI in Chromium for each enabled journey:
 *   destination → source → Qloo search → explicit selection → start → question
 *   → answer → finish → START HERE → "Why this starting point?" → restart
 *
 * Budget: a persistent campaign ledger (.artifacts/live/ledger.json) caps ALL
 * S9.5 live usage at 18 Qloo HTTP calls, 10 Gemini calls and $0.05, across runs
 * and failures. A journey starts only if the remaining allowance covers it.
 * Each state is screenshotted at 1440, then the SAME session is resized to 375
 * (no extra paid calls). Never prints credentials or session tokens.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { axeScan, begin, chooseSource, chooseWorld, hygiene, searchAndSelect } from "./lib/ui-flow.mjs";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd(), false, { info() {}, error() {} });

/**
 * --rehearse: FREE dry run of this exact script against a mock `next dev`
 * (synthetic fixtures, provider keys blanked). Live-only assertions (Redis,
 * Gemini, Qloo provenance, usage traces) are skipped and the ledger is untouched.
 */
const REHEARSE = process.argv.includes("--rehearse");
if (!REHEARSE && !process.argv.includes("--confirm-live")) {
  console.error("qa:live spends real Qloo and Gemini requests. Re-run with: npm run qa:live -- --confirm-live   (or --rehearse for a free dry run)");
  process.exit(2);
}
const PROVENANCE = REHEARSE ? "mock" : "qloo";

const CAMPAIGN = { qloo: 18, gemini: 10, costUsd: 0.05 };
/** Minimum remaining allowance before a journey may start (search + seed check + Insights + 2 decisions, with margin). */
const RESERVE = { qloo: 5, gemini: 3 };
const OUT = resolve(REHEARSE ? ".artifacts/live-rehearsal" : ".artifacts/live");
const LEDGER = resolve(OUT, "ledger.json");

const JOURNEYS = {
  "movie-book": { world: "Books", source: "a movie", query: "Interstellar", exact: "Interstellar", sourceType: "movie", targetType: "book", polarity: "positive" },
  "artist-book": REHEARSE
    ? { world: "Books", source: "a music artist", query: "Glass Harbor", exact: "Glass Harbor (synthetic)", sourceType: "music_artist", targetType: "book", polarity: "negative" }
    : { world: "Books", source: "a music artist", query: "Coldplay", exact: "Coldplay", sourceType: "music_artist", targetType: "book", polarity: "negative" },
  "movie-artist": { world: "Music artists", source: "a movie", query: "Interstellar", exact: "Interstellar", sourceType: "movie", targetType: "music_artist", polarity: "positive" },
};
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const selected = arg("--journeys", Object.keys(JOURNEYS).join(",")).split(",");

const secrets = ["QLOO_API_KEY", "GOOGLE_API_KEY", "UPSTASH_REDIS_REST_TOKEN", "SESSION_SIGNING_SECRET", "UPSTASH_REDIS_REST_URL"]
  .map((k) => process.env[k])
  .filter((v) => v && v.length >= 8);
const redact = (v) => secrets.reduce((t, s) => t.split(s).join("[REDACTED]"), String(v)).replace(/v\d\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[SESSION_TOKEN]");
const say = (v = "") => console.log(redact(v));

/** Same unsupported-claim lexicon the Discovery Path validator uses (quoted verified names excluded). */
const UNSUPPORTED_CLAIM = /\b(beginners?|easy|easier|accessible|challenging|difficult|harder|advanced|novel(?:ty)?|obscure|adventurous|popular|bestsell\w*|acclaimed|classic|must[- ](?:read|watch|listen)|perfect|best|inspired|similar|because)\b/i;

// ---------------------------------------------------------------- ledger

async function loadLedger() {
  if (REHEARSE || !existsSync(LEDGER)) return { campaign: CAMPAIGN, qloo: 0, gemini: 0, costUsd: 0, runs: [] };
  return JSON.parse(await readFile(LEDGER, "utf8"));
}
const ledger = await loadLedger();
const remaining = () => ({ qloo: CAMPAIGN.qloo - ledger.qloo, gemini: CAMPAIGN.gemini - ledger.gemini, costUsd: CAMPAIGN.costUsd - ledger.costUsd });
const saveLedger = () => writeFile(LEDGER, JSON.stringify(ledger, null, 2));

// ---------------------------------------------------------------- server

let child;
const serverLog = [];
const events = [];
const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
function stop() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}
async function launch() {
  const port = await freePort();
  if (REHEARSE) {
    child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--port", String(port), "--hostname", "127.0.0.1"], {
      env: { ...process.env, NODE_ENV: "development", QLOO_MODE: "mock", QLOO_API_KEY: "", GOOGLE_API_KEY: "", SESSION_STORE: "memory", NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    return waitReady(`http://127.0.0.1:${port}`);
  }
  const missing = ["QLOO_API_KEY", "GOOGLE_API_KEY", "LLM_MODEL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "SESSION_SIGNING_SECRET"].filter((k) => !process.env[k]?.trim());
  if (missing.length) throw Object.assign(new Error(`BLOCKED: missing ${missing.join(", ")}`), { blocked: true });
  if (!existsSync(resolve(".next/BUILD_ID"))) throw Object.assign(new Error("BLOCKED: run `npm run build` first"), { blocked: true });
  child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--port", String(port), "--hostname", "127.0.0.1"], {
    env: { ...process.env, NODE_ENV: "production", QLOO_MODE: "live", SESSION_STORE: "redis", RATE_LIMIT_ENABLED: "true", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  return waitReady(`http://127.0.0.1:${port}`);
}

/** Keeps a redacted tail of server output and parses its structured JSON telemetry events. */
let buffer = "";
function keep(chunk) {
  const text = redact(chunk);
  serverLog.push(text);
  if (serverLog.length > 400) serverLog.shift();
  buffer += text;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.event) events.push(e);
    } catch {
      /* non-JSON server output */
    }
  }
}

async function waitReady(base) {
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production server exited (${child.exitCode})`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return { base, health: (await r.json()).data };
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("production server startup timed out");
}

// ---------------------------------------------------------------- journey

async function journey(browser, base, key) {
  const j = JOURNEYS[key];
  const rem = remaining();
  if (rem.qloo < RESERVE.qloo || rem.gemini < RESERVE.gemini || rem.costUsd <= 0.005) {
    return { key, status: "SKIPPED_BUDGET", remaining: rem };
  }
  const ev = { key, pair: `${j.sourceType}->${j.targetType}`, status: "RUNNING", usage: { qloo: 0, gemini: 0, costUsd: 0, tokens: { input: 0, output: 0, thinking: 0 } }, latencyMs: {}, checks: {}, screenshots: [] };
  const charge = (trace) => {
    if (!trace) return; // mock path (rehearsal) has no usage trace
    ev.usage.qloo += trace.qlooRequests;
    ev.usage.gemini += trace.geminiRequests;
    ev.usage.costUsd += trace.estimatedGeminiCostUsd ?? 0;
    for (const k of ["input", "output", "thinking"]) ev.usage.tokens[k] += trace.geminiTokens[k];
    ledger.qloo += trace.qlooRequests;
    ledger.gemini += trace.geminiRequests;
    ledger.costUsd += trace.estimatedGeminiCostUsd ?? 0;
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => m.type() === "error" && errors.push(redact(m.text())));
  const bodies = [];
  const responses = {};
  const started = new Map();
  page.on("request", (r) => {
    if (r.url().includes("/api/")) started.set(r, performance.now());
  });
  page.on("response", async (r) => {
    const u = r.url();
    if (!u.includes("/api/")) return;
    const route = new URL(u).pathname.replace("/api/", "");
    const ms = Math.round(performance.now() - (started.get(r.request()) ?? performance.now()));
    try {
      const text = await r.text();
      bodies.push(text);
      const json = JSON.parse(text);
      (responses[route] ??= []).push({ status: r.status(), json, ms });
    } catch {
      /* body unavailable */
    }
  });
  /** Waits for the asynchronously captured body of the n-th response of a route. */
  const responseOf = async (route, n = 1) => {
    for (let i = 0; i < 200 && (responses[route]?.length ?? 0) < n; i += 1) await page.waitForTimeout(50);
    const list = responses[route] ?? [];
    assert.ok(list.length >= n, `no captured response for ${route}`);
    return list[n - 1];
  };
  const sizes = [];
  const shot = async (name, opts = {}) => {
    await page.waitForTimeout(700);
    const file = `${key}-1440-${name}.png`;
    await page.screenshot({ path: resolve(OUT, file), fullPage: opts.full ?? true });
    sizes.push({ width: 1440, ...(await hygiene(page, name)) });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(500);
    const mobile = `${key}-375-${name}.png`;
    await page.screenshot({ path: resolve(OUT, mobile), fullPage: opts.full ?? true });
    sizes.push({ width: 375, ...(await hygiene(page, name)) });
    await page.setViewportSize({ width: 1440, height: 900 });
    ev.screenshots.push(file, mobile);
  };
  try {
    await page.goto(base, { waitUntil: "networkidle" });
    // 1. pairs come from the server
    const health = (await responseOf("health")).json.data;
    assert.ok(health?.capabilities?.pairs?.length, "UI did not receive capabilities from /api/health");
    const placards = (await page.locator(".tp-world__name").allTextContents()).map((t) => t.toLowerCase());
    assert.deepEqual(placards, [...new Set(health.capabilities.pairs.map((p) => p.targetLabel.toLowerCase()))]);
    ev.checks.capabilitiesFromServer = true;

    await chooseWorld(page, j.world);
    await chooseSource(page, j.source);
    await shot("01-choice", { full: false });

    // 2. explicit selection of a real entity
    await searchAndSelect(page, j.query, j.exact, { timeout: 60_000 });
    const search = await responseOf("entities/search");
    if (!REHEARSE) {
      ev.usage.qloo += 1;
      ledger.qloo += 1;
    }
    ev.latencyMs.search = search.ms;
    const results = search.json.data.results;
    const chosen = results.find((r) => r.name === j.exact);
    assert.ok(chosen && chosen.provenance === PROVENANCE && chosen.entityType === j.sourceType, "selected entity is not a verified result of the source type");
    if (!REHEARSE) assert.ok(!chosen.entityId.startsWith("mock:"), "synthetic ID in a live run");
    ev.source = { name: chosen.name, entityId: chosen.entityId, type: chosen.entityType, year: chosen.year ?? null, searchResults: results.length, exactMatches: results.filter((r) => r.name === j.exact).length };
    ev.checks.explicitRealSelection = true;
    await shot("02-results");

    // 3. start: Qloo Insights + Gemini decision, Redis revision 0
    await begin(page, { timeout: 120_000 });
    const start = await responseOf("discovery/start");
    assert.equal(start.status, 200, `start HTTP ${start.status}`);
    const v0 = start.json.data;
    charge(v0.trace);
    ev.latencyMs.start = start.ms;
    if (!REHEARSE) assert.equal(v0.trace.sessionStore, "redis");
    assert.equal(v0.revision, 0);
    assert.equal(v0.seed.entityId, chosen.entityId, "session seed is not the selected entity");
    assert.ok(v0.recommendations.length > 0);
    for (const r of v0.recommendations) {
      assert.equal(r.candidate.evidence.source, PROVENANCE);
      if (!REHEARSE) assert.ok(!r.candidate.entityId.startsWith("mock:"));
      assert.equal(r.candidate.entityType, j.targetType);
    }
    ev.initial = {
      count: v0.recommendations.length,
      withImage: v0.recommendations.filter((r) => r.candidate.imageUrl).length,
      withDescription: v0.recommendations.filter((r) => r.candidate.description).length,
      tagged: v0.recommendations.filter((r) => r.candidate.tags.length).length,
      top3: v0.recommendations.slice(0, 3).map((r) => r.candidate.name),
      longestName: Math.max(...v0.recommendations.map((r) => r.candidate.name.length)),
    };
    ev.agentStart = { mode: v0.agent.mode, action: v0.agent.decision.action, fallbackReason: v0.agent.fallbackReason ?? null, decisions: v0.trace?.decisions, geminiRequests: v0.trace?.geminiRequests };
    if (!REHEARSE) {
      assert.ok(v0.trace.geminiRequests > 0 && v0.trace.decisions.some((d) => d.mode === "LIVE_GEMINI"), "Gemini did not execute at start");
      ev.checks.geminiExecuted = true;
    }

    let last = v0;
    if (v0.status === "asking") {
      const q = v0.currentQuestion;
      const ids = new Set(v0.recommendations.map((r) => r.candidate.entityId));
      const tags = new Set(v0.recommendations.flatMap((r) => r.candidate.tags.map((t) => t.id)));
      const grounded = q.targetType === "tag" ? q.targetIds.every((id) => tags.has(id)) : q.targetIds.every((id) => ids.has(id));
      assert.ok(grounded, "question targets are not in the verified candidates");
      assert.equal(q.questionId, v0.agent.decision.selectedQuestionId);
      // Tag questions show the approved wording verbatim; entity questions show the prompt plus an A/B panel.
      if (q.targetType === "tag") assert.equal((await page.textContent("#tp-question")).trim(), q.text, "UI question differs from the approved wording");
      ev.question = { id: q.questionId, text: q.text, kind: q.targetType, grounded };
      ev.checks.groundedQuestion = true;
      await shot("03-question");

      // 4. answer (positive where budget allows; negative never triggers Qloo work)
      const rem2 = remaining();
      const positive = j.polarity === "positive" && rem2.qloo >= 3 && rem2.gemini >= 3;
      if (rem2.gemini < 2) throw new Error("campaign Gemini allowance too low to answer safely");
      const label = q.targetType === "tag" ? (positive ? "Yes, more of this" : "Not for me") : positive ? /^I'd pick / : "Neither";
      const response = q.targetType === "tag" ? (positive ? "like" : "dislike") : positive ? "prefer_a" : "neither";
      const beforeOrder = v0.recommendations.map((r) => r.candidate.entityId);
      await page.getByRole("button", { name: label }).first().click();
      await page.waitForSelector(".tp-notice, #tp-programme-title, .tp-error", { timeout: 120_000 });
      if (await page.locator(".tp-error").count()) throw new Error(`answer failed in UI: ${await page.textContent(".tp-error")}`);
      const ans = await responseOf("discovery/answer");
      const v1 = ans.json.data;
      charge(v1.trace);
      ev.latencyMs.answer = ans.ms;
      assert.equal(v1.revision, 1);
      if (!REHEARSE) assert.equal(v1.trace.sessionStore, "redis");
      assert.equal(v1.lastAnswer.questionId, q.questionId);
      assert.equal(v1.lastAnswer.response, response);
      const prefs = v1.preferences;
      const expectIds = response === "prefer_a" ? [q.targetIds[0]] : q.targetIds;
      const bucket = q.targetType === "tag" ? (positive ? prefs.positiveTagIds : prefs.rejectedTagIds) : positive ? prefs.positiveEntityIds : prefs.rejectedEntityIds;
      assert.ok(expectIds.every((id) => bucket.includes(id)), "answer did not update authoritative preference state");
      const afterOrder = v1.recommendations.map((r) => r.candidate.entityId);
      // The mock path has no recommendationUpdate; the UI derives the mechanism the same way.
      const u = v1.recommendationUpdate ?? { mechanism: v1.rankingChanged ? "LOCAL_RERANK" : "UNCHANGED", qlooRequested: false };
      if (!REHEARSE) assert.ok(v1.recommendationUpdate, "live answer has no recommendationUpdate");
      const orderChanged = beforeOrder.join("|") !== afterOrder.join("|");
      if (u.mechanism === "QLOO_RERETRIEVAL") assert.ok(u.qlooRequested && v1.trace.qlooRequests > 0, "reretrieval claimed without a Qloo request");
      else if (v1.trace) assert.equal(v1.trace.qlooRequests, 0, "Qloo called but not labelled reretrieval");
      if (u.mechanism === "UNCHANGED") assert.equal(orderChanged, false);
      for (const r of v1.recommendations) assert.equal(r.candidate.evidence.source, PROVENANCE);
      const notice = (await page.locator(".tp-notice strong").first().textContent().catch(() => "")) ?? "";
      ev.answer = {
        response,
        polarity: positive ? "positive" : "negative",
        mechanism: u.mechanism,
        qlooRequested: u.qlooRequested,
        orderChanged,
        membershipChanged: [...afterOrder].sort().join("|") !== [...beforeOrder].sort().join("|"),
        uiNotice: notice,
        nextDecision: { action: v1.agent.decision.action, mode: v1.agent.mode, fallbackReason: v1.agent.fallbackReason ?? null },
        decisions: v1.trace?.decisions,
      };
      ev.checks.preferenceUpdated = true;
      if (v1.status === "asking") await shot("04-after-answer");
      last = v1;
    } else {
      ev.question = { earlyFinish: v0.finishReason };
    }

    // 5. finish → Discovery Path
    if (last.status === "asking") {
      await page.getByRole("button", { name: "Show my way in" }).click();
      await page.waitForSelector("#tp-programme-title, .tp-error", { timeout: 90_000 });
      if (await page.locator(".tp-error").count()) throw new Error(`finish failed in UI: ${await page.textContent(".tp-error")}`);
      const fin = await responseOf("discovery/finish");
      ev.latencyMs.finish = fin.ms;
      last = fin.json.data;
      assert.equal(last.revision, (ev.answer ? 1 : 0) + 1);
    }
    await page.waitForSelector("#tp-programme-title");
    const done = last;
    assert.equal(done.status, "finished");
    ev.revisions = [0, ...(ev.answer ? [1] : []), done.revision].filter((v, i, a) => a.indexOf(v) === i);
    const path = done.discoveryPath;
    assert.ok(path, "no discoveryPath");
    const recIds = done.recommendations.map((r) => r.candidate.entityId);
    const featured = path.featured.map((f) => f.recommendationEntityId);
    const all = [...featured, ...path.remainingEntityIds];
    assert.equal(new Set(all).size, all.length, "duplicate entity in path");
    assert.deepEqual([...all].sort(), [...recIds].sort(), "path does not cover exactly the final recommendations");
    const eligible = done.recommendations.find((r) => !done.preferences.rejectedEntityIds.includes(r.candidate.entityId));
    assert.equal(featured[0], eligible.candidate.entityId, "START HERE is not the top eligible recommendation");
    for (const f of path.featured) {
      assert.equal(f.explanation.evidence.provenance, PROVENANCE);
      assert.ok(f.explanation.evidence.seedEntityIds.every((id) => id === chosen.entityId));
      const scrubbed = f.explanation.text.replace(/“[^”]*”/g, " ");
      assert.ok(!UNSUPPORTED_CLAIM.test(scrubbed), `unsupported claim in "${f.explanation.text}"`);
    }
    const uiStart = (await page.locator(".tp-start .tp-card__title").textContent()).trim();
    const leadName = done.recommendations.find((r) => r.candidate.entityId === featured[0]).candidate.name;
    assert.ok(leadName.startsWith(uiStart), "UI START HERE differs from backend lead");
    const uiTitles = await page.locator(".tp-programme .tp-card__title").allTextContents();
    assert.equal(new Set(uiTitles).size, uiTitles.length);
    assert.equal(uiTitles.length, done.recommendations.length);
    await page.locator(".tp-start .tp-whybox summary").click();
    const whyText = (await page.locator(".tp-start .tp-whybox__text").textContent()).trim();
    assert.equal(whyText, path.featured[0].explanation.text);
    if (j.targetType !== "book") {
      const copy = (await page.locator(".tp-programme").innerText()).replace(/“[^”]*”/g, " ");
      const titles = done.recommendations.map((r) => r.candidate.name);
      const stripped = titles.reduce((t, n) => t.split(n).join(" "), copy);
      assert.ok(!/\bbooks?\b/i.test(stripped), "book language in a non-book finale");
      assert.ok(await page.locator(".tp-start .tp-art--square").count(), "artist START HERE not in the square frame");
    }
    ev.final = {
      count: done.recommendations.length,
      finishReason: done.finishReason,
      startHere: { id: featured[0], name: leadName, kind: path.featured[0].explanation.kind, text: path.featured[0].explanation.text },
      roles: path.featured.map((f) => f.role),
      uniqueAndCovered: true,
      images: { rendered: await page.locator(".tp-programme img").count(), fallbacks: await page.locator(".tp-programme .tp-art__board").count() },
      sessionUsage: done.usage,
    };
    ev.checks.discoveryPathValid = true;
    ev.a11y = await axeScan(page);
    await shot("05-way-in");
    await page.locator(".tp-start").screenshot({ path: resolve(OUT, `${key}-1440-06-why.png`) });
    ev.screenshots.push(`${key}-1440-06-why.png`);

    // 6. restart (no network)
    await page.getByRole("button", { name: "Explore another world" }).click();
    await page.waitForSelector(".tp-world");
    assert.equal(await page.locator(".tp-world.is-on").count(), 0);
    ev.checks.restart = true;

    // 7. secrets and errors
    const dom = await page.content();
    ev.checks.noSecretsInBrowser = !secrets.some((s) => bodies.some((b) => b.includes(s)) || dom.includes(s));
    assert.ok(ev.checks.noSecretsInBrowser, "a provider credential appeared in a browser response");
    ev.browserErrors = errors;
    ev.layout = sizes.filter((s) => s.overflow || s.broken.length).map((s) => ({ width: s.width, label: s.label, overflow: s.overflow, offenders: s.offenders, broken: s.broken.length }));
    ev.status = errors.length ? "PASS_WITH_ERRORS" : "PASS";
  } catch (error) {
    ev.status = "FAIL";
    ev.failure = redact(error instanceof Error ? error.message : String(error));
    try {
      await page.screenshot({ path: resolve(OUT, `${key}-FAILURE.png`), fullPage: true });
    } catch {
      /* page gone */
    }
  } finally {
    ev.usage.costUsd = Math.round(ev.usage.costUsd * 1e8) / 1e8;
    ledger.costUsd = Math.round(ledger.costUsd * 1e8) / 1e8;
    await context.close();
  }
  return ev;
}

// ---------------------------------------------------------------- main

await mkdir(OUT, { recursive: true });
say(`qa:live campaign before run: qloo ${ledger.qloo}/${CAMPAIGN.qloo}, gemini ${ledger.gemini}/${CAMPAIGN.gemini}, $${ledger.costUsd.toFixed(6)}/${CAMPAIGN.costUsd}`);
const runs = [];
let status = 0;
try {
  const { base, health } = await launch();
  if (REHEARSE) {
    assert.equal(health.mode, "mock", "rehearsal must never run against live providers");
  } else {
    assert.equal(health.mode, "live");
    assert.equal(health.readiness?.sessionStore, "redis", "production did not select Redis");
    assert.match(health.agent, /^gemini-agent/, `agent is ${health.agent}`);
  }
  say(`production server ${base}: mode=${health.mode} store=${health.readiness.sessionStore} agent=${health.agent} pairs=${health.capabilities.pairs.map((p) => `${p.source}->${p.target}`).join(", ")}`);
  const browser = await chromium.launch();
  for (const key of selected) {
    const logStart = events.length;
    const ev = await journey(browser, base, key);
    // Failed upstream attempts are logged server-side; count them too (conservative).
    const failures = events.slice(logStart).filter((e) => e.event === "qloo.http_error" || e.event === "qloo.request_failed");
    ev.upstreamFailures = failures.length;
    ev.serverTurns = events.slice(logStart).filter((e) => e.event === "discovery.turn" || e.event === "discovery.finish").map((e) => ({ event: e.event, kind: e.kind, sourceType: e.sourceType, targetType: e.targetType, capability: e.capability, qlooRequests: e.qlooRequests, geminiRequests: e.geminiRequests, mechanism: e.mechanism, revision: e.revision, sessionStore: e.sessionStore, latencyMs: e.latencyMs, recommendationCount: e.recommendationCount, discoveryPathCount: e.discoveryPathCount }));
    ledger.qloo += failures.length;
    runs.push(ev);
    ledger.runs.push({ at: new Date().toISOString(), key, status: ev.status, usage: ev.usage, upstreamFailures: failures.length });
    await saveLedger();
    say(`${key}: ${ev.status}${ev.failure ? ` — ${ev.failure}` : ""} | qloo=${ev.usage.qloo} gemini=${ev.usage.gemini} $${ev.usage.costUsd} | ledger qloo ${ledger.qloo}/${CAMPAIGN.qloo} gemini ${ledger.gemini}/${CAMPAIGN.gemini}`);
    if (ev.status === "FAIL") status = 1;
    assert.ok(ledger.qloo <= CAMPAIGN.qloo && ledger.gemini <= CAMPAIGN.gemini && ledger.costUsd <= CAMPAIGN.costUsd, "campaign budget exceeded — stopping");
  }
  await browser.close();
} catch (error) {
  console.error(redact(`qa:live stopped: ${error instanceof Error ? error.message : error}`));
  if (serverLog.length) console.error(redact(serverLog.join("").slice(-3000)));
  status = error?.blocked ? 3 : 1;
} finally {
  stop();
  await saveLedger();
  await writeFile(resolve(OUT, `evidence-${Date.now()}.json`), redact(JSON.stringify({ campaign: CAMPAIGN, ledger: { qloo: ledger.qloo, gemini: ledger.gemini, costUsd: ledger.costUsd }, runs }, null, 2)));
}
say(`qa:live campaign after run: qloo ${ledger.qloo}/${CAMPAIGN.qloo}, gemini ${ledger.gemini}/${CAMPAIGN.gemini}, $${ledger.costUsd.toFixed(6)}`);
process.exitCode = status;
