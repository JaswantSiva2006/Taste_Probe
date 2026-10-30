#!/usr/bin/env node
/**
 * UI QA driver (S8, rebuilt for S9.4): drives the real exploration flow in a
 * browser against a running MOCK server (synthetic fixtures, no Qloo/Gemini),
 * asserts behaviour and captures every major state. Screenshots go to
 * .artifacts/ui (git-ignored).
 *
 *   npm run dev:mock            (in another terminal)
 *   node scripts/ui-qa.mjs --url http://127.0.0.1:3000 [--widths 375,1440] [--reduced-motion]
 *
 * Journeys: movie→book (every width, full keyboard + error-recovery path),
 * music_artist→book, movie→music_artist, early finish, capability failure,
 * 429 without auto-retry, session conflict, and a server-side unsupported-pair check.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { axeScan, begin, chooseSource, chooseWorld, hygiene, searchAndSelect } from "./lib/ui-flow.mjs";

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
/** axe-core results for key screens at 375 and 1440 (automated only; not a WCAG claim). */
const a11y = [];
const audit = async (page, width, label) => {
  if (width === 375 || width === 1440) a11y.push({ width, label, violations: await axeScan(page) });
};
const passed = [];
const browser = await chromium.launch();
const heightOf = (w) => (w >= 1024 ? 900 : w === 768 ? 1024 : 812);


async function open(width, opts = {}) {
  const context = await browser.newContext({ viewport: { width, height: heightOf(width) }, reducedMotion: reduced ? "reduce" : "no-preference" });
  const page = await context.newPage();
  const errors = [];
  const state = { induced: false };
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => m.type() === "error" && !(state.induced && /ERR_FAILED|status of (400|409|429|500)/.test(m.text())) && errors.push(m.text()));
  const requests = { search: [], start: [], answer: [], finish: 0, health: 0 };
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/api/entities/search")) requests.search.push(new URL(u).searchParams.get("type"));
    if (u.includes("/api/discovery/start")) requests.start.push(JSON.parse(r.postData() ?? "{}"));
    if (u.includes("/api/discovery/answer")) requests.answer.push(JSON.parse(r.postData() ?? "{}"));
    if (u.includes("/api/discovery/finish")) requests.finish += 1;
    if (u.includes("/api/health")) requests.health += 1;
  });
  const responses = {};
  page.on("response", async (r) => {
    const u = r.url();
    if (/\/api\/(discovery\/(start|answer|finish)|health)/.test(u) && r.ok()) {
      try {
        responses[u.split("/api/")[1]] = await r.json();
      } catch {
        /* navigation may discard bodies */
      }
    }
  });
  if (opts.before) await opts.before(page, state);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const shot = async (name, full = true) => {
    await page.waitForTimeout(reduced ? 60 : 900); // let reveal/FLIP motion settle
    await page.screenshot({ path: resolve(out, `${width}-${name}.png`), fullPage: full });
    report.push({ width, ...(await hygiene(page, name)) });
  };
  const close = async () => {
    report.push({ width, errors });
    await context.close();
  };
  return { page, shot, close, requests, responses, state, errors };
}

/** Rendered destinations must be exactly the server's enabled targets. */
async function expectWorldsFromHealth(page) {
  const health = await page.evaluate(() => fetch("/api/health").then((r) => r.json()));
  const expected = [...new Set(health.data.capabilities.pairs.map((p) => p.targetLabel.toLowerCase()))];
  const rendered = (await page.locator(".tp-world__name").allTextContents()).map((t) => t.toLowerCase());
  assert.deepEqual(rendered, expected, "destination placards must mirror /api/health capabilities");
  for (const absent of ["podcasts", "video games", "tv shows", "movies"]) assert.ok(!rendered.includes(absent), `${absent} must not be offered`);
  return health.data.capabilities.pairs;
}

