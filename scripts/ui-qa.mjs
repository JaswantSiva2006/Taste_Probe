#!/usr/bin/env node
/**
 * UI QA driver (S8): drives the real discovery flow in a browser against a
 * running MOCK server and captures every major state at 320/375/768/1024/1440.
 * Also asserts functional behaviour and basic hygiene (overflow, broken images,
 * console errors). Screenshots go to .artifacts/ui (git-ignored).
 *
 *   npm run dev:mock            (in another terminal)
 *   node scripts/ui-qa.mjs --url http://127.0.0.1:3000 [--widths 375,1440] [--states]
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const url = arg("--url", "http://127.0.0.1:3000");
const widths = arg("--widths", "320,375,768,1024,1440").split(",").map(Number);
const out = resolve(arg("--out", ".artifacts/ui"));
const reduced = process.argv.includes("--reduced-motion");
await mkdir(out, { recursive: true });

const report = [];
const browser = await chromium.launch();

async function hygiene(page, label) {
  return page.evaluate((label) => {
    const vw = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth > vw + 1;
    const offenders = [...document.querySelectorAll("body *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return s.display !== "none" && r.width > 0 && (r.right > vw + 2 || r.left < -2) && s.position !== "fixed";
      })
      .slice(0, 6)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
    const broken = [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src);
    const smallTargets = [...document.querySelectorAll("button, a, input")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24);
      })
      .map((el) => (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 30));
    return { label, overflow, offenders, broken, smallTargets, h1: document.querySelectorAll("h1").length };
  }, label);
}

for (const width of widths) {
  const height = width >= 1024 ? 900 : width === 768 ? 1024 : 812;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? "reduce" : "no-preference" });
  const page = await context.newPage();
  const errors = [];
  let inducedFailure = false; // the deliberate network abort below is expected to log one error
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => m.type() === "error" && !(inducedFailure && /ERR_FAILED/.test(m.text())) && errors.push(m.text()));
  const shot = async (name, full = true) => {
    await page.waitForTimeout(reduced ? 50 : 900); // let reveal/FLIP motion settle
    await page.screenshot({ path: resolve(out, `${width}-${name}.png`), fullPage: full });
    report.push({ width, ...(await hygiene(page, name)) });
  };
  const posted = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/discovery/answer")) posted.push(JSON.parse(r.postData() ?? "{}"));
  });

  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await shot("01-landing-fold", false);
  await shot("01-landing-full");

  // search -> results (keyboard: Enter submits)
  await page.fill("#tp-film", "Interstellar");
  await page.press("#tp-film", "Enter");
  await page.waitForSelector(".tp-ticket");
  const tickets = await page.locator(".tp-ticket").count();
  assert.ok(tickets >= 2, "ambiguous search should list several films");
  assert.equal(await page.locator('.tp-ticket[aria-pressed="true"]').count(), 0, "must not auto-select an ambiguous film");
  await shot("02-results");

  // keyboard selection of the exact title
  const exact = page.locator(".tp-ticket").filter({ has: page.locator(".tp-ticket__title", { hasText: /^Interstellar$/ }) });
  await exact.focus();
  await page.keyboard.press("Space");
  assert.equal(await exact.getAttribute("aria-pressed"), "true");
  await shot("03-selected");

  // start
  await page.getByRole("button", { name: /Begin with Interstellar/ }).click();
  await page.waitForSelector("#tp-question");
  const q1 = await page.textContent("#tp-question");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "tp-question", "focus moves to the question");
  assert.ok((await page.locator(".tp-shelf__item").count()) > 0, "shelf renders");
  await shot("04-question-1");

  // keyboard: Tab from the focused question reaches the first answer, with a visible ring
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => ({
    text: document.activeElement?.textContent,
    outline: getComputedStyle(document.activeElement).outlineStyle,
    width: getComputedStyle(document.activeElement).outlineWidth,
  }));
  assert.equal(focused.text, "Yes, more of this", "Tab order: question -> first answer");
  assert.equal(focused.outline, "solid", "visible focus ring");
  await page.locator(".tp-intertitle").screenshot({ path: resolve(out, `${width}-04b-keyboard-focus.png`) });

  // answer "like" -> verify submitted value + visible update
  await page.getByRole("button", { name: "Yes, more of this" }).click();
  await page.waitForFunction((prev) => document.querySelector("#tp-question")?.textContent !== prev, q1);
  assert.equal(posted.at(-1)?.response, "like", "answer button submits the backend 'like' value");
  await page.waitForSelector(".tp-notice");
  assert.ok((await page.locator(".tp-note--liked").count()) === 1, "confirmed preference appears");
  const notice = await page.textContent(".tp-notice strong");
  assert.match(notice, /reordered|held steady|Fresh picks/);
  await shot("05-after-answer");

  // simulated network failure on the next answer -> error + retry recovery
  let failOnce = true;
  inducedFailure = true;
  await page.route("**/api/discovery/answer", (route) => (failOnce ? ((failOnce = false), route.abort("failed")) : route.continue()));
  await page.getByRole("button", { name: "Not sure" }).click();
  await page.waitForSelector(".tp-error");
  await shot("06-error", false);
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForSelector(".tp-error", { state: "detached" });
  assert.equal(posted.at(-1)?.response, "unknown", "retry re-submits the same answer");
  await page.unroute("**/api/discovery/answer");
  inducedFailure = false;

  // finish early -> programme
  await page.getByRole("button", { name: /End screening/ }).click();
  await page.waitForSelector("#tp-programme-title");
  const finals = await page.locator(".tp-programme .tp-book").count();
  assert.ok(finals >= 1 && finals <= 5, "1–5 final books");
  await shot("07-programme");
  await shot("07-programme-fold", false);

  // restart returns to landing with focus in the search box
  await page.getByRole("button", { name: "Start another screening" }).click();
  await page.waitForSelector("#tp-film");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "tp-film");

  report.push({ width, errors });
  await context.close();
}
// Visual-only scenario: states mock data never produces (entity comparison,
// long series titles, real-looking cover art). The start response is rewritten
// in the browser; nothing is submitted, so no backend contract is involved.
const COVER = (hue) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="hsl(${hue},35%,30%)"/><circle cx="200" cy="260" r="120" fill="hsl(${hue},60%,60%)"/><text x="200" y="520" font-size="34" text-anchor="middle" fill="#fff" font-family="serif">TEST COVER</text></svg>`,
  )}`;
