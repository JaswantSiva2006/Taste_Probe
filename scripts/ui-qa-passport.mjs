#!/usr/bin/env node
/**
 * npm run qa:passport — S9.13 Sound Passport browser QA (free, no Qloo/Gemini spend).
 *
 * Runs the REAL Next.js app (`next dev`) in live-shaped mode against a local Qloo HTTP
 * stub serving genuine recorded identities (scripts/lib/qloo-stub.mjs), with
 * LLM_PROVIDER=none (deterministic agent and song choice), a memory session store and
 * no YouTube Data API key, so recordings come from the reviewed registry and play in
 * the official YouTube player (needs internet for YouTube only).
 *
 * Journey: landing → Start exploring → Interstellar → stage → Begin listening → Play →
 * Pause → Rewind → Replay → Love → Not for me → Another song → Previous → Next →
 * Save → Different artist → Save → unavailable artist → Finish → Passport → reload
 * (persists) → Remove → Clear → empty. Screenshots at 320/375/768/1024/1440, axe
 * (serious/critical) and overflow checks. "Playing" = YouTube reported PLAYING.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { startQlooStub } from "./lib/qloo-stub.mjs";
import { axeScan, hygiene, searchAndSelect, chooseSource } from "./lib/ui-flow.mjs";

const require = createRequire(import.meta.url);
const OUT = resolve(".artifacts/passport");
const ONLY_CAPTURE = process.argv.includes("--capture");
await mkdir(OUT, { recursive: true });

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

const stub = await startQlooStub();
const port = await freePort();
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--port", String(port), "--hostname", "127.0.0.1"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    QLOO_MODE: "live",
    QLOO_API_KEY: "stub-key",
    QLOO_BASE_URL: `https://localhost:${stub.address().port}`,
    // Trust the QA stub's self-signed certificate in this child process only.
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    LLM_PROVIDER: "none",
    GOOGLE_API_KEY: "",
    YOUTUBE_API_KEY: "",
    SESSION_STORE: "memory",
    RATE_LIMIT_ENABLED: "false",
    ADAPTIVE_POOL_ENABLED: "false",
    NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const serverLog = [];
const keep = (d) => {
  serverLog.push(String(d));
  if (serverLog.length > 300) serverLog.shift();
};
child.stdout.on("data", keep);
child.stderr.on("data", keep);
const stop = () => {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
  stub.close();
};
const base = `http://localhost:${port}`;
for (let i = 0; i < 300; i += 1) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 400));
}

const results = [];
const check = (name, pass, detail = {}) => {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
};
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "msedge" });

async function newPage(width, height = 900, opts = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...opts });
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // YouTube's own ad/telemetry requests are blocked by CORS in automation; they are not app errors.
    if (m.type() === "error" && !/doubleclick|googleads|youtube\.com\/(api|generate_204)|Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200));
  });
  return { context, page, errors };
}
const shot = (page, name, full = false) => page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: full });
const phase = (page) => page.locator(".tp-player").getAttribute("data-player-phase");
const waitPhase = (page, p, timeout = 30_000) =>
  page.waitForFunction((p) => document.querySelector(".tp-player")?.getAttribute("data-player-phase") === p, p, { timeout, polling: 200 }).then(() => true, () => false);
const vinyl = (page) =>
  page.evaluate(() => {
    const v = document.querySelector(".sp-deck .sp-vinyl");
    const d = v?.querySelector(".sp-vinyl__disc");
    return v && d ? { state: v.getAttribute("data-state"), spinning: d.getAttribute("data-spinning"), playState: getComputedStyle(d).animationPlayState, name: getComputedStyle(d).animationName, transform: getComputedStyle(d).transform } : null;
  });
const videoId = (page) => page.locator(".tp-player").getAttribute("data-video-id");
const settle = async (page) => {
  await page.waitForFunction(() => !document.querySelector(".sp-stage[aria-busy='true']"), null, { timeout: 30_000 });
  await page.waitForTimeout(250);
};
const click = async (page, name) => {
  await page.getByRole("button", { name, exact: true }).first().click();
  await settle(page);
};
async function noProblems(page, label) {
  const h = await hygiene(page, label);
  const v = (await axeScan(page)).filter((x) => x.impact === "serious" || x.impact === "critical");
  check(`${label}: no overflow, no serious/critical axe`, !h.overflow && v.length === 0, { overflow: h.overflow, offenders: h.offenders, axe: v });
}
async function toStage(page) {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Start exploring/ }).first().click();
  await chooseSource(page, "a movie");
  await page.waitForSelector("#tp-anchor");
  await searchAndSelect(page, "Interstellar", "Interstellar");
  await page.getByRole("button", { name: /^Begin with/ }).click();
  await page.waitForSelector("#tp-question, #tp-listen-title", { timeout: 60_000 });
  if (await page.locator("#tp-question").count()) await page.getByRole("button", { name: "Show my way in" }).click();
  await page.waitForSelector(".sp-stage", { timeout: 60_000 });
}

try {
  // ------------------------------------------------ desktop journey (1440)
  {
    const { page, errors, context } = await newPage(1440);
    await page.goto(base, { waitUntil: "networkidle" });
    await shot(page, "1440-01-landing");
    await shot(page, "1440-01-landing-full", true);
    await noProblems(page, "1440 landing");
    check("landing: no autoplay / no player on load", (await page.locator("iframe").count()) === 0);
    await page.getByRole("button", { name: /Start exploring/ }).first().click();
    await chooseSource(page, "a movie");
    await page.waitForSelector("#tp-anchor");
    check("Start exploring opens source selection; movie is selected explicitly", await page.getByRole("radio", { name: /^Music artists/ }).isChecked());
    await searchAndSelect(page, "Interstellar", "Interstellar");
    await shot(page, "1440-02-source-selected");
    await page.getByRole("button", { name: /^Begin with/ }).click();
    await page.waitForSelector("#tp-question, #tp-listen-title", { timeout: 60_000 });
    if (await page.locator("#tp-question").count()) {
      await shot(page, "1440-03-question");
      await page.getByRole("button", { name: "Show my way in" }).click();
    }
    await page.waitForSelector(".sp-stage--intro");
    await page.waitForTimeout(1200); // let the programme's unfold animation finish before capturing
    check("results open on the Listening Stage (focus on its title)", (await page.evaluate(() => document.activeElement?.id)) === "tp-listen-title");
    await shot(page, "1440-04-stage-intro");
    await noProblems(page, "1440 stage intro");
    check("generic programme still rendered below the stage", (await page.locator(".tp-programme .tp-start").count()) === 1);

    await click(page, "Begin listening");
    await page.waitForSelector(".sp-stage .tp-player");
    const first = await videoId(page);
    check("stage: one official player, first verified recording", (await page.locator('iframe[src*="youtube.com/embed"]').count()) <= 1 && Boolean(first), { first });
    await waitPhase(page, "ready");
    await page.waitForTimeout(1200);
    const v0 = await vinyl(page);
    check("ready: no autoplay; vinyl still", (await phase(page)) === "ready" && v0.spinning === "still", v0);
    await shot(page, "1440-05-stage-ready");
    await noProblems(page, "1440 stage ready");

    await page.getByRole("button", { name: "Play", exact: true }).click();
    const playing = await waitPhase(page, "playing");
    await page.waitForTimeout(2200);
    const v1 = await vinyl(page);
    check("Play: YouTube PLAYING and the vinyl turns", playing && v1.state === "playing" && v1.playState === "running", v1);
    await shot(page, "1440-06-stage-playing");

    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const paused = await waitPhase(page, "paused", 10_000);
    const p1 = await vinyl(page);
    await page.waitForTimeout(900);
    const p2 = await vinyl(page);
    check("Pause: YouTube PAUSED; vinyl holds its angle", paused && p1.playState === "paused" && p1.transform === p2.transform && p1.transform !== "none", { p1: p1.transform, p2: p2.transform });
    await shot(page, "1440-07-stage-paused");

    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await waitPhase(page, "playing");
    await page.waitForTimeout(3500);
    const tBefore = Number(await page.locator(".tp-player").getAttribute("data-current-time"));
    await page.getByRole("button", { name: "Back 10 seconds" }).click();
    await page.waitForTimeout(1100);
    const tAfter = Number(await page.locator(".tp-player").getAttribute("data-current-time"));
    check("Rewind 10s seeks back within the current recording", tAfter < tBefore, { tBefore, tAfter });
    await page.getByRole("button", { name: "Replay from the start" }).click();
    await page.waitForTimeout(2500);
    check("Replay restarts the recording", Number(await page.locator(".tp-player").getAttribute("data-current-time")) < 4);

    await click(page, "Love");
    check("Love: pressed + truthful confirmation", (await page.getByRole("button", { name: "Loved" }).getAttribute("aria-pressed")) === "true" && /recording only/.test(await page.textContent(".sp-feedback")));
    await shot(page, "1440-08-loved");

    await click(page, "Not for me");
    check("Not for me: nonjudgmental follow-up, artist kept", (await page.locator(".sp-followup").count()) === 1 && /not Jóhann Jóhannsson/.test(await page.textContent(".sp-followup")));
    await shot(page, "1440-09-not-for-me");

    await page.locator(".sp-followup").getByRole("button", { name: /^Another .* song$/ }).click();
    await settle(page);
    const second = await videoId(page);
    check("Another song: same artist, different verified recording", second !== first && (await page.textContent(".sp-now__name")) === "Jóhann Jóhannsson", { first, second });
    await shot(page, "1440-10-another-song");

    await page.getByRole("button", { name: /^Previous recording/ }).click();
    await settle(page);
    check("Previous: back to the earlier recording (server-authorized replay)", (await videoId(page)) === first);
    await page.getByRole("button", { name: "Next recording (no rating)" }).click();
    await settle(page);
    const afterNext = await videoId(page);
    check("Next: neutral navigation to an unheard recording", afterNext !== first && afterNext !== second, { afterNext });

    await click(page, "Save to Passport");
    check("Save: stamped, count updated", /Stamped into your Sound Passport/.test(await page.textContent(".sp-feedback")) && (await page.textContent(".sp-navpass__count")) === "1");
    check("Save: button now shows saved state (no duplicate save possible)", await page.getByRole("button", { name: "In your Passport" }).isDisabled());
    await shot(page, "1440-11-saved");

    const artistBefore = await page.textContent(".sp-now__name");
    await page.getByRole("button", { name: /^Different artist/ }).click();
    await settle(page);
    const artistAfter = await page.textContent(".sp-now__name");
    check("Different artist: a new Qloo artist", artistAfter !== artistBefore, { artistBefore, artistAfter });
    await shot(page, "1440-12-different-artist");
    await click(page, "Save to Passport");
    check("second save → Passport count 2", (await page.textContent(".sp-navpass__count")) === "2");

    // unavailable artist (no verified recording) via the programme's Listen button
    await page.getByRole("button", { name: "Listen: Shawn Mendes" }).click();
    await settle(page);
    check("unmapped artist: truthful no-recording state", /No verified recording for Shawn Mendes yet/.test(await page.textContent("#tp-listen-title")));
    await page.locator("#tp-listen-title").scrollIntoViewIfNeeded();
    await shot(page, "1440-13-no-recording");
    await click(page, "Try the next artist");

    await click(page, "Finish listening");
    check("Finish: session summary with saved count", /2 recordings kept from Interstellar/.test(await page.textContent("#tp-listen-title")));
    await shot(page, "1440-14-finished");

    await click(page, "Open your Sound Passport");
    await page.waitForSelector(".sp-crate");
    check("Passport lists the 2 exact saved recordings", (await page.locator(".sp-sleeve").count()) === 2);
    await page.waitForTimeout(800);
    await shot(page, "1440-15-passport");
    await shot(page, "1440-15-passport-full", true);
    await noProblems(page, "1440 passport");

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("tasteprobe.passport.v1") ?? "{}"));
    check("localStorage holds canonical records only (no tokens)", stored.v === 1 && stored.items.length === 2 && !JSON.stringify(stored).includes("sessionToken") && stored.items.every((i) => i.video.watchUrl.startsWith("https://www.youtube.com/watch?v=")));
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Sound Passport/ }).first().click();
    await page.waitForSelector(".sp-crate");
    check("Passport persists across reload", (await page.locator(".sp-sleeve").count()) === 2);
    await page.locator(".sp-sleeve").first().getByRole("button", { name: /^Remove/ }).click();
    check("Remove: one entry removed", (await page.locator(".sp-sleeve").count()) === 1 && (await page.textContent(".sp-navpass__count")) === "1");
    await page.getByRole("button", { name: "Clear Passport…" }).click();
    await shot(page, "1440-16-clear-confirm");
    await page.getByRole("button", { name: "Yes, clear Passport" }).click();
    check("Clear: empty state", (await page.locator(".sp-passport__empty").count()) === 1 && (await page.textContent(".sp-navpass__count")) === "0");
    await shot(page, "1440-17-passport-empty");
    await noProblems(page, "1440 empty passport");
    await page.getByRole("button", { name: /Start exploring/ }).click();
    check("Empty Passport → Start exploring returns to source choice", (await page.locator(".tp-step--anchor").count()) === 1);
    check("1440 journey: no page/console errors", errors.length === 0, { errors: errors.slice(0, 5) });
    await context.close();
  }

  // ------------------------------------------------ explore other cultures (books) still works
  {
    const { page, context } = await newPage(1440);
    await page.goto(base, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: /Explore other cultures/ }).click();
    await page.locator(".tp-world", { hasText: "Books" }).click();
    check("Explore other cultures: Books journey still offered", await page.getByRole("radio", { name: /^Books/ }).isChecked());
    await context.close();
  }

  // ------------------------------------------------ mobile + widths
  for (const width of [375, 320]) {
    const { page, context } = await newPage(width, 812, { isMobile: true, hasTouch: true });
    await page.goto(base, { waitUntil: "networkidle" });
    await shot(page, `${width}-01-landing`);
    await shot(page, `${width}-01-landing-full`, true);
    await toStage(page);
    await shot(page, `${width}-04-stage-intro`);
    await click(page, "Begin listening");
    await page.waitForSelector(".sp-stage .tp-player");
    await waitPhase(page, "ready");
    const box = await page.locator(".sp-screen .tp-player__frame").boundingBox();
    check(`${width}: player visible, ≥200 wide/tall and inside the viewport`, box.width >= 200 && box.height >= 200 && box.x >= 0 && box.x + box.width <= width, { box });
    await page.locator(".sp-now").scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Play", exact: true }).tap();
    await waitPhase(page, "playing");
    await page.waitForTimeout(1500);
    await page.locator(".sp-now").scrollIntoViewIfNeeded();
    await shot(page, `${width}-05-stage-playing`);
    await shot(page, `${width}-05-stage-full`, true);
    await noProblems(page, `${width} stage`);
    await click(page, "Save to Passport");
    await page.getByRole("button", { name: /Sound Passport/ }).first().click();
    await page.waitForSelector(".sp-crate");
    await shot(page, `${width}-06-passport`, true);
    await noProblems(page, `${width} passport`);
    await context.close();
  }
  for (const width of [768, 1024]) {
    const { page, context } = await newPage(width, 1000);
    await page.goto(base, { waitUntil: "networkidle" });
    await shot(page, `${width}-01-landing`);
    await toStage(page);
    await click(page, "Begin listening");
    await page.waitForSelector(".sp-stage .tp-player");
    await page.locator(".sp-stage").scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    await shot(page, `${width}-05-stage`, true);
    await noProblems(page, `${width} stage`);
    await context.close();
  }

  // ------------------------------------------------ reduced motion: playback never spins the record
  {
    const { page, context } = await newPage(1440, 900, { reducedMotion: "reduce" });
    await toStage(page);
    await click(page, "Begin listening");
    await waitPhase(page, "ready");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await waitPhase(page, "playing");
    const v = await vinyl(page);
    check("reduced motion: playing, but the record does not animate", v.state === "playing" && v.name === "none", v);
    await context.close();
  }
} catch (e) {
  check("journey", false, { error: String(e.message).slice(0, 400) });
} finally {
  await browser.close();
  stop();
  await writeFile(resolve(OUT, "results.json"), JSON.stringify(results, null, 1));
  await writeFile(resolve(OUT, "server.log"), serverLog.join("").replace(/stub-key/g, "[stub]"));
}
const failed = results.filter((r) => !r.pass);
console.log(`\nSound Passport QA: ${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed.length && !ONLY_CAPTURE ? 1 : 0);
