#!/usr/bin/env node
/**
 * npm run qa:listening -- --confirm-live
 *
 * PAID, OPT-IN S9.12 live check of the listening loop on the production build, with
 * real Qloo, Gemini, Upstash Redis and the official YouTube player, driven through the
 * real UI: Interstellar → music artists → listen to Jóhann Jóhannsson (3 reviewed
 * recordings) → Play → Not for me → Another song (Gemini song selection when evidence
 * allows) → Play → Save → Finish.
 *
 * Campaign ledger (.artifacts/s9-12-live/ledger.json, never reset): 4 Qloo HTTP,
 * 5 Gemini HTTP, $0.02 estimated Gemini, 2 YouTube search + 2 videos.list (enforced
 * by the server's own caps, set to 2 for this run). Failures count. "Playing" means
 * YouTube reported PLAYING with time advancing; audibility is not claimed.
 */
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
  console.error("qa:listening spends real Qloo and Gemini requests. Re-run with: npm run qa:listening -- --confirm-live");
  process.exit(2);
}

const CAMPAIGN = { qloo: 4, gemini: 5, costUsd: 0.02, youtubeSearch: 2, youtubeVideos: 2 };
const OUT = resolve(".artifacts/s9-12-live");
const LEDGER = resolve(OUT, "ledger.json");
const ARTIST = { id: "5AD69C26-F5C4-482F-9C8B-E3B7432F2FDC", name: "Jóhann Jóhannsson", videos: ["aXlx-YnvgKU", "mPvqle7mF-U", "dCWbVxfkoKg"] };

const secrets = ["QLOO_API_KEY", "GOOGLE_API_KEY", "YOUTUBE_API_KEY", "YOUTUBE_API_KEY_2", "YOUTUBE_API_KEY_3", "UPSTASH_REDIS_REST_TOKEN", "SESSION_SIGNING_SECRET", "UPSTASH_REDIS_REST_URL"]
  .map((k) => process.env[k])
  .filter((v) => v && v.length >= 8);
