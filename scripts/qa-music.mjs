#!/usr/bin/env node
/**
 * npm run qa:music -- --confirm-live
 *
 * PAID, OPT-IN S9.9 browser verification of the REAL Next.js listening player.
 * Requires `npm run build`. Starts `next start` (NODE_ENV=production, QLOO_MODE=live,
 * SESSION_STORE=redis, production rate limits), drives ONE Interstellar → music artists
 * exploration (≈2 Qloo + ≈2–3 Gemini requests), then exercises real YouTube playback
 * for the reviewed artists inside that exploration. The YouTube Data API is never
 * called (no key); the IFrame player needs none.
 *
 * Induced failures (invalid video IDs, a delayed response, an unreviewed moment) are
 * injected by rewriting /api/music/resolve responses in the browser only, and are
 * labelled as induced in the evidence. "Playing" means YouTube reported PLAYING and
 * the position advanced; nobody listened, so audibility is not claimed.
 *
 * Ledger: .artifacts/music-qa/ledger.json caps S9.9 live usage at 6 Qloo and 8 Gemini.
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
if (!process.argv.includes("--confirm-live")) {
  console.error("qa:music spends real Qloo and Gemini requests (one exploration). Re-run with: npm run qa:music -- --confirm-live");
  process.exit(2);
}

const CAMPAIGN = { qloo: 6, gemini: 8 };
const OUT = resolve(".artifacts/music-qa");
const LEDGER = resolve(OUT, "ledger.json");
const CHANNEL = process.env.PW_CHANNEL || undefined; // e.g. msedge
const ARTISTS = [
  { name: "Jóhann Jóhannsson", videoId: "aXlx-YnvgKU", channel: "Jóhann Jóhannsson - Topic", alternate: "mPvqle7mF-U" },
  { name: "Max Richter", videoId: "InyT9Gyoz_o", channel: "MaxRichterVEVO" },
  { name: "Ólafur Arnalds", videoId: "xpZgtFhDbss", channel: "OlafurArnaldsVEVO" },
];

const secrets = ["QLOO_API_KEY", "GOOGLE_API_KEY", "UPSTASH_REDIS_REST_TOKEN", "SESSION_SIGNING_SECRET", "UPSTASH_REDIS_REST_URL"]
  .map((k) => process.env[k])
  .filter((v) => v && v.length >= 8);
const redact = (v) => secrets.reduce((t, s) => t.split(s).join("[REDACTED]"), String(v)).replace(/v\d\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[SESSION_TOKEN]");
const say = (v = "") => console.log(redact(v));

await mkdir(OUT, { recursive: true });
const ledger = existsSync(LEDGER) ? JSON.parse(await readFile(LEDGER, "utf8")) : { campaign: CAMPAIGN, qloo: 0, gemini: 0, runs: [] };
if (CAMPAIGN.qloo - ledger.qloo < 3 || CAMPAIGN.gemini - ledger.gemini < 4) {
  say(`BLOCKED: S9.9 live allowance exhausted (${JSON.stringify(ledger)})`);
  process.exit(3);
}

// ---------------------------------------------------------------- server

let child;
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
  const missing = ["QLOO_API_KEY", "GOOGLE_API_KEY", "LLM_MODEL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "SESSION_SIGNING_SECRET"].filter((k) => !process.env[k]?.trim());
  if (missing.length) throw Object.assign(new Error(`BLOCKED: missing ${missing.join(", ")}`), { blocked: true });
  if (!existsSync(resolve(".next/BUILD_ID"))) throw Object.assign(new Error("BLOCKED: run `npm run build` first"), { blocked: true });
  const port = await freePort();
  child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--port", String(port), "--hostname", "127.0.0.1"], {
    env: { ...process.env, NODE_ENV: "production", QLOO_MODE: "live", SESSION_STORE: "redis", RATE_LIMIT_ENABLED: "true", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  // localhost (not 127.0.0.1) so the page origin matches what the embed sees.
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

// ---------------------------------------------------------------- checks

const results = [];
const usage = { qloo: 0, gemini: 0, resolveCalls: 0, youtubeDataApi: 0 };
const check = (name, pass, detail = {}) => {
  results.push({ name, pass: Boolean(pass), detail });
  say(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};
const soft = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(name, false, { error: redact(e.message).slice(0, 300) });
  } finally {
    // An induced failure must never leak into the next check.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
};

const base = await launch().catch((e) => {
  say(e.message);
  process.exit(e.blocked ? 3 : 1);
});
const browser = await chromium.launch({ channel: CHANNEL });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(redact(m.text()).slice(0, 200)));
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${redact(e.message).slice(0, 200)}`));
const embeds = [];
page.on("request", (r) => {
  if (/youtube\.com\/embed\//.test(r.url())) embeds.push({ videoId: r.url().split("/embed/")[1]?.slice(0, 11), referer: r.headers()["referer"] ?? null });
  if (r.url().includes("googleapis.com/youtube")) usage.youtubeDataApi += 1;
});
const resolves = [];
page.on("response", async (r) => {
  const u = new URL(r.url());
  if (!u.pathname.startsWith("/api/")) return;
  try {
    const json = await r.json();
    if (u.pathname === "/api/music/resolve") resolves.push({ status: r.status(), data: json.data, error: json.error });
    const trace = json.data?.trace;
    if (trace) {
      usage.qloo += trace.qlooRequests;
      usage.gemini += trace.geminiRequests;
    }
    if (u.pathname === "/api/entities/search") usage.qloo += 1;
  } catch {}
});

const player = () => page.locator(".tp-player");
const attr = (name) => player().getAttribute(name);
const phase = () => attr("data-player-phase");
const time = async () => Number((await attr("data-current-time")) ?? "NaN");
const iframes = () => page.locator('iframe[src*="youtube.com/embed"]').count();
const waitPhase = (p, timeout = 30_000) =>
  page.waitForFunction((p) => document.querySelector(".tp-player")?.getAttribute("data-player-phase") === p, p, { timeout, polling: 200 }).then(() => true, () => false);
const shot = (name) => page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: false });
const listen = async (name) => {
  await page.getByRole("button", { name: `Listen: ${name}` }).first().click();
  await page.waitForFunction((n) => document.getElementById("tp-listen-title")?.textContent?.trim() === n, name);
  await page.waitForSelector(".tp-player, .tp-listen__fallback", { timeout: 30_000 });
};
const controls = (label) => page.locator(".tp-player__controls").getByRole("button", { name: label, exact: true });

try {
  // ------------------------------------------------ one live exploration
  const doc = await page.goto(base, { waitUntil: "networkidle" });
  const headers = doc.headers();
  check("security headers present", headers["content-security-policy"]?.includes("frame-src https://www.youtube.com") && headers["referrer-policy"] === "strict-origin-when-cross-origin", {
    csp: headers["content-security-policy"],
    referrerPolicy: headers["referrer-policy"],
  });
  await chooseWorld(page, "Music artists");
  await chooseSource(page, "a movie");
  await searchAndSelect(page, "Interstellar", "Interstellar", { timeout: 60_000 });
  await begin(page, { timeout: 120_000 });
  if (await page.locator("#tp-question").count()) {
    await page.getByRole("button", { name: "Show my way in" }).click();
  }
  await page.waitForSelector("#tp-programme-title", { timeout: 120_000 });
  const shown = await page.locator(".tp-programme .tp-card__title").allTextContents();
  say(`programme shows: ${shown.join(" | ")}`);
  check("listening room present for music journey", (await page.locator(".tp-listen").count()) === 1);

  // ------------------------------------------------ the three reviewed artists
  for (const [i, a] of ARTISTS.entries()) {
    await soft(`${a.name}: verified playback`, async () => {
      assert.ok(shown.some((t) => t.includes(a.name)), `${a.name} is not among the shown picks`);
      await listen(a.name);
      const res = resolves.at(-1);
      assert.equal(res?.data?.status, "RESOLVED", `resolve status ${JSON.stringify(res?.data?.status ?? res?.error)}`);
      assert.equal(res.data.video.videoId, a.videoId);
      assert.ok(await waitPhase("ready"), "player never became ready");
      await page.waitForTimeout(1500);
      const idle = await phase();
      check(`${a.name}: no autoplay (cued only)`, idle === "ready", { phase: idle });
      check(`${a.name}: single YouTube iframe`, (await iframes()) === 1, { iframes: await iframes() });
      await controls("Play").click();
      const playing = await waitPhase("playing");
      await page.waitForTimeout(2500);
      const t1 = await time();
      await page.waitForTimeout(2000);
      const t2 = await time();
      const reported = { id: await attr("data-reported-video-id"), title: await attr("data-reported-title"), channel: await attr("data-reported-channel") };
      check(`${a.name}: user-triggered PLAYING, time advancing, correct identity`, playing && t2 > t1 && reported.id === a.videoId && reported.channel === a.channel, { t1, t2, ...reported });
      await shot(`1440-${i + 1}-${a.videoId}-playing`);
      if (i === 0) {
        await controls("Pause").click();
        const paused = await waitPhase("paused", 10_000);
        await controls("Resume").click();
        const resumed = await waitPhase("playing", 15_000);
        check("pause / resume", paused && resumed);
        await page.waitForTimeout(1500);
        await controls("Replay").click();
        await page.waitForTimeout(3000);
        const tr = await time();
        check("replay restarts from the beginning", (await phase()) === "playing" && tr < 8, { time: tr });
      }
    });
  }

  // ------------------------------------------------ switching while playing
  await soft("switch while playing", async () => {
    assert.equal(await phase(), "playing", "precondition: Ólafur playing");
    await listen("Jóhann Jóhannsson");
    await page.waitForTimeout(1500);
    check("switching artist stops the previous video (one iframe, new one cued)", (await iframes()) === 1 && (await phase()) !== "playing" && (await attr("data-video-id")) === "aXlx-YnvgKU", {
      iframes: await iframes(),
      phase: await phase(),
    });
  });

  // ------------------------------------------------ stale response (induced delay)
  await soft("stale resolution", async () => {
    await page.route("**/api/music/resolve", async (route) => {
      const body = route.request().postDataJSON();
      const response = await route.fetch();
      const json = await response.json();
      if (json.data?.artist?.name === "Max Richter") await new Promise((r) => setTimeout(r, 3000));
      await route.fulfill({ response, json });
      void body;
    });
    await page.getByRole("button", { name: "Listen: Max Richter" }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Listen: Ólafur Arnalds" }).first().click();
    await page.waitForTimeout(5000);
    const title = (await page.textContent("#tp-listen-title"))?.trim();
    check("induced: slow response for the previous artist is ignored", title === "Ólafur Arnalds" && (await attr("data-video-id")) === "xpZgtFhDbss", { title, videoId: await attr("data-video-id") });
    await page.unroute("**/api/music/resolve");
  });

  // ------------------------------------------------ timestamp-bounded preview (review-mode moment, induced)
  await soft("bounded moment", async () => {
    await page.route("**/api/music/resolve", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      if (json.data?.artist?.name === "Max Richter") {
        json.data.featuredMoment = { videoId: "InyT9Gyoz_o", startSeconds: 60, endSeconds: 72, status: "PENDING_REVIEW", provenance: "human_curated" };
      }
      await route.fulfill({ response, json });
    });
    await listen("Max Richter");
    assert.ok(await waitPhase("ready"));
    const btn = page.locator(".tp-player__controls").getByRole("button", { name: /^Preview unreviewed moment 1:00–1:12$/ });
    const labelled = (await btn.count()) === 1 && (await page.locator(".tp-player__review").count()) === 1 && (await page.getByRole("button", { name: /featured moment/ }).count()) === 0;
    await btn.click();
    const playing = await waitPhase("playing");
    await page.waitForTimeout(1500);
    const ts = await time();
    const ended = await waitPhase("ended", 25_000);
    const te = await time();
    check("induced: unreviewed moment is labelled as unreviewed, starts at 1:00 and stops at 1:12", labelled && playing && ts >= 59 && ts < 66 && ended && te >= 70 && te <= 73, { labelled, ts, ended, te });
    await page.unroute("**/api/music/resolve");
  });

  // ------------------------------------------------ player error → reviewed alternate (induced)
  await soft("alternate failover", async () => {
    await page.route("**/api/music/resolve", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      if (json.data?.artist?.name === "Jóhann Jóhannsson") {
        json.data.video.videoId = "zzzzzzzzzz0";
        json.data.video.watchUrl = "https://www.youtube.com/watch?v=zzzzzzzzzz0";
      }
      await route.fulfill({ response, json });
    });
    await listen("Max Richter"); // move away so the next Listen remounts
    await listen("Jóhann Jóhannsson");
    await page.waitForTimeout(1500);
    if ((await attr("data-video-id")) === "zzzzzzzzzz0" && (await phase()) === "ready") await controls("Play").click();
    await page.waitForFunction(() => document.querySelector(".tp-player")?.getAttribute("data-video-id") === "mPvqle7mF-U", null, { timeout: 30_000 });
    const notice = (await page.textContent(".tp-player__status"))?.trim();
    await controls("Play").click();
    const playing = await waitPhase("playing");
    const reported = await attr("data-reported-video-id");
    check("induced: broken video → reviewed alternate by the same artist plays", playing && reported === "mPvqle7mF-U" && /Switched to another reviewed video by Jóhann Jóhannsson/.test(notice ?? ""), { notice, reported });
    check("artist identity kept on video failure", (await page.textContent("#tp-listen-title"))?.trim() === "Jóhann Jóhannsson");
    await shot("1440-failover");
    await page.unroute("**/api/music/resolve");
  });

  // ------------------------------------------------ every video fails → honest fallback (induced)
  await soft("terminal fallback", async () => {
    await page.route("**/api/music/resolve", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      if (json.data?.artist?.name === "Ólafur Arnalds") {
        json.data.video.videoId = "zzzzzzzzzz1";
        json.data.video.watchUrl = "https://www.youtube.com/watch?v=zzzzzzzzzz1";
        json.data.alternates = [];
      }
      await route.fulfill({ response, json });
    });
    await listen("Ólafur Arnalds");
    await page.waitForTimeout(1500);
    if ((await phase()) === "ready") await controls("Play").click();
    await page.waitForSelector(".tp-player__fallback[role=alert]", { timeout: 30_000 });
    const links = await page.locator(".tp-player__fallback a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    const playingAny = (await phase()) === "playing";
    check("induced: no playable video → visible fallback, YouTube-only links, nothing playing", links.length === 2 && links.every((h) => h.startsWith("https://www.youtube.com/")) && !playingAny, { links, phase: await phase() });
    await shot("1440-fallback");
    await page.unroute("**/api/music/resolve");
  });

  // ------------------------------------------------ accessibility at 1440
  await soft("axe 1440", async () => {
    await listen("Max Richter");
    await waitPhase("ready");
    const v = (await axeScan(page)).filter((x) => x.impact === "serious" || x.impact === "critical");
    check("axe 1440: no serious/critical violations with the player", v.length === 0, { violations: v });
  });

  // ------------------------------------------------ mobile 375
  await soft("mobile 375", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await listen("Ólafur Arnalds");
    assert.ok(await waitPhase("ready"));
    const box = await page.locator(".tp-player__frame").boundingBox();
    await page.locator(".tp-listen").scrollIntoViewIfNeeded();
    await controls("Play").click();
    const playing = await waitPhase("playing");
    await page.waitForTimeout(3000);
    const t1 = await time();
    await page.waitForTimeout(2000);
    const t2 = await time();
    const h = await hygiene(page, "375-listen");
    check("375: player ≥200×200 within the viewport, plays on tap, no overflow", box.width >= 200 && box.height >= 200 && box.width <= 375 && playing && t2 > t1 && !h.overflow, { box, t1, t2, overflow: h.overflow, offenders: h.offenders });
    await shot("375-playing");
    const v = (await axeScan(page)).filter((x) => x.impact === "serious" || x.impact === "critical");
    check("axe 375: no serious/critical violations", v.length === 0, { violations: v });
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  // ------------------------------------------------ referer, teardown, console
  const origins = [...new Set(embeds.map((e) => e.referer))];
  check("Referer on embed requests is the page origin only", origins.length === 1 && origins[0] === `${base}/`, { referers: origins, embeds: embeds.length });
  await soft("teardown", async () => {
    await page.getByRole("button", { name: "Explore another world" }).click();
    await page.waitForTimeout(1500);
    check("leaving the programme destroys the player", (await iframes()) === 0, { iframes: await iframes() });
  });
  const cspErrors = consoleErrors.filter((e) => /Content Security Policy/i.test(e));
  check("no CSP violations in the console", cspErrors.length === 0, { cspErrors, otherErrors: consoleErrors.filter((e) => !/Content Security Policy/i.test(e)).slice(0, 6) });
} catch (e) {
  check("journey", false, { error: redact(e.message).slice(0, 400) });
} finally {
  usage.resolveCalls = resolves.length;
  ledger.qloo += usage.qloo;
  ledger.gemini += usage.gemini;
  ledger.runs.push({ at: new Date().toISOString(), usage, passed: results.filter((r) => r.pass).length, total: results.length });
  await writeFile(LEDGER, JSON.stringify(ledger, null, 2));
  await writeFile(resolve(OUT, "evidence.json"), redact(JSON.stringify({ channel: CHANNEL ?? "playwright-chromium", usage, results, resolves: resolves.map((r) => ({ status: r.status, result: r.data?.status, artist: r.data?.artist?.name, videoId: r.data?.video?.videoId ?? null })) }, null, 1)));
  await browser.close();
  stop();
}
const failed = results.filter((r) => !r.pass);
say(`\nS9.9 music QA: ${results.length - failed.length}/${results.length} checks passed. Usage: ${JSON.stringify(usage)}. Ledger: qloo ${ledger.qloo}/${CAMPAIGN.qloo}, gemini ${ledger.gemini}/${CAMPAIGN.gemini}`);
process.exit(failed.length ? 1 : 0);