/** Finale assertions shared by every journey. */
async function expectFinale(page, responses, { target, minFeatured = 1 }) {
  await page.waitForSelector("#tp-programme-title");
  const view = (responses["discovery/finish"] ?? responses["discovery/start"] ?? responses["discovery/answer"]).data;
  assert.equal(view.status, "finished");
  const path = view.discoveryPath;
  assert.ok(path, "backend returned a discoveryPath");
  assert.equal(await page.locator(".tp-start__label").count(), 1, "exactly one START HERE");
  assert.equal(await page.locator(".tp-start__label").textContent(), "Start here");
  const featuredTitle = (await page.locator(".tp-start .tp-card__title").textContent()).trim();
  const lead = view.recommendations.find((r) => r.candidate.entityId === path.featured[0].recommendationEntityId).candidate.name;
  assert.ok(lead.startsWith(featuredTitle), `START HERE shows the backend's lead (${featuredTitle} vs ${lead})`);
  const roles = await page.locator(".tp-path__role").allTextContents();
  assert.deepEqual(roles, path.featured.slice(1).map((f) => ({ EXPLORE_NEXT: "Explore next", ANOTHER_DIRECTION: "Another direction", GO_FURTHER: "Go further" })[f.role]), "roles shown only as returned");
  assert.ok(path.featured.length >= minFeatured);
  const allTitles = await page.locator(".tp-programme .tp-card__title").allTextContents();
  assert.equal(new Set(allTitles).size, allTitles.length, "no recommendation is shown twice");
  assert.equal(allTitles.length, view.recommendations.length, "every final recommendation shown once, none invented");
  // Why this starting point? reveals the backend text verbatim.
  const why = page.locator(".tp-start .tp-whybox");
  assert.equal(await why.getAttribute("open"), null, "explanation starts collapsed");
  await why.locator("summary").click();
  assert.equal((await why.locator(".tp-whybox__text").textContent()).trim(), path.featured[0].explanation.text);
  const art = target === "book" ? ".tp-art--portrait" : ".tp-art--square";
  assert.ok(await page.locator(`.tp-start ${art}`).count(), `START HERE artwork uses the ${target} frame`);
  assert.equal(await page.locator(".tp-programme a[href^='http']:not(.tp-listen a)").count(), 0, "no external links are invented");
  // S9.9: the listening room may link out, but only to YouTube.
  const listenLinks = await page.locator(".tp-listen a[href^='http']").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  assert.ok(listenLinks.every((h) => h.startsWith("https://www.youtube.com/")), "listening links go to YouTube only");
  assert.equal(await page.locator(".tp-listen").count(), target === "music_artist" ? 1 : 0, "one listening room, music journeys only");
}

// ---------------------------------------------------------------- 1. movie → book, every width

for (const width of widths) {
  const s = await open(width);
  const { page, shot, requests, responses, state } = s;
  await shot("01-landing-fold", false);
  await shot("01-landing-full");
  await audit(page, width, "landing");
  await expectWorldsFromHealth(page);
  assert.equal(await page.locator(".tp-step--anchor").count(), 0, "anchor step waits for a destination");

  await chooseWorld(page, "Books", true);
  const sources = (await page.locator(".tp-chip").allTextContents()).map((t) => t.trim());
  assert.deepEqual(sources, ["a movie", "a music artist"], "Books accepts exactly the server's sources");
  await chooseSource(page, "a movie");
  await shot("02-anchor-step");
  await searchAndSelect(page, "Interstellar", "Interstellar", { viaKeyboard: true });
  assert.equal(requests.search.at(-1), "movie", "search uses the selected source type");
  await shot("03-selected");

  await begin(page);
  assert.deepEqual(
    { s: requests.start.at(-1).sourceType, t: requests.start.at(-1).targetType, id: requests.start.at(-1).selectedEntityId },
    { s: "movie", t: "book", id: "mock:movie:interstellar" },
    "start sends the verified selection and chosen pair",
  );
  const q1 = await page.textContent("#tp-question");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "tp-question", "focus moves to the question");
  assert.ok((await page.locator(".tp-shelf__item").count()) > 0, "candidate cards render");
  await shot("04-question-1");
  await audit(page, width, "question");

  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => ({ text: document.activeElement?.textContent, outline: getComputedStyle(document.activeElement).outlineStyle }));
  assert.equal(focused.text, "Yes, more of this", "Tab order: question -> first answer");
  assert.equal(focused.outline, "solid", "visible focus ring");
  await page.locator(".tp-intertitle").screenshot({ path: resolve(out, `${width}-04b-keyboard-focus.png`) });

  const before = await page.locator(".tp-shelf .tp-card__title").allTextContents();
  await page.getByRole("button", { name: "Yes, more of this" }).click();
  await page.waitForFunction((prev) => document.querySelector("#tp-question")?.textContent !== prev, q1);
  assert.equal(requests.answer.at(-1)?.response, "like");
  await page.waitForSelector(".tp-notice");
  const after = await page.locator(".tp-shelf .tp-card__title").allTextContents();
  const notice = await page.textContent(".tp-notice strong");
  const changed = before.join("|") !== after.join("|");
  assert.equal(/reordered|Fresh picks/.test(notice), changed, "a change is announced only when the order actually changed");
  assert.equal(await page.locator(".tp-note--liked").count(), 1, "confirmed preference appears");
  await shot("05-after-answer");

  // induced network failure -> error + manual retry of the same answer
  let failOnce = true;
  state.induced = true;
  await page.route("**/api/discovery/answer", (route) => (failOnce ? ((failOnce = false), route.abort("failed")) : route.continue()));
  await page.getByRole("button", { name: "Not sure" }).click();
  await page.waitForSelector(".tp-error");
  await shot("06-error", false);
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForSelector(".tp-error", { state: "detached" });
  assert.equal(requests.answer.at(-1)?.response, "unknown", "retry re-submits the same answer");
  await page.unroute("**/api/discovery/answer");
  state.induced = false;

  await page.getByRole("button", { name: "Show my way in" }).click();
  await expectFinale(page, responses, { target: "book", minFeatured: 2 });
  await shot("07-way-in");
  await audit(page, width, "way-in (explanation open)");
  await shot("07-way-in-fold", false);
  // S9.7: "I'll try this" now records the choice through /api/discovery/accept.
  const leadTitle = (await page.locator(".tp-start .tp-card__title").textContent()).trim();
  await page.getByRole("button", { name: `I’ll try this: ${leadTitle}` }).click();
  await page.waitForSelector(".tp-programme--accepted");
  assert.match(await page.textContent("#tp-programme-title"), new RegExp(`You’ll start with ${leadTitle.replace(/[()]/g, "\\$&")}`));
  assert.match(await page.textContent(".tp-programme__sub"), /records only your intention/);
  assert.equal(await page.getByRole("button", { name: "Keep exploring" }).count(), 0, "no continuation after accepting");

  await page.getByRole("button", { name: "Explore another world" }).click();
  await page.waitForSelector(".tp-world");
  assert.equal(await page.locator(".tp-world.is-on").count(), 0, "restart returns to an unchosen destination");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("name")), "tp-target", "focus returns to the destination picker");
  passed.push(`${width}: movie→book full journey`);
  await s.close();
}