const redact = (v) => secrets.reduce((t, s) => t.split(s).join("[REDACTED]"), String(v)).replace(/v\d\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[SESSION_TOKEN]");
const say = (v = "") => console.log(redact(v));

await mkdir(OUT, { recursive: true });
const ledger = existsSync(LEDGER) ? JSON.parse(await readFile(LEDGER, "utf8")) : { campaign: CAMPAIGN, qloo: 0, gemini: 0, costUsd: 0, runs: [] };
if (ledger.qloo + 2 > CAMPAIGN.qloo || ledger.gemini + 3 > CAMPAIGN.gemini || ledger.costUsd >= CAMPAIGN.costUsd) {
  say(`BLOCKED: S9.12 live allowance would be exceeded (${JSON.stringify(ledger)})`);
  process.exit(3);
}

// ---------------------------------------------------------------- server

let child;
const events = [];
let buffer = "";
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
function keep(chunk) {
  buffer += redact(chunk);
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.event) events.push(e);
    } catch {}
  }
}
async function launch() {
  const missing = ["QLOO_API_KEY", "GOOGLE_API_KEY", "LLM_MODEL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "SESSION_SIGNING_SECRET"].filter((k) => !process.env[k]?.trim());
  if (missing.length) throw Object.assign(new Error(`BLOCKED: missing ${missing.join(", ")}`), { blocked: true });
  if (!existsSync(resolve(".next/BUILD_ID"))) throw Object.assign(new Error("BLOCKED: run `npm run build` first"), { blocked: true });
  const port = await freePort();
  child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--port", String(port), "--hostname", "127.0.0.1"], {
    env: {
      ...process.env, NODE_ENV: "production", QLOO_MODE: "live", SESSION_STORE: "redis", RATE_LIMIT_ENABLED: "true", NEXT_TELEMETRY_DISABLED: "1",
      YOUTUBE_DAILY_SEARCH_MAX: String(CAMPAIGN.youtubeSearch), YOUTUBE_SEARCHES_PER_EXPLORATION: String(CAMPAIGN.youtubeSearch),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production server exited (${child.exitCode})`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return base;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("production server startup timed out");
}

// ---------------------------------------------------------------- run

const results = [];
const check = (name, pass, detail = {}) => {
  results.push({ name, pass: Boolean(pass), detail });
  say(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};
const views = [];
const base = await launch().catch((e) => {
  say(e.message);
  process.exit(e.blocked ? 3 : 1);
});
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "msedge" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.setDefaultTimeout(90_000);
page.on("response", async (r) => {
  const u = new URL(r.url());
  if (!u.pathname.startsWith("/api/discovery/")) return;
  try {
    const body = await r.json();
    views.push({ route: u.pathname.replace("/api/discovery/", ""), status: r.status(), data: body.data ?? null, error: body.error ?? null });
  } catch {}
});
const last = async (route) => {
  for (let i = 0; i < 300 && !views.some((v) => v.route === route); i += 1) await page.waitForTimeout(100);
  return views.filter((v) => v.route === route).at(-1);
};
const waitRoute = async (route, n) => {
  for (let i = 0; i < 600 && views.filter((v) => v.route === route).length < n; i += 1) await page.waitForTimeout(100);
  return views.filter((v) => v.route === route).at(-1);
};
const phase = () => page.locator(".tp-player").getAttribute("data-player-phase");
const waitPlaying = async () => page.waitForFunction(() => document.querySelector(".tp-player")?.getAttribute("data-player-phase") === "playing", null, { timeout: 30_000, polling: 200 }).then(() => true, () => false);
async function playCheck(label, expectedId) {
  await page.waitForFunction(() => ["ready", "playing", "paused"].includes(document.querySelector(".tp-player")?.getAttribute("data-player-phase") ?? ""), null, { timeout: 30_000 });
  const idle = await phase();
  await page.locator(".tp-player__controls").getByRole("button", { name: "Play", exact: true }).click();
  const playing = await waitPlaying();
  await page.waitForTimeout(2500);
  const t1 = Number(await page.locator(".tp-player").getAttribute("data-current-time"));
  await page.waitForTimeout(2000);
  const t2 = Number(await page.locator(".tp-player").getAttribute("data-current-time"));
  const reported = await page.locator(".tp-player").getAttribute("data-reported-video-id");
  check(`${label}: no autoplay, user-started PLAYING, time advancing, identity`, idle === "ready" && playing && t2 > t1 && reported === expectedId, { idle, t1, t2, reported, expectedId });
}

let feedbackCount = 0;
try {
  await page.goto(base, { waitUntil: "networkidle" });
  await chooseWorld(page, "Music artists");
  await chooseSource(page, "a movie");
  await searchAndSelect(page, "Interstellar", "Interstellar", { timeout: 60_000 });
  await begin(page, { timeout: 120_000 });
  if (await page.locator("#tp-question").count()) await page.getByRole("button", { name: "Show my way in" }).click();
  await page.waitForSelector("#tp-programme-title", { timeout: 120_000 });
  const programme = (await last("finish")) ?? (await last("start"));
  const shown = programme.data.recommendations.map((r) => r.candidate.entityId);
  check("Qloo returned the reviewed artist among the shown picks", shown.includes(ARTIST.id), { shown: programme.data.recommendations.map((r) => r.candidate.name) });

  // Start listening with the artist (preview selection, then the explicit start button).
  await page.getByRole("button", { name: `Listen: ${ARTIST.name}` }).first().click();
  await page.getByRole("button", { name: `Start listening with ${ARTIST.name}` }).click();
  const s1 = await waitRoute("listen", 1);
  const l1 = s1.data?.listening;
  check("listen: server presented a verified recording of the authorized artist", s1.status === 200 && l1.artist.entityId === ARTIST.id && ARTIST.videos.includes(l1.video.videoId) && l1.verifiedSongCount === 3, {
    status: s1.status, error: s1.error, video: l1?.video?.videoId, title: l1?.video?.title, selection: l1?.selection,
  });
  await page.screenshot({ path: resolve(OUT, "1440-listen-start.png") });
  await playCheck("first recording", l1.video.videoId);

  // Track-level dislike, then another song by the same artist.
  await page.getByRole("button", { name: "Not for me", exact: true }).last().click();
  const s2 = await waitRoute("feedback", ++feedbackCount);
  check("NOT_FOR_ME: track reaction only (artist kept, not rejected)", s2.status === 200 && s2.data.listening.currentFeedback === "not_for_me" && !s2.data.preferences.rejectedEntityIds.includes(ARTIST.id), { notice: s2.data?.listening?.notice });
  await page.getByRole("button", { name: "Another song", exact: true }).click();
  const s3 = await waitRoute("feedback", ++feedbackCount);
  const l3 = s3.data?.listening;
  const remaining = ARTIST.videos.filter((v) => v !== l1.video.videoId);
  const songEvents = events.filter((e) => e.event === "agent.song_selection");
  check("ANOTHER_SONG: same artist, a different verified recording from the authorized remainder", s3.status === 200 && l3.artist.entityId === ARTIST.id && remaining.includes(l3.video.videoId), { selected: l3?.video?.videoId, title: l3?.video?.title, remaining });
  check("real Gemini song selection recorded and validated", l3?.selection?.mode === "GEMINI" && songEvents.some((e) => e.ok === true) && remaining.includes(l3.video.videoId), {
    selection: l3?.selection, events: songEvents.map((e) => ({ ok: e.ok, reasonCode: e.reasonCode, error: e.error, eligible: e.eligible, latencyMs: e.latencyMs, estimatedCostUsd: e.estimatedCostUsd })),
  });
  await page.screenshot({ path: resolve(OUT, "1440-another-song.png") });
  await playCheck("Gemini-selected recording", l3.video.videoId);

  await page.getByRole("button", { name: "Save this recording" }).click();
  const s4 = await waitRoute("feedback", ++feedbackCount);
  const saved = s4.data?.listening?.saved ?? [];
  check("SAVE: exact verified artist/recording pair", saved.length === 1 && saved[0].video.videoId === l3.video.videoId && saved[0].artist.qlooId === ARTIST.id, { saved });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator(".tp-listen").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(OUT, "375-listening.png") });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("375: listening session has no horizontal overflow", !overflow);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("button", { name: "Finish listening" }).click();
  const s5 = await waitRoute("feedback", ++feedbackCount);
  check("FINISH: listening summary", s5.data?.listening?.status === "finished" && s5.data.listening.saved.length === 1, { notice: s5.data?.listening?.notice });
  const revs = [s1, s2, s3, s4, s5].map((v) => v.data?.revision);
  check("one exploration, revisions advance by exactly one per action", new Set([s1, s2, s3, s4, s5].map((v) => v.data?.sessionId)).size === 1 && revs.every((r, i) => i === 0 || r === revs[i - 1] + 1), { revs });
  await page.screenshot({ path: resolve(OUT, "1440-finished.png") });
} catch (e) {
  check("journey", false, { error: redact(e.message).slice(0, 400) });
} finally {
  // Usage from the server's own telemetry (every attempt, failures included).
  const qloo = events.filter((e) => e.event === "qloo.request" || e.event === "qloo.request_failed" || e.event === "qloo.http_error").length;
  const turnQloo = events.filter((e) => e.event === "discovery.turn" || e.event === "api.request").length; // context only
  const decisions = events.filter((e) => e.event === "agent.decision").reduce((a, e) => a + (e.requests ?? 0), 0);
  const proposer = events.filter((e) => e.event === "agent.question_generation").reduce((a, e) => a + (e.requests ?? 0), 0);
  const songs = events.filter((e) => e.event === "agent.song_selection");
  const cost = [...events.filter((e) => e.event === "agent.decision"), ...songs].reduce((a, e) => a + (e.estimatedCostUsd ?? 0), 0);
  const final = views.filter((v) => v.data?.usage).at(-1)?.data?.usage;
  const usage = {
    qlooBudgetCalls: final?.qlooCallCount ?? null,
    qlooSearch: views.filter((v) => v.route === "start").length ? 1 : 0,
    geminiRequests: final?.geminiRequestCount ?? decisions + proposer + songs.length,
    geminiSongRequests: songs.length,
    estimatedGeminiCostUsd: Math.round(cost * 1e8) / 1e8,
    youtubeDataCalls: 0,
    telemetryQlooEvents: qloo,
    turns: turnQloo,
  };
  const qlooTotal = (usage.qlooBudgetCalls ?? 0) + usage.qlooSearch;
  ledger.qloo += qlooTotal;
  ledger.gemini += usage.geminiRequests;
  ledger.costUsd = Math.round((ledger.costUsd + usage.estimatedGeminiCostUsd) * 1e8) / 1e8;
  ledger.runs.push({ at: new Date().toISOString(), usage, passed: results.filter((r) => r.pass).length, total: results.length });
  await writeFile(LEDGER, JSON.stringify(ledger, null, 2));
  await writeFile(resolve(OUT, "evidence.json"), redact(JSON.stringify({ usage, results, listening: views.filter((v) => v.data?.listening).map((v) => ({ route: v.route, revision: v.data.revision, artist: v.data.listening.artist, video: v.data.listening.video && { videoId: v.data.listening.video.videoId, title: v.data.listening.video.title, channel: v.data.listening.video.channelTitle }, selection: v.data.listening.selection, notice: v.data.listening.notice })) }, null, 1)));
  await browser.close();
  stop();
  say(`\nS9.12 live listening: ${results.filter((r) => r.pass).length}/${results.length} checks passed. Usage: ${JSON.stringify(usage)}. Ledger: qloo ${ledger.qloo}/${CAMPAIGN.qloo}, gemini ${ledger.gemini}/${CAMPAIGN.gemini}, $${ledger.costUsd}/${CAMPAIGN.costUsd}`);
}
process.exit(results.every((r) => r.pass) ? 0 : 1);
