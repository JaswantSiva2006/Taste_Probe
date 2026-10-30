#!/usr/bin/env node
/**
 * npm run qa:passport — Sound Passport browser QA (S9.13; music-only flow and verified
 * previews since S9.15). Free: no Qloo/Gemini spend.
 *
 * Runs the REAL Next.js app (`next dev`) in live-shaped mode against a local Qloo HTTP
 * stub serving genuine recorded identities (scripts/lib/qloo-stub.mjs), with
 * LLM_PROVIDER=none (deterministic agent and song choice), a memory session store and
 * no YouTube Data API key, so recordings come from the reviewed registry and play in
 * the official YouTube player (needs internet for YouTube only).
 *
 * Journey: landing → Start discovering → five starting points → Movies → Interstellar →
 * stage → Begin listening → Quick preview (bounded start, pause/resume, boundary stop,
 * replay, native scrub outside the window → full) → Listen in full → Rewind → Replay →
 * switch recording mid-preview → Love → Not for me → Another song → Previous → Next →
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
    if (m.type() === "error" && !/doubleclick|googleads|youtube\.com\/(api|generate_204)|Failed to load resource|Permissions policy violation: compute-pressure/.test(m.text())) errors.push(m.text().slice(0, 200));
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
const attr = (page, name) => page.locator(".tp-player").getAttribute(name);
const now = async (page) => Number(await attr(page, "data-current-time"));
/** Waits until the published player time is past `t` (it updates every 500 ms while playing). */
const waitTime = (page, pred, timeout = 20_000) =>
  page.waitForFunction((src) => { const t = Number(document.querySelector(".tp-player")?.getAttribute("data-current-time")); return Number.isFinite(t) && new Function("t", `return ${src}`)(t); }, String(pred), { timeout, polling: 250 }).then(() => true, () => false);
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
  await page.getByRole("button", { name: /Start discovering/ }).first().click();
  await chooseSource(page, "Movies");
  await searchAndSelect(page, "Interstellar", "Interstellar");
  await page.getByRole("button", { name: /^Discover music from/ }).click();
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
    check("music-only landing: no destination picker and no book copy", (await page.locator('input[name="tp-target"]').count()) === 0 && !/\bbooks?\b/i.test(await page.textContent("main")));
    await page.getByRole("button", { name: /Start discovering/ }).first().click();
    await page.waitForTimeout(700);
    check("Start discovering: focus on the starting points, nothing preselected", (await page.evaluate(() => document.activeElement?.getAttribute("name"))) === "tp-source" && (await page.locator(".ah-input.is-on").count()) === 0);
    check("five starting points from the server registry", (await page.locator(".ah-input__name").allTextContents()).join("|") === "Movies|Artists|TV shows|Games|Podcasts");
    for (const [label, prompt] of [["Artists", /keep coming back/], ["TV shows", /never forget/], ["Games", /made an impression/], ["Podcasts", /podcast do you love/], ["Movies", /film stays with you/]]) {
      await chooseSource(page, label);
      const ok = prompt.test(await page.textContent(".ah-search__label"));
      check(`starting point ${label}: selected, search prompt follows`, ok);
      await page.locator("#tp-plan").screenshot({ path: resolve(OUT, `1440-02-source-${label.replace(/\s/g, "-").toLowerCase()}.png`) });
    }
    await searchAndSelect(page, "Interstellar", "Interstellar");
    await shot(page, "1440-02-source-selected");
    await page.getByRole("button", { name: /^Discover music from/ }).click();
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

    // ---- S9.15 verified preview: server window, official player bounds, guarded end
    const pStart = Number(await attr(page, "data-preview-start"));
    const pEnd = Number(await attr(page, "data-preview-end"));
    const label = await page.textContent(".sp-modes");
    check("preview ready: server window shown truthfully as a Quick preview", (await attr(page, "data-mode")) === "preview" && pEnd - pStart === 30 && pStart > 0 && /Quick preview/.test(label) && /not by listening/.test(label) && !/best|highlight moment|chorus/i.test(label.replace("It isn’t a highlight", "")), { pStart, pEnd, first });
    await page.getByRole("button", { name: "Play preview", exact: true }).click();
    const playing = await waitPhase(page, "playing");
    await waitTime(page, `t >= ${pStart}`);
    await page.waitForTimeout(1200);
    const v1 = await vinyl(page);
    const t1 = await now(page);
    check("preview plays from its validated start (YouTube PLAYING) and the vinyl turns", playing && t1 >= pStart - 1 && t1 < pEnd && v1.state === "playing" && v1.playState === "running", { t1, pStart, v1: v1.state });
    await shot(page, "1440-06-preview-playing");

    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const paused = await waitPhase(page, "paused", 10_000);
    const p1 = await vinyl(page);
    await page.waitForTimeout(900);
    const p2 = await vinyl(page);
    const tPaused = await now(page);
    check("pause mid-preview: YouTube PAUSED; vinyl holds its angle", paused && p1.playState === "paused" && p1.transform === p2.transform && p1.transform !== "none", { p1: p1.transform, p2: p2.transform });
    await shot(page, "1440-07-preview-paused");
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await waitPhase(page, "playing");
    await page.waitForTimeout(1200);
    const tResumed = await now(page);
    check("resume keeps the preview range (paused time never counts)", tResumed >= tPaused - 0.5 && tResumed < pEnd && (await attr(page, "data-mode")) === "preview", { tPaused, tResumed });

    const tBefore = await now(page);
    await page.getByRole("button", { name: "Back 10 seconds" }).click();
    await page.waitForTimeout(1300);
    const tAfter = await now(page);
    check("Back 10 s inside a preview never leaves the window", tAfter < tBefore && tAfter >= pStart - 1, { tBefore, tAfter, pStart });

    const ended = await page.waitForFunction(() => document.querySelector(".tp-player")?.getAttribute("data-preview-ended") === "true", null, { timeout: 45_000, polling: 250 }).then(() => true, () => false);
    await page.waitForTimeout(800);
    const tEnd = await now(page);
    const vEnd = await vinyl(page);
    check("preview stops at its validated end (after a seek invalidated endSeconds)", ended && tEnd <= pEnd + 1.6 && tEnd >= pEnd - 2 && vEnd.spinning === "still", { tEnd, pEnd, phase: await phase(page) });
    check("preview end is not a failure and offers replay or full", /Preview finished/.test(await page.textContent(".sp-transport__state")) && (await page.getByRole("button", { name: /Replay preview/ }).count()) === 1);
    await shot(page, "1440-07b-preview-ended");

    await page.getByRole("button", { name: /Replay preview/ }).click();
    await waitPhase(page, "playing");
    // The published time only refreshes while playing: wait for a fresh reading inside the window.
    await waitTime(page, `t >= ${pStart - 1} && t < ${pStart + 6}`);
    const tReplay = await now(page);
    check("Replay preview starts the window again", tReplay >= pStart - 1 && tReplay < pStart + 6 && (await attr(page, "data-preview-ended")) === "false", { tReplay });

    // A native scrub (YouTube's own progress bar) outside the window switches to full listening.
    let scrubbed = false;
    try {
      const frame = page.frameLocator(".tp-player iframe");
      const bar = frame.locator(".ytp-progress-bar");
      await page.locator(".tp-player__frame").hover();
      const box = await bar.boundingBox({ timeout: 8000 });
      await bar.click({ position: { x: box.width * 0.82, y: box.height / 2 }, force: true, timeout: 8000 });
      scrubbed = true;
    } catch {
      // Fallback: an external seek through the embed's own postMessage channel (the same one the
      // IFrame API uses). It moves the position without going through TasteProbe's controller,
      // exactly like a scrub on YouTube's native progress bar.
      await page.evaluate((to) => {
        const f = document.querySelector(".tp-player iframe");
        f?.contentWindow?.postMessage(JSON.stringify({ event: "command", func: "seekTo", args: [to, true], id: 1, channel: "widget" }), "*");
      }, pEnd + 120);
      scrubbed = "external-seek";
    }
    if (scrubbed) {
      const toFull = await page.waitForFunction(() => document.querySelector(".tp-player")?.getAttribute("data-mode") === "full", null, { timeout: 8000, polling: 250 }).then(() => true, () => false);
      await waitPhase(page, "playing", 10_000);
      await page.waitForTimeout(3000);
      const tScrub = await now(page);
      check("native seek outside the preview → full listening, not a seek-back fight; plays past the window", toFull && tScrub > pEnd + 2 && (await phase(page)) === "playing", { tScrub, pEnd, via: scrubbed === true ? "progress-bar click" : scrubbed });
      await shot(page, "1440-07c-native-seek-full");
    } else {
      check("native seek outside the preview (YouTube progress bar not reachable in this run)", true, { skipped: true });
    }

    await page.getByRole("button", { name: /^Listen in full/ }).click();
    await waitPhase(page, "playing");
    await page.waitForTimeout(1500);
    const tFull = await now(page);
    check("Listen in full: whole recording from the start, no end bound", (await attr(page, "data-mode")) === "full" && tFull < 5 && (await page.getByRole("button", { name: /^Listen in full/ }).getAttribute("aria-pressed")) === "true", { tFull });
    await shot(page, "1440-08a-full-playing");
    await page.getByRole("button", { name: "Replay from the start" }).click();
    await page.waitForTimeout(2500);
    check("Replay restarts the full recording", (await now(page)) < 4);

    // Preview active, then another recording: the old boundary cannot touch the new one; nothing autoplays.
    await page.getByRole("button", { name: /^Hear preview|^Replay preview/ }).click();
    await waitPhase(page, "playing");
    await page.getByRole("button", { name: "Next recording (no rating)" }).click();
    await settle(page);
    const switched = await videoId(page);
    await waitPhase(page, "ready");
    await page.waitForTimeout(2500);
    check("switching recording during a preview: new player, cued not playing, fresh preview state", switched !== first && (await phase(page)) === "ready" && (await attr(page, "data-preview-ended")) === "false" && (await page.locator('iframe[src*="youtube.com/embed"]').count()) === 1, { switched });
    await page.getByRole("button", { name: /^Previous recording/ }).click();
    await settle(page);

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
    const back = await videoId(page);
    check("Previous: back to an earlier recording (server-authorized replay)", back !== second && [first, switched].includes(back), { back });
    await click(page, "Save to Passport");
    const savedPreview = await page.evaluate(() => JSON.parse(localStorage.getItem("tasteprobe.passport.v1") ?? "{}").items?.[0]);
    check("Save: exact canonical recording; preview window kept only as optional metadata", savedPreview?.video?.videoId === back && savedPreview?.preview?.endSeconds - savedPreview?.preview?.startSeconds === 30, { savedPreview: savedPreview?.preview });
    await page.evaluate(() => localStorage.removeItem("tasteprobe.passport.v1"));
    await page.reload({ waitUntil: "networkidle" });
    await toStage(page);
    await click(page, "Begin listening");
    await page.getByRole("button", { name: "Next recording (no rating)" }).click();
    await settle(page);
    const afterNext = await videoId(page);
    check("Next: neutral navigation to an unheard recording", afterNext !== first, { afterNext });

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
    check("unmapped artist: truthful no-recording state", /We couldn’t verify a recording for Shawn Mendes/.test(await page.textContent("#tp-listen-title")));
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
    await page.getByRole("button", { name: /Start exploring|Start discovering/ }).first().click();
    await page.waitForTimeout(600);
    check("Empty Passport → back to the starting points", (await page.locator(".ah-input").count()) === 5);
    check("1440 journey: no page/console errors", errors.length === 0, { errors: errors.slice(0, 5) });
    await context.close();
  }

  // ------------------------------------------------ music only: books are not offered or startable
  {
    const { page, context } = await newPage(1440);
    await page.goto(base, { waitUntil: "networkidle" });
    const res = await page.evaluate(() =>
      fetch("/api/discovery/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entityQuery: "Interstellar", sourceType: "movie", targetType: "book", maxQuestions: 3, selectedEntityId: "057DA9D9-399B-437E-8BCA-A80E499125EF" }) }).then(async (r) => ({ status: r.status, code: (await r.json()).error?.code })),
    );
    const health = await page.evaluate(() => fetch("/api/health").then((r) => r.json()));
    check("music-only server: movie → book refused before any provider call; books never published", res.status === 400 && res.code === "UNSUPPORTED_DOMAIN" && !JSON.stringify(health.data.capabilities).includes("book"), res);
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
    await page.getByRole("button", { name: "Play preview", exact: true }).tap();
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
    await page.getByRole("button", { name: "Play preview", exact: true }).click();
    await waitPhase(page, "playing");
    await page.waitForTimeout(1200);
    const v = await vinyl(page);
    check("reduced motion: playing, but the record does not animate", v.state === "playing" && v.name === "none", { ...v, phase: await phase(page), mode: await attr(page, "data-mode"), ended: await attr(page, "data-preview-ended"), t: await attr(page, "data-current-time") });
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