// ---------------------------------------------------------------- 2/3/4. other enabled journeys + early finish

for (const width of [375, 1440]) {
  // music_artist → book (ambiguous search)
  {
    const s = await open(width);
    const { page, shot, requests, responses } = s;
    await chooseWorld(page, "Books");
    await chooseSource(page, "a music artist");
    await page.fill("#tp-anchor", "Glass Harbor");
    await searchAndSelect(page, "Glass Harbor", "Glass Harbor (synthetic)");
    assert.ok((await page.locator(".tp-ticket").count()) >= 2, "ambiguous artist names are listed for explicit choice");
    assert.equal(requests.search.at(-1), "music_artist");
    await shot("10-artist-selected");
    await begin(page);
    assert.deepEqual([requests.start.at(-1).sourceType, requests.start.at(-1).targetType], ["music_artist", "book"]);
    assert.match(await page.textContent(".tp-strip__label"), /From music artist to books/);
    await shot("11-artist-question");
    await page.getByRole("button", { name: "Not for me" }).click();
    await page.waitForSelector(".tp-notice");
    await page.getByRole("button", { name: "Show my way in" }).click();
    await expectFinale(page, responses, { target: "book" });
    await page.getByRole("button", { name: "Try another music artist" }).click();
    await page.waitForSelector("#tp-anchor");
    assert.equal(await page.getByRole("radio", { name: "a music artist", exact: true }).isChecked(), true, "same world kept for a new anchor");
    passed.push(`${width}: music_artist→book`);
    await s.close();
  }
  // movie → music_artist (square artwork, artist wording)
  {
    const s = await open(width);
    const { page, shot, requests, responses } = s;
    await chooseWorld(page, "Music artists");
    const sources = (await page.locator(".tp-chip").allTextContents()).map((t) => t.trim());
    assert.deepEqual(sources, ["a movie", "a music artist", "a TV show", "a video game", "a podcast"], "Music artists offers the five server-verified source domains");
    await chooseSource(page, "a movie");
    await searchAndSelect(page, "Interstellar", "Interstellar");
    await begin(page);
    assert.deepEqual([requests.start.at(-1).sourceType, requests.start.at(-1).targetType], ["movie", "music_artist"]);
    assert.match(await page.textContent("#tp-question"), /^Do you enjoy music artists associated with /);
    assert.ok(await page.locator(".tp-shelf .tp-art--square").count(), "artists use the square frame");
    assert.equal(await page.locator(".tp-shelf .tp-art--portrait").count(), 0, "artists never look like books");
    await shot("12-artists-question");
    await page.getByRole("button", { name: "Yes, more of this" }).click();
    await page.waitForSelector(".tp-notice");
    await page.getByRole("button", { name: "Show my way in" }).click();
    await expectFinale(page, responses, { target: "music_artist", minFeatured: 2 });
    const finaleText = await page.textContent(".tp-programme");
    assert.ok(!/\bbooks?\b/i.test(finaleText), "artist finale contains no book copy");
    await shot("13-artists-way-in");
    passed.push(`${width}: movie→music_artist`);
    await s.close();
  }
  // early finish: the backend has too little evidence to ask anything
  {
    const s = await open(width);
    const { page, shot, responses } = s;
    await chooseWorld(page, "Books");
    await chooseSource(page, "a music artist");
    await searchAndSelect(page, "Lone Signal", "Lone Signal (synthetic)");
    await begin(page);
    assert.equal(await page.locator("#tp-question").count(), 0, "no question is pretended");
    await expectFinale(page, responses, { target: "book" });
    assert.equal(responses["discovery/start"].data.finishReason, "insufficient_question_evidence");
    assert.match(await page.textContent(".tp-programme__sub"), /none was asked/);
    assert.equal(await page.locator(".tp-path, .tp-programme__list").count(), 0, "no padded supporting cards");
    // S9.7: one verified pick and no question left → continuing is truthfully unavailable.
    assert.ok(await page.getByRole("button", { name: "Keep exploring" }).isDisabled(), "nothing new to explore after an early finish with one pick");
    assert.match(await page.textContent(".tp-continue__body--blocked"), /seen or turned down every verified book/);
    await shot("14-early-finish");
    passed.push(`${width}: early finish`);
    await s.close();
  }
}

