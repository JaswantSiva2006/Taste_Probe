import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { startServer } from "./serve.mjs";

/**
 * S9.8 browser verification of the isolated YouTube IFrame prototype.
 * Network: YouTube player only (no Data API, no Qloo, no Gemini).
 * "Playing" is asserted from the player's PLAYING state plus an advancing
 * currentTime — it does not prove sound was audible to a person.
 */
const OUT = ".artifacts/s9-8";
const CHANNEL = process.env.PW_CHANNEL || undefined; // e.g. msedge if bundled Chromium lacks codecs
await mkdir(OUT, { recursive: true });
const server = await startServer(0);
const origin = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ channel: CHANNEL, args: ["--autoplay-policy=user-gesture-required"] });
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: Boolean(pass), detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`); };

const probe = (page) => page.evaluate(() => window.__probe());
const events = (page) => page.evaluate(() => window.__log);
async function waitFor(page, fn, arg, timeout = 20_000) {
  return page.waitForFunction(fn, arg, { timeout, polling: 250 }).then(() => true, () => false);
}

async function session(viewport, policy) {
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 768, hasTouch: viewport.width < 768 });
  const page = await context.newPage();
  const embeds = [];
  page.on("request", (r) => { if (/youtube\.com\/embed\//.test(r.url())) embeds.push({ url: r.url().split("?")[0], referer: r.headers()["referer"] ?? null }); });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });
  await page.goto(`${origin}/${policy ? `?policy=${policy}` : ""}`);
  const ready = await waitFor(page, () => window.__log?.some((e) => e.type === "ready"));
  return { context, page, embeds, consoleErrors, ready };
}

const tag = (v) => `${v.width}`;
for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  const { context, page, embeds, consoleErrors, ready } = await session(viewport);
  check(`${tag(viewport)} player ready`, ready, { embeds: embeds.length });
  const p0 = await probe(page);
  check(`${tag(viewport)} visible player size (>=200x200)`, p0 && p0.box.w >= 200 && p0.box.h >= 200, p0?.box);
  if (viewport.width >= 1024) check(`${tag(viewport)} recommended size (>=480x270)`, p0.box.w >= 480 && p0.box.h >= 270, p0.box);
  await page.waitForTimeout(1500);
  const idle = await probe(page);
  check(`${tag(viewport)} no autoplay on load`, idle.state !== 1 && !(await events(page)).some((e) => e.type === "state" && e.state === 1), { state: idle.state });
  check(`${tag(viewport)} Referer sent to embed (origin only)`, embeds[0]?.referer === `${origin}/`, embeds[0]);
  await page.screenshot({ path: `${OUT}/yt-${tag(viewport)}-cued.png` });

  // User-triggered playback of the featured moment (track 0: start 30, end 45).
  await page.click("#play");
  const playing = await waitFor(page, () => window.__probe()?.state === 1);
  const t1 = (await probe(page)).time;
  await page.waitForTimeout(2500);
  const p1 = await probe(page);
  check(`${tag(viewport)} user-triggered PLAYING with advancing time`, playing && p1.time > t1, { t1, t2: p1.time, muted: p1.muted, volume: p1.volume, title: p1.video.title, author: p1.video.author });
  check(`${tag(viewport)} featured start honoured (~30s)`, t1 >= 29 && t1 < 34, { startObserved: t1 });
  await page.screenshot({ path: `${OUT}/yt-${tag(viewport)}-playing.png` });

  if (viewport.width === 1440) {
    // End of moment: player stops at endSeconds (45).
    const ended = await waitFor(page, () => window.__probe()?.state === 0, undefined, 25_000);
    const pe = await probe(page);
    check("1440 featured end honoured (stops ~45s)", ended && pe.time >= 44 && pe.time <= 46.5, { ended, time: pe.time });
    // Replay restarts at the moment start.
    await page.click("#replay");
    const replayed = await waitFor(page, () => window.__probe()?.state === 1);
    const pr = await probe(page);
    check("1440 replay restarts the moment", replayed && pr.time >= 29 && pr.time < 36, { time: pr.time });
  }

  // Switch track while playing: one player, previous video replaced.
  await page.click('.tracks button[data-index="1"]');
  await page.waitForTimeout(800);
  const ps = await probe(page);
  check(`${tag(viewport)} selecting another track stops previous (cued, not playing)`, ps.state !== 1 && ps.video.video_id === "InyT9Gyoz_o", { state: ps.state, videoId: ps.video.video_id });
  await page.click("#play");
  const playing2 = await waitFor(page, () => window.__probe()?.state === 1 && window.__probe().video.video_id === "InyT9Gyoz_o");
  const p2 = await probe(page);
  const states2 = playing2 ? undefined : (await events(page)).filter((e) => e.videoId === "InyT9Gyoz_o").map((e) => `${e.type}:${e.state ?? ""}@${e.at ?? ""}`);
  if (!playing2) await page.screenshot({ path: `${OUT}/yt-${tag(viewport)}-switch-stalled.png` });
  check(`${tag(viewport)} switched video plays; single iframe`, playing2 && p2.iframes === 1, { videoId: p2.video.video_id, title: p2.video.title, author: p2.video.author, time: p2.time, iframes: p2.iframes, states2 });

  if (viewport.width === 1440) {
    await page.click('.tracks button[data-index="2"]');
    await page.waitForTimeout(800); // let the cue settle, as a person would
    await page.click("#play");
    const playing3 = await waitFor(page, () => window.__probe()?.state === 1 && window.__probe().video.video_id === "xpZgtFhDbss");
    const p3 = await probe(page);
    check("1440 third mapping plays", playing3, { title: p3.video.title, author: p3.video.author, time: p3.time });
  }

  // Unavailable video -> onError -> fallback; no previous video left playing.
  await page.click('.tracks button[data-index="3"]');
  await page.click("#play");
  const errored = await waitFor(page, () => window.__log.some((e) => e.type === "error"));
  await page.waitForTimeout(500);
  const pfa = await probe(page);
  await page.waitForTimeout(1500);
  const pf = await probe(page);
  pf.state = pf.state === 1 || pf.time > pfa.time + 0.5 ? 1 : pf.state; // advancing time counts as playing
  const fallbackVisible = await page.isVisible("#fallback");
  const err = (await events(page)).find((e) => e.type === "error");
  check(`${tag(viewport)} unavailable video -> visible fallback, nothing playing`, errored && fallbackVisible && pf.state !== 1, { code: err?.code, state: pf.state });
  await page.screenshot({ path: `${OUT}/yt-${tag(viewport)}-fallback.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(`${tag(viewport)} no horizontal overflow`, !overflow, {});
  check(`${tag(viewport)} page console errors`, true, { count: consoleErrors.length, sample: consoleErrors.slice(0, 3) });
  await context.close();
}

// Referer experiment: same page with Referrer-Policy: no-referrer.
{
  const { context, page, embeds, ready } = await session({ width: 1440, height: 900 }, "no-referrer");
  let playing = false, err = null;
  const docReferrerStripped = await page.evaluate(() => document.referrer === "");
  const iframePolicy = await page.evaluate(() => document.querySelector("iframe")?.getAttribute("referrerpolicy") ?? null);
  if (ready) {
    await page.click("#play");
    playing = await waitFor(page, () => window.__probe()?.state === 1, undefined, 12_000);
    err = (await events(page)).find((e) => e.type === "error") ?? null;
  }
  await page.screenshot({ path: `${OUT}/yt-1440-no-referrer.png` });
  check("no-referrer variant (observation, not a requirement)", true, { docReferrerStripped, iframePolicy, embedReferer: embeds[0]?.referer ?? null, ready, playing, errorCode: err?.code ?? null });
  await context.close();
}

await browser.close();
server.close();
await writeFile(`${OUT}/youtube-verify.json`, JSON.stringify({ origin, channel: CHANNEL ?? "playwright-chromium", results }, null, 1));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
