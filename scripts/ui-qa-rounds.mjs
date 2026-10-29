#!/usr/bin/env node
/**
 * S9.7 multi-round browser QA: the REAL UI over the REAL routes on a mock server
 * (synthetic fixtures, no paid providers). Run by `npm run qa`, or directly:
 *   node scripts/ui-qa-rounds.mjs --url http://127.0.0.1:3000
 *
 * Main journey (375 and 1440):
 *   R1 search → start → answer → finish → Not for me
 *   R2 Keep exploring → answer → finish → Not for me
 *   R3 Keep exploring → answer → finish → I'll try this
 * plus: continue without rejection, candidate exhaustion (real), budget exhaustion,
 * expiry, network failure, 409 conflict, double-click, cross-domain rounds,
 * 320px overflow and axe on the new screens.
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
const out = resolve(arg("--out", ".artifacts/ui-rounds"));
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const report = [];
const a11y = [];
const passed = [];
const MUTATIONS = /\/api\/discovery\/(start|answer|finish|reject|accept|continue)$/;

async function open(width, before) {
  const context = await browser.newContext({ viewport: { width, height: width >= 1024 ? 900 : 812 } });
  const page = await context.newPage();
  const errors = [];
  const state = { induced: false };
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => m.type() === "error" && !(state.induced && /ERR_FAILED|status of (401|409|429)/.test(m.text())) && errors.push(m.text()));
  /** Every discovery mutation, in order: route, request token, response data. */
  const log = [];
  page.on("request", (r) => {
    if (MUTATIONS.test(new URL(r.url()).pathname)) log.push({ route: new URL(r.url()).pathname.split("/").pop(), body: JSON.parse(r.postData() ?? "{}"), res: null });
  });
  page.on("response", async (r) => {
    if (!MUTATIONS.test(new URL(r.url()).pathname)) return;
    const entry = [...log].reverse().find((e) => e.res === null && e.route === new URL(r.url()).pathname.split("/").pop());
    try {
      if (entry) entry.res = { status: r.status(), json: await r.json() };
    } catch {
      if (entry) entry.res = { status: r.status(), json: null };
    }
  });
  if (before) await before(page, state);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const shot = async (name, full = true) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(out, `${width}-${name}.png`), fullPage: full });
    report.push({ width, ...(await hygiene(page, name)) });
  };
  const settled = async () => {
    for (let i = 0; i < 100 && log.some((e) => e.res === null); i += 1) await page.waitForTimeout(50);
  };
  const close = async () => {
    report.push({ width, errors });
    await context.close();
  };
  return { page, shot, close, log, state, settled, errors };
}

const leadTitle = async (page) => (await page.locator(".tp-start .tp-card__title").textContent()).trim();
const featuredTitles = async (page) => (await page.locator(".tp-start .tp-card__title, .tp-path .tp-card__title").allTextContents()).map((t) => t.trim());

async function answerAny(page, prefer = "Yes, more of this") {
  const before = await page.textContent("#tp-question");
  const btn = page.getByRole("button", { name: prefer });
  await ((await btn.count()) ? btn : page.locator(".tp-answer").first()).click();
  await page.waitForFunction((prev) => {
    const q = document.querySelector("#tp-question")?.textContent;
    return document.querySelector("#tp-programme-title") || (q && q !== prev);
  }, before);
}

async function finishRound(page) {
  if (await page.locator("#tp-programme-title").count()) return;
  await page.getByRole("button", { name: "Show my way in" }).click();
  await page.waitForSelector("#tp-programme-title");
}

async function rejectLead(page) {
  const title = await leadTitle(page);
  await page.getByRole("button", { name: `Not for me: ${title}` }).click();
  await page.waitForFunction((t) => document.querySelector(".tp-start .tp-card__title")?.textContent?.trim() !== t, title);
  return title;
}