// ---------------------------------------------------------------- 5. error recovery

for (const width of [375, 1440]) {
  // S9.5: slow and broken image hosts (seen live) never leave an empty frame or a false caption.
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  let releaseSlow;
  const slowGate = new Promise((r) => (releaseSlow = r));
  const s = await open(width, {
    before: async (page) => {
      await page.route("https://covers.example/slow.png", async (r) => {
        await slowGate;
        await r.fulfill({ status: 200, contentType: "image/png", body: PNG });
      });
      await page.route("https://covers.example/broken.png", (r) => r.abort());
      await page.route("**/api/discovery/start", async (route) => {
        const res = await route.fetch();
        const json = await res.json();
        json.data.recommendations[0].candidate.imageUrl = "https://covers.example/slow.png";
        json.data.recommendations[1].candidate.imageUrl = "https://covers.example/broken.png";
        await route.fulfill({ response: res, json });
      });
    },
  });
  const { page, shot, state } = s;
  state.induced = true; // the deliberately broken image logs a load error
  await chooseWorld(page, "Books");
  await chooseSource(page, "a movie");
  await searchAndSelect(page, "Interstellar", "Interstellar");
  await begin(page);
  const first = page.locator(".tp-shelf__item").nth(0).locator(".tp-art");
  const second = page.locator(".tp-shelf__item").nth(1).locator(".tp-art");
  await second.locator(".tp-art__note").waitFor();
  assert.equal(await first.getAttribute("data-art-state"), "loading", "slow cover is still loading");
  assert.ok(await first.locator(".tp-art__title").isVisible(), "a loading cover shows the typeset title, not an empty frame");
  assert.equal(await first.locator(".tp-art__note").count(), 0, "no false 'no cover' caption while loading");
  assert.equal(await second.getAttribute("data-art-state"), "none", "a broken cover falls back");
  assert.match(await second.locator(".tp-art__note").textContent(), /No cover from Qloo/);
  await shot("15-cover-loading", false);
  releaseSlow();
  await page.waitForFunction(() => document.querySelector(".tp-shelf__item .tp-art")?.getAttribute("data-art-state") === "loaded");
  assert.ok(await first.locator("img").evaluate((i) => i.complete && i.naturalWidth > 0), "the cover appears once its host answers");
  passed.push(`${width}: slow/broken cover handling`);
  await s.close();
}