for (const width of [375, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: width >= 1024 ? 900 : 812 } });
  const page = await context.newPage();
  await page.route("**/api/discovery/start", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    const recs = json.data.recommendations;
    recs[0].candidate.name = "The Name of the Wind (The Kingkiller Chronicle, #1)";
    recs[0].candidate.imageUrl = COVER(20);
    recs[1].candidate.name = "A Song of Ice and Fire: A Storm of Swords, Part Two (A Song of Ice and Fire, #3)";
    recs[1].candidate.imageUrl = COVER(200);
    recs[2].candidate.imageUrl = "https://invalid.example/missing.jpg"; // must fall back cleanly
    const [a, b] = [recs[0].candidate, recs[1].candidate];
    json.data.currentQuestion = {
      questionId: `entity:${a.entityId}|${b.entityId}`,
      text: `Which book sounds more appealing: “${a.name}” or “${b.name}”?`,
      targetType: "entity",
      targetIds: [a.entityId, b.entityId],
      allowedResponses: ["prefer_a", "prefer_b", "both", "neither", "unknown"],
    };
    await route.fulfill({ response: res, json });
  });
  await page.route("https://invalid.example/**", (r) => r.abort());
  await page.goto(url, { waitUntil: "networkidle" });
  await page.fill("#tp-film", "Interstellar");
  await page.press("#tp-film", "Enter");
  await page.locator(".tp-ticket").filter({ has: page.locator(".tp-ticket__title", { hasText: /^Interstellar$/ }) }).click();
  await page.getByRole("button", { name: /Begin with/ }).click();
  await page.waitForSelector(".tp-versus");
  for (const label of ["I'd pick The Name of the Wind", "Both appeal", "Neither", "I don't know them"]) {
    assert.ok(await page.getByRole("button", { name: label }).count(), `entity answer "${label}" rendered`);
  }
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(out, `${width}-08-entity-question.png`), fullPage: true });
  report.push({ width, ...(await hygiene(page, "08-entity-question")) });
  await context.close();
}

await browser.close();
await writeFile(resolve(out, "qa-report.json"), JSON.stringify(report, null, 2));

const problems = report.filter((r) => r.overflow || r.broken?.length || r.errors?.length);
for (const r of report.filter((r) => r.label)) {
  const flags = [r.overflow && `OVERFLOW ${r.offenders.join(",")}`, r.broken.length && `BROKEN ${r.broken.length}`, r.smallTargets.length && `small:${r.smallTargets.join("|")}`].filter(Boolean);
  if (flags.length) console.log(`${r.width} ${r.label}: ${flags.join(" ; ")}`);
}
for (const r of report.filter((r) => r.errors?.length)) console.log(`${r.width} console/page errors: ${r.errors.join(" | ")}`);
console.log(`UI QA: ${widths.length} widths, flow assertions passed, ${problems.length} hygiene problem(s). Screenshots: ${out}`);
process.exitCode = problems.length ? 1 : 0;