async function keepExploring(page) {
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/api/discovery/continue"),
    page.getByRole("button", { name: "Keep exploring" }).click(),
  ]);
  await page.waitForSelector("#tp-question, #tp-programme-title, .tp-error");
  await page.waitForTimeout(150);
  if (await page.locator(".tp-error").count()) throw new Error(`continue failed: ${await page.textContent(".tp-error")}`);
}

async function startJourney(page, world, source, query, exact) {
  await chooseWorld(page, world);
  await chooseSource(page, source);
  await searchAndSelect(page, query, exact);
  await begin(page);
}

/** Every mutation after start must carry the token returned by the previous successful mutation. */
function assertTokenChain(log) {
  let token = null;
  for (const e of log) {
    if (e.route !== "start") assert.equal(e.body.sessionToken, token, `${e.route} did not use the latest token`);
    if (e.res?.status === 200) token = e.res.json.data.sessionToken;
  }
}

// ---------------------------------------------------------------- main three-round journey

for (const width of [375, 1440]) {
  const s = await open(width);
  const { page, shot, log, settled } = s;
  await startJourney(page, "Books", "a movie", "Interstellar", "Interstellar");
  const questions = [await page.textContent("#tp-question")];
  assert.match(await page.textContent(".tp-round-pill"), /Round 1/);

  // ---- round 1
  await answerAny(page, "Yes, more of this");
  if (await page.locator("#tp-question").count()) questions.push(await page.textContent("#tp-question"));
  await finishRound(page);
  assert.match(await page.textContent(".tp-programme__kicker"), /Round 1/);
  const liked = (await page.locator(".tp-note--liked").allTextContents()).map((t) => t.trim());
  assert.equal(liked.length, 1, "round-1 like is shown");
  await shot("r1-way-in");
  const r1 = await rejectLead(page);
  await settled();
  assert.ok(!(await featuredTitles(page)).includes(r1), "rejected pick no longer featured");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "tp-start-label", "focus moves to the replacement START HERE");
  assert.ok((await page.locator(".tp-note--setaside").allTextContents()).some((t) => t.includes(r1)), "set-aside pick listed");
  await shot("r1-after-reject");

  // ---- round 2
  await keepExploring(page);
  await settled();
  assert.match(await page.textContent(".tp-round-pill"), /Round 2/);
  assert.match(await page.getByRole("img", { name: /Round 2, question 1 of up to 3/ }).getAttribute("aria-label"), /Round 2/);
  const q2 = await page.textContent("#tp-question");
  assert.ok(!questions.includes(q2), "round 2 opened with a new question");
  questions.push(q2);
  assert.deepEqual((await page.locator(".tp-note--liked").allTextContents()).map((t) => t.trim()), liked, "earlier likes stay visible");
  assert.equal(await page.locator(".tp-notice").count(), 0, "no stale update notice at the start of a round");
  await shot("r2-question");
  await answerAny(page, "Not for me");
  if (await page.locator("#tp-question").count()) {
    const q = await page.textContent("#tp-question");
    assert.ok(!questions.includes(q), "no repeated question");
    questions.push(q);
  }
  await finishRound(page);
  assert.match(await page.textContent(".tp-programme__kicker"), /Round 2/);
  assert.ok(!(await featuredTitles(page)).includes(r1), "round-1 rejection still suppressed");
  const r2 = await rejectLead(page);
  await settled();

  // ---- round 3
  await keepExploring(page);
  await settled();
  assert.match(await page.textContent(".tp-round-pill"), /Round 3/);
  if (await page.locator("#tp-question").count()) {
    const q3 = await page.textContent("#tp-question");
    assert.ok(!questions.includes(q3), "round 3 question is new");
    questions.push(q3);
    await answerAny(page, "Yes, more of this");
  }
  await finishRound(page);
  const featured3 = await featuredTitles(page);
  assert.ok(!featured3.includes(r1) && !featured3.includes(r2), "both rejected picks suppressed in round 3");
  await page.locator(".tp-history summary").click();
  const rounds = await page.locator(".tp-history__round").allTextContents();
  assert.ok(rounds.includes("Round 1") && rounds.includes("Round 2"), "answer history spans rounds");
  await shot("r3-way-in");
  a11y.push({ width, label: "round-3 way in (history open)", violations: await axeScan(page) });
  const choice = await leadTitle(page);
  await page.getByRole("button", { name: `I’ll try this: ${choice}` }).click();
  await page.waitForSelector(".tp-programme--accepted");
  await settled();
  assert.match(await page.textContent("#tp-programme-title"), /You’ll start with/);
  assert.match(await page.textContent(".tp-programme__sub"), /over 3 rounds/);
  assert.equal(await page.getByRole("button", { name: "Keep exploring" }).count(), 0);
  await shot("accepted");
  a11y.push({ width, label: "accepted", violations: await axeScan(page) });

  // ---- identity, revisions, tokens, replay
  const views = log.filter((e) => e.res?.status === 200).map((e) => e.res.json.data);
  assert.equal(new Set(views.map((v) => v.exploration.explorationId)).size, 1, "one exploration identity");
  const revisions = views.map((v) => v.revision);
  assert.deepEqual(revisions, revisions.map((_, i) => i), "every transition advanced exactly one revision");
  assert.deepEqual([...new Set(views.map((v) => v.exploration.round))], [1, 2, 3], "rounds 1 → 2 → 3, never back to 1");
  assertTokenChain(log);
  const finale3 = views.at(-2);
  const final = views.at(-1);
  assert.equal(final.exploration.status, "accepted");
  s.state.induced = true; // the deliberate replay below logs one expected 409
  const replay = await page.evaluate(
    async ([token, entityId]) => (await fetch("/api/discovery/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionToken: token, entityId }) })).status,
    [finale3.sessionToken, final.exploration.acceptedEntityId],
  );
  assert.equal(replay, 409, "a replayed accept is refused");
  passed.push(`${width}: three-round journey (reject, reject, accept) — ${questions.length} distinct questions`);
  await s.close();
}

// ---------------------------------------------------------------- variations

for (const width of [320, 375, 1440]) {
  // continue without rejecting anything; 320 is the overflow check for the new screens
  const s = await open(width);
  const { page, shot, settled } = s;
  await startJourney(page, "Books", "a movie", "Interstellar", "Interstellar");
  await finishRound(page);
  await shot("plain-way-in");
  await keepExploring(page);
  await settled();
  assert.match(await page.textContent(".tp-round-pill"), /Round 2/);
  assert.equal(await page.locator(".tp-note--setaside").count(), 0, "continuing rejects nothing");
  await shot("plain-round-2");
  passed.push(`${width}: continue without rejection`);
  await s.close();
}

{
  // real exhaustion: keep setting aside and continuing until the server says nothing new is left
  const s = await open(1440);
  const { page, shot, settled } = s;
  await startJourney(page, "Books", "a movie", "Interstellar", "Interstellar");
  await finishRound(page);
  let rounds = 1;
  while (rounds < 10 && !(await page.getByRole("button", { name: "Keep exploring" }).isDisabled())) {
    await rejectLead(page);
    await settled();
    if (await page.getByRole("button", { name: "Keep exploring" }).isDisabled()) break;
    await keepExploring(page);
    await settled();
    rounds += 1;
    while (await page.locator("#tp-question").count()) await answerAny(page, "Not sure");
    await finishRound(page);
  }
  assert.ok(await page.getByRole("button", { name: "Keep exploring" }).isDisabled(), "continuation ends truthfully");
  assert.match(await page.textContent(".tp-continue__body--blocked"), /seen or turned down every verified book/);
  assert.ok(await page.locator(".tp-start").count(), "remaining picks stay on screen");
  assert.ok(await page.locator(".tp-programme .tp-art__board").count(), "missing artwork uses the captioned fallback");
  await shot("exhausted");
  a11y.push({ width: 1440, label: "exhausted", violations: await axeScan(page) });
  passed.push(`1440: real candidate exhaustion after ${rounds} rounds`);
  await s.close();
}

{
  // budget exhaustion: the server's own flag disables continue; a race (429) keeps the results
  const s = await open(375, async (page, state) => {
    state.induced = true;
    await page.route("**/api/discovery/finish", async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      json.data.exploration = { ...json.data.exploration, canContinue: false, continueBlockedReason: "budget_exhausted" };
      await route.fulfill({ response: res, json });
    });
  });
  const { page, shot } = s;
  await startJourney(page, "Books", "a movie", "Interstellar", "Interstellar");
  await finishRound(page);
  assert.ok(await page.getByRole("button", { name: "Keep exploring" }).isDisabled());
  assert.match(await page.textContent(".tp-continue__body--blocked"), /used its question allowance/);
  await shot("budget-exhausted", false);
  passed.push("375: budget-exhausted state");
  await s.close();
}
{
  const s = await open(1440, async (page, state) => {
    state.induced = true;
    await page.route("**/api/discovery/continue", (r) =>
      r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "EXPLORATION_BUDGET_EXHAUSTED", message: "x" }, meta: { requestId: "budget01", mode: "mock" } }) }),
    );
  });
  const { page, log } = s;
  await startJourney(page, "Books", "a movie", "Interstellar", "Interstellar");
  await finishRound(page);
  await page.getByRole("button", { name: "Keep exploring" }).click();
  await page.waitForSelector(".tp-error");
  assert.match(await page.textContent(".tp-error"), /used its allowance/);
  assert.ok(await page.locator(".tp-start").count(), "results stay after a refused continue");
  await page.waitForTimeout(1200);
  assert.equal(log.filter((e) => e.route === "continue").length, 1, "never retried automatically");
  passed.push("1440: 429 on continue keeps results, no auto-retry");
  await s.close();
}
{
  // expiry: truthful message, no silent fresh exploration
  const s = await open(375, async (page, state) => {
    state.induced = true;
    await page.route("**/api/discovery/continue", (r) =>
      r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "SESSION_EXPIRED", message: "x" }, meta: { requestId: "exp00001", mode: "mock" } }) }),
    );
  });
  const { page, shot, log } = s;
  await startJourney(page, "Books", "a movie", "Interstellar", "Interstellar");
  await finishRound(page);
  await page.getByRole("button", { name: "Keep exploring" }).click();
  await page.waitForSelector(".tp-error");
  assert.match(await page.textContent(".tp-error"), /expired/);
  assert.ok(await page.locator("#tp-programme-title").count(), "no silent restart");
  assert.equal(log.filter((e) => e.route === "start").length, 1, "no new exploration was created");
  await shot("expired", false);
  passed.push("375: expired exploration");
  await s.close();
}
{
  // network failure on reject → manual Try again with the same token succeeds once
  let failOnce = true;
  const s = await open(1440, async (page, state) => {
    state.induced = true;
    await page.route("**/api/discovery/reject", (r) => (failOnce ? ((failOnce = false), r.abort("failed")) : r.continue()));
  });
  const { page, log, settled } = s;
  await startJourney(page, "Books", "a movie", "Interstellar", "Interstellar");
  await finishRound(page);
  const title = await leadTitle(page);
  await page.getByRole("button", { name: `Not for me: ${title}` }).click();
  await page.waitForSelector(".tp-error");
  await page.waitForTimeout(800);
  assert.equal(log.filter((e) => e.route === "reject").length, 1, "no automatic retry");
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForFunction((t) => document.querySelector(".tp-start .tp-card__title")?.textContent?.trim() !== t, title);
  await settled();
  const rejects = log.filter((e) => e.route === "reject");
  assert.equal(rejects.length, 2);
  assert.equal(rejects[0].body.sessionToken, rejects[1].body.sessionToken, "the retry reuses the same token (server CAS guards duplicates)");
  passed.push("1440: network failure → manual retry");
  await s.close();
}
{
  // 409 on accept → conflict explained, never retried
  const s = await open(375, async (page, state) => {
    state.induced = true;
    await page.route("**/api/discovery/accept", (r) =>
      r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "SESSION_REVISION_CONFLICT", message: "x" }, meta: { requestId: "conf0002", mode: "mock" } }) }),
    );
  });
  const { page } = s;
  await startJourney(page, "Books", "a movie", "Interstellar", "Interstellar");
  await finishRound(page);
  await page.getByRole("button", { name: `I’ll try this: ${await leadTitle(page)}` }).click();
  await page.waitForSelector(".tp-error");
  assert.match(await page.textContent(".tp-error"), /moved on/);
  assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0, "a conflict offers no blind retry");
  passed.push("375: 409 on accept");
  await s.close();
}
{
  // double-click on "Not for me" sends exactly one request
  const s = await open(1440, async (page) => {
    await page.route("**/api/discovery/reject", async (r) => {
      await new Promise((res) => setTimeout(res, 400)); // keep the first request in flight
      await r.continue();
    });
  });
  const { page, log, settled } = s;
  await startJourney(page, "Books", "a movie", "Interstellar", "Interstellar");
  await finishRound(page);
  await page.getByRole("button", { name: `Not for me: ${await leadTitle(page)}` }).dblclick();
  await page.waitForTimeout(900);
  await settled();
  assert.equal(log.filter((e) => e.route === "reject").length, 1, "double-click submitted once");
  passed.push("1440: double-click prevention");
  await s.close();
}

