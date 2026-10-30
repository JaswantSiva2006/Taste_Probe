import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { chromium } from "playwright";
import { chooseSource, searchAndSelect } from "./lib/ui-flow.mjs";
const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
assert.ok(process.argv.includes("--confirm-live"), "requires --confirm-live");
const path = ".artifacts/s9-14/ledger.json";
const ledger = JSON.parse(await readFile(path, "utf8"));
assert.ok(ledger.qloo + 3 <= 18 && ledger.gemini === 0, "insufficient campaign allowance");
// Reserve the complete remaining Qloo allowance before starting; failed runs are never reset.
ledger.qloo += 3; ledger.recoveryReserved = true;
await writeFile(path, JSON.stringify(ledger, null, 2));
const port = await new Promise((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => done(p)); }); });
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--port", String(port), "--hostname", "127.0.0.1"], {
  env: { ...process.env, NODE_ENV: "production", QLOO_MODE: "live", SESSION_STORE: "redis", ADAPTIVE_POOL_ENABLED: "true", MAX_QLOO_CALLS_PER_SESSION: "1", MAX_GEMINI_REQUESTS_PER_EXPLORATION: "8", YOUTUBE_API_KEY: "", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
const secretValues = ["QLOO_API_KEY", "GOOGLE_API_KEY", "YOUTUBE_API_KEY", "UPSTASH_REDIS_REST_TOKEN", "UPSTASH_REDIS_REST_URL", "SESSION_SIGNING_SECRET"].map((k) => process.env[k]).filter(Boolean);
const clean = (value) => secretValues.reduce((text, secret) => text.split(secret).join("[REDACTED]"), String(value));
const events = []; let buffer = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { buffer += clean(chunk); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) { try { const e = JSON.parse(line); if (e.event) events.push(e); } catch {} } });
const base = `http://localhost:${port}`;
let browser;
const evidence = { checks: [], revisions: [], source: "Nils Frahm", sourceType: "music_artist", views: [] };
const check = (name, pass) => { evidence.checks.push({ name, pass: Boolean(pass) }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`); assert.ok(pass, name); };
try {
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(60000);
  const views = []; const waits = [];
  page.on("response", (response) => { if (!new URL(response.url()).pathname.startsWith("/api/discovery/")) return; waits.push((async () => { const json = await response.json(); if (json.data?.revision !== undefined) {
    const v = json.data; views.push(v); evidence.revisions.push(v.revision);
    // Preserve sanitized evidence even when an intermediate acceptance check fails.
    evidence.views.push({ revision: v.revision, seed: v.seed, usage: v.usage, artist: v.listening?.artist, video: v.listening?.video, selection: v.listening?.selection });
  } })()); });
  const settle = async () => { await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]')); await page.waitForTimeout(400); await Promise.allSettled(waits); };
  const click = async (name) => { await page.getByRole("button", { name, exact: true }).first().click(); await settle(); };
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Start exploring/ }).first().click();
  check("explicit source chooser", await page.locator('.ah-input input:checked').count() === 0);
  await chooseSource(page, "a music artist");
  await searchAndSelect(page, "Nils Frahm", "Nils Frahm");
  await page.getByRole("button", { name: /^Discover music from/ }).click();
  await page.waitForSelector("#tp-question, .sp-stage");
  if (await page.locator("#tp-question").count()) await click("Show my way in");
  await page.waitForSelector(".sp-stage--intro"); await settle();
  const initial = views.at(-1); evidence.initialArtistIds = initial.recommendations.map((r) => r.candidate.entityId);
  check("real non-movie Redis exploration", initial.seed.entityType === "music_artist" && initial.seed.name === "Nils Frahm");
  check("source artist excluded", !evidence.initialArtistIds.includes(initial.seed.entityId));
  // Ólafur is a genuine returned candidate, with two previously reviewed recordings.
  await click("Begin listening with Ólafur Arnalds");
  await page.waitForSelector(".tp-player"); await settle();
  const first = views.at(-1); check("authorized reviewed recording", Boolean(first.listening?.video?.videoId));
  await page.waitForFunction(() => document.querySelector('.tp-player')?.getAttribute('data-player-phase') === 'ready');
  await click("Play");
  await page.waitForFunction(() => document.querySelector('.tp-player')?.getAttribute('data-player-phase') === 'playing');
  check("real user-started YouTube playback", await page.locator('.tp-player').getAttribute('data-reported-video-id') === first.listening.video.videoId);
  await click("Pause");
  await page.waitForFunction(() => document.querySelector('.tp-player')?.getAttribute('data-player-phase') === 'paused');
  await click("Not for me");
  check("track dislike retains artist", !views.at(-1).preferences.rejectedEntityIds.includes(first.listening.artist.entityId));
  await page.locator('.sp-followup').getByRole('button', { name: /^Another .* song$/ }).click(); await settle();
  const another = views.at(-1); check("another song keeps artist", another.listening.artist.entityId === first.listening.artist.entityId && another.listening.video.videoId !== first.listening.video.videoId);
  evidence.songSelection = another.listening.selection;
  check("actual constrained Gemini song decision", another.listening.selection.mode === "GEMINI");
  await click("Save to Passport");
  const saved = views.at(-1).listening.saved; check("saved exact non-movie recording", saved.length > 0);
  evidence.saved = saved;
  await click("More like this artist");
  evidence.adaptive = views.at(-1).recommendationUpdate?.poolTransition ?? views.at(-1).listening?.notice;
  await page.getByRole('button', { name: /^Different artist/ }).first().click(); await settle();
  check("different artist", views.at(-1).listening.artist.entityId !== first.listening.artist.entityId);
  await click("Finish listening");
  await click("Open your Sound Passport");
  check("Passport saved entry", await page.locator('.sp-sleeve').count() === 1);
  await page.reload(); await page.getByRole('button', { name: /Sound Passport/ }).first().click();
  check("Passport reload", await page.locator('.sp-sleeve').count() === 1);
  await page.locator('.sp-sleeve').first().getByRole('button', { name: /^Remove/ }).click();
  check("remove empty state", await page.locator('.sp-sleeve').count() === 0);
  await page.screenshot({ path: '.artifacts/s9-14/recovery-passport.png', fullPage: true });
  evidence.views = views.map((v) => ({ revision: v.revision, seed: v.seed, usage: v.usage, artist: v.listening?.artist, video: v.listening?.video, selection: v.listening?.selection }));
} catch (error) { evidence.error = clean(error.stack); console.error(clean(error.message)); process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  const decisions = events.filter((e) => e.event === 'agent.decision');
  const songs = events.filter((e) => e.event === 'agent.song_selection');
  const turns = events.filter((e) => e.event === 'discovery.turn');
  ledger.gemini += (turns.length ? turns.reduce((n, e) => n + (e.geminiRequests ?? 0), 0) : decisions.reduce((n, e) => n + (e.requests ?? 0), 0)) + songs.reduce((n, e) => n + (e.requests ?? 1), 0);
  ledger.costUsd += (turns.length ? turns.reduce((n, e) => n + (e.estimatedGeminiCostUsd ?? 0), 0) : decisions.reduce((n, e) => n + (e.estimatedCostUsd ?? 0), 0)) + songs.reduce((n, e) => n + (e.estimatedCostUsd ?? 0), 0);
  ledger.recovery = { checks: evidence.checks, error: evidence.error ?? null };
  await writeFile(path, JSON.stringify(ledger, null, 2));
  await writeFile('.artifacts/s9-14/recovery-browser.json', clean(JSON.stringify(evidence, null, 2)));
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
