#!/usr/bin/env node
/**
 * npm run verify:mappings   (free: official IFrame player only, no API key, no quota)
 *
 * Plays every reviewed video (primary and alternates) in the official YouTube IFrame
 * player, from a real localhost origin, and records what YouTube's player reports:
 * video ID, title, channel and duration. A video passes only if it reaches PLAYING with
 * time advancing and its reported ID and channel equal the registry's. Writes
 * .artifacts/music-mappings/audit.json. Audibility is not claimed.
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { REVIEWED_MAPPINGS } from "../src/lib/music/mappings.ts";

const PAGE = `<!doctype html><meta charset="utf-8"><title>mapping audit</title>
<div style="width:640px;height:360px"><div id="p"></div></div>
<script>
window.__ready = false;
window.onYouTubeIframeAPIReady = () => {
  window.player = new YT.Player("p", { width: 640, height: 360, playerVars: { controls: 1, playsinline: 1, origin: location.origin },
    events: { onReady: () => (window.__ready = true), onError: (e) => (window.__error = e.data) } });
};
</script><script src="https://www.youtube.com/iframe_api"></script>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "referrer-policy": "strict-origin-when-cross-origin" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const page = await browser.newPage();
await page.goto(origin);
await page.waitForFunction(() => window.__ready, null, { timeout: 30_000 });

const rows = [];
for (const m of REVIEWED_MAPPINGS) {
  for (const [role, v] of [["primary", m.primary], ...m.alternates.map((a) => ["alternate", a])]) {
    await page.evaluate((id) => {
      window.__error = null;
      window.player.loadVideoById({ videoId: id });
    }, v.videoId);
    const playing = await page
      .waitForFunction(() => window.__error !== null || window.player.getPlayerState() === 1, null, { timeout: 25_000, polling: 250 })
      .then(() => page.evaluate(() => window.__error === null), () => false);
    const t1 = await page.evaluate(() => window.player.getCurrentTime());
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => ({ t2: window.player.getCurrentTime(), data: window.player.getVideoData(), duration: Math.round(window.player.getDuration()), error: window.__error }));
    await page.evaluate(() => window.player.stopVideo());
    const pass = playing && info.t2 > t1 && info.data.video_id === v.videoId && info.data.author === v.channelTitle;
    rows.push({ artist: m.artistName, review: m.review, role, videoId: v.videoId, pass, reportedTitle: info.data.title, reportedChannel: info.data.author, expectedChannel: v.channelTitle, titleMatches: info.data.title === v.title, durationSeconds: info.duration, error: info.error });
    console.log(`${pass ? "PASS" : "FAIL"} ${m.artistName} ${role} ${v.videoId} "${info.data.title}" · ${info.data.author} · ${info.duration}s${info.error ? ` error ${info.error}` : ""}`);
  }
}
await browser.close();
server.close();
await mkdir(".artifacts/music-mappings", { recursive: true });
await writeFile(".artifacts/music-mappings/audit.json", JSON.stringify({ at: new Date().toISOString(), origin, rows }, null, 1));
const failed = rows.filter((r) => !r.pass);
console.log(`\n${rows.length - failed.length}/${rows.length} reviewed videos played with matching identity`);
process.exit(failed.length ? 1 : 0);
