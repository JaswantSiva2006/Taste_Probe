/**
 * Shared Playwright steps for the TasteProbe browser QA (mock `ui-qa.mjs` and
 * live `qa-live.mjs`). Both drive the same real UI the same way; only the
 * server behind it differs.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Layout hygiene for the current page: overflow, broken images, tiny targets, h1 count. */
export async function hygiene(page, label) {
  return page.evaluate((label) => {
    const vw = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth > vw + 1;
    const offenders = [...document.querySelectorAll("body *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return s.display !== "none" && r.width > 0 && (r.right > vw + 2 || r.left < -2) && s.position !== "fixed" && !el.closest(".tp-sr");
      })
      .slice(0, 6)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
    const broken = [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src);
    const smallTargets = [...document.querySelectorAll("button, a, input:not([type=radio]), summary, label.ah-input")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24);
      })
      .map((el) => (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 30));
    return { label, overflow, offenders, broken, smallTargets, h1: document.querySelectorAll("h1").length };
  }, label);
}

/**
 * axe-core (WCAG 2.0/2.1/2.2 A+AA rules) on the current page. Returns violations
 * as {id, impact, nodes}. An automated pass is not a compliance claim.
 */
export async function axeScan(page) {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  return page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(" ") ?? "" }));
  });
}

/** S9.15: music is the only destination, so there is no destination picker to operate. */
export async function expectNoDestinationPicker(page) {
  assert.equal(await page.locator('input[name="tp-target"]').count(), 0, "no destination choice is offered");
}

/** Chooses a starting point ("Movies", "Artists", "TV shows", "Games", "Podcasts"). */
const LEGACY_LABELS = { "a movie": "Movies", "a music artist": "Artists", "a TV show": "TV shows", "a video game": "Games", "a podcast": "Podcasts" };

export async function chooseSource(page, given, viaKeyboard = false) {
  const label = LEGACY_LABELS[given] ?? given;
  const radio = page.getByRole("radio", { name: new RegExp(`^${label}\\b`) });
  if (!(await radio.isChecked())) {
    if (viaKeyboard) {
      await radio.focus();
      await page.keyboard.press("Space");
    } else {
      await page.locator(".ah-input", { hasText: label }).click();
    }
  }
  assert.equal(await radio.isChecked(), true, `${label} chosen as starting point`);
  await page.waitForSelector("#tp-anchor:not([disabled])");
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Searches, asserts nothing is auto-selected, then explicitly selects the first exact-name result. */
export async function searchAndSelect(page, query, exactName, { viaKeyboard = false, timeout = 30_000 } = {}) {
  await page.fill("#tp-anchor", query);
  await page.press("#tp-anchor", "Enter");
  await page.waitForSelector(".ah-result, .ah-results__empty, .tp-error", { timeout });
  if (await page.locator(".tp-error").count()) throw new Error(`search failed in the UI: ${await page.textContent(".tp-error")}`);
  assert.ok(await page.locator(".ah-result").count(), `no results for "${query}"`);
  assert.equal(await page.locator('.ah-result[aria-pressed="true"]').count(), 0, "a search never auto-selects");
  assert.ok(await page.getByRole("button", { name: /^Choose one to continue|^Discover music from/ }).isDisabled(), "cannot start before an explicit selection");
  const exact = page
    .locator(".ah-result")
    .filter({ has: page.locator(".ah-result__title", { hasText: new RegExp(`^${escapeRe(exactName)}$`) }) })
    .first();
  if (viaKeyboard) {
    await exact.focus();
    await page.keyboard.press("Space");
  } else {
    await exact.click();
  }
  assert.equal(await exact.getAttribute("aria-pressed"), "true");
  return { results: await page.locator(".ah-result").count() };
}

export async function begin(page, { timeout = 30_000 } = {}) {
  await page.getByRole("button", { name: /^Discover music from/ }).click();
  await page.waitForSelector("#tp-question, #tp-programme-title, .tp-error", { timeout });
  if (await page.locator(".tp-error").count()) throw new Error(`start failed in the UI: ${await page.textContent(".tp-error")}`);
}

/** S9.15 compatibility for older (live, opt-in) scripts: there is no destination step any more. */
export async function chooseWorld(page) {
  await expectNoDestinationPicker(page);
}