// ---------------------------------------------------------------- cross-domain rounds

for (const [label, world, source, query, exact, frame] of [
  ["music_artist→book", "Books", "a music artist", "Glass Harbor", "Glass Harbor (synthetic)", "portrait"],
  ["movie→music_artist", "Music artists", "a movie", "Interstellar", "Interstellar", "square"],
]) {
  for (const width of [375, 1440]) {
    const s = await open(width);
    const { page, shot, settled } = s;
    await startJourney(page, world, source, query, exact);
    await finishRound(page);
    const r1 = await rejectLead(page);
    await settled();
    await keepExploring(page);
    await settled();
    assert.match(await page.textContent(".tp-round-pill"), /Round 2/);
    await finishRound(page);
    assert.ok(!(await featuredTitles(page)).includes(r1));
    assert.ok(await page.locator(`.tp-start .tp-art--${frame}`).count(), `${label} keeps its ${frame} frame`);
    const choice = await leadTitle(page);
    await page.getByRole("button", { name: `I’ll try this: ${choice}` }).click();
    await page.waitForSelector(".tp-programme--accepted");
    if (frame === "square") assert.ok(!/\bbooks?\b/i.test((await page.locator(".tp-programme").innerText()).replace(/“[^”]*”/g, "")), "no book copy for artists");
    await shot(`${label.replace("→", "-to-")}-accepted`);
    passed.push(`${width}: ${label} reject → continue → accept`);
    await s.close();
  }
}

await browser.close();
await writeFile(resolve(out, "qa-rounds-report.json"), JSON.stringify({ passed, report, a11y }, null, 2));
const severe = a11y.flatMap((a) => a.violations.filter((v) => v.impact === "serious" || v.impact === "critical"));
for (const a of a11y) console.log(`axe ${a.width} ${a.label}: ${a.violations.map((v) => `${v.id}(${v.impact},${v.nodes})`).join(" ") || "no violations"}`);
const problems = [...report.filter((r) => r.overflow || r.broken?.length || r.errors?.length), ...severe];
for (const r of report.filter((r) => r.label && (r.overflow || r.broken.length))) console.log(`${r.width} ${r.label}: OVERFLOW ${r.offenders.join(",")} BROKEN ${r.broken.length}`);
for (const r of report.filter((r) => r.errors?.length)) console.log(`${r.width} console/page errors: ${r.errors.join(" | ")}`);
for (const p of passed) console.log(`PASS ${p}`);
console.log(`UI QA (rounds): ${passed.length} checks passed, ${problems.length} problem(s). Screenshots: ${out}`);
process.exitCode = problems.length ? 1 : 0;