{
  // capability load failure -> nothing offered -> retry
  let fail = true;
  const s = await open(375, {
    before: (page, state) => {
      state.induced = true;
      return page.route("**/api/health", (r) => (fail ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: "x" }, meta: { requestId: "r", mode: "mock" } }) }) : r.continue()));
    },
  });
  const { page, shot } = s;
  await page.waitForSelector(".tp-step__status--error");
  assert.equal(await page.locator(".tp-world").count(), 0, "no destinations invented when capabilities fail");
  await shot("20-capabilities-error", false);
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForSelector(".tp-world");
  passed.push("375: capability failure + retry");
  await s.close();
}
{
  // 429 on search: message, no automatic re-request
  const s = await open(375);
  const { page, shot, requests, state } = s;
  state.induced = true;
  await page.route("**/api/entities/search**", (r) =>
    r.fulfill({ status: 429, contentType: "application/json", headers: { "retry-after": "60" }, body: JSON.stringify({ ok: false, error: { code: "RATE_LIMITED", message: "slow down" }, meta: { requestId: "rate0001", mode: "mock" } }) }),
  );
  await chooseWorld(page, "Books");
  await chooseSource(page, "a movie");
  await page.fill("#tp-anchor", "Interstellar");
  await page.press("#tp-anchor", "Enter");
  await page.waitForSelector(".tp-error");
  assert.match(await page.textContent(".tp-error"), /Too many requests/);
  await page.waitForTimeout(1500);
  assert.equal(requests.search.length, 1, "a 429 is never retried automatically");
  await shot("21-rate-limited", false);
  passed.push("375: 429 without auto-retry");
  await s.close();
}
{
  // stale revision on answer -> restart recovery
  const s = await open(1440);
  const { page, shot, state } = s;
  await chooseWorld(page, "Books");
  await chooseSource(page, "a movie");
  await searchAndSelect(page, "Interstellar", "Interstellar");
  await begin(page);
  state.induced = true;
  await page.route("**/api/discovery/answer", (r) =>
    r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "SESSION_REVISION_CONFLICT", message: "stale" }, meta: { requestId: "conf0001", mode: "mock" } }) }),
  );
  await page.getByRole("button", { name: "Yes, more of this" }).click();
  await page.waitForSelector(".tp-error");
  assert.match(await page.textContent(".tp-error"), /moved on/);
  assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0, "a conflict is not blindly retried");
  await shot("22-session-conflict", false);
  await page.getByRole("button", { name: "Start again" }).click();
  await page.waitForSelector("#tp-anchor");
  passed.push("1440: session conflict → start again");
  await s.close();
}
{
  // the server refuses a pair the UI never offers (the two 400s are expected)
  const s = await open(375);
  s.state.induced = true;
  const res = await s.page.evaluate(() =>
    fetch("/api/discovery/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entityQuery: "Interstellar", sourceType: "movie", targetType: "movie", maxQuestions: 3, selectedEntityId: "mock:movie:interstellar" }) }).then(async (r) => ({ status: r.status, code: (await r.json()).error?.code })),
  );
  assert.deepEqual(res, { status: 400, code: "UNSUPPORTED_DOMAIN" }, "same-domain pair refused");
  const res2 = await s.page.evaluate(() =>
    fetch("/api/discovery/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entityQuery: "Interstellar", sourceType: "movie", targetType: "podcast", maxQuestions: 3, selectedEntityId: "mock:movie:interstellar" }) }).then(async (r) => ({ status: r.status, code: (await r.json()).error?.code })),
  );
  assert.deepEqual(res2, { status: 400, code: "UNSUPPORTED_DOMAIN" });
  passed.push("server: unsupported pairs refused");
  await s.close();
}

await browser.close();
await writeFile(resolve(out, "qa-report.json"), JSON.stringify({ passed, report, a11y }, null, 2));

const severe = a11y.flatMap((a) => a.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ ...v, width: a.width, label: a.label })));
for (const a of a11y) {
  const summary = a.violations.map((v) => `${v.id}(${v.impact},${v.nodes})`).join(" ") || "no violations";
  console.log(`axe ${a.width} ${a.label}: ${summary}`);
}
const problems = [...report.filter((r) => r.overflow || r.broken?.length || r.errors?.length), ...severe];
for (const r of report.filter((r) => r.label)) {
  const flags = [r.overflow && `OVERFLOW ${r.offenders.join(",")}`, r.broken.length && `BROKEN ${r.broken.length}`, r.smallTargets.length && `small:${r.smallTargets.join("|")}`].filter(Boolean);
  if (flags.length) console.log(`${r.width} ${r.label}: ${flags.join(" ; ")}`);
}
for (const r of report.filter((r) => r.errors?.length)) console.log(`${r.width} console/page errors: ${r.errors.join(" | ")}`);
for (const p of passed) console.log(`PASS ${p}`);
console.log(`UI QA: ${passed.length} journeys passed, ${problems.length} problem(s) (hygiene + serious/critical axe). Screenshots: ${out}`);
process.exitCode = problems.length ? 1 : 0;
