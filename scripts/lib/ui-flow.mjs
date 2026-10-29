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
    const smallTargets = [...document.querySelectorAll("button, a, input:not([type=radio]), summary, label.tp-world, label.tp-chip")]
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

export async function chooseWorld(page, label, viaKeyboard = false) {
  const radio = page.getByRole("radio", { name: new RegExp(`^${label}`) });
  if (viaKeyboard) {
    await radio.focus();
    await page.keyboard.press("Space");
  } else {
    await page.locator(".tp-world", { hasText: label }).click();
  }
  assert.equal(await radio.isChecked(), true, `${label} chosen`);
  await page.waitForSelector(".tp-step--anchor");
}

export async function chooseSource(page, label) {
  const radio = page.getByRole("radio", { name: label, exact: true });
  if (!(await radio.isChecked())) await page.locator(".tp-chip", { hasText: label }).click();
  assert.equal(await radio.isChecked(), true, `${label} chosen as anchor domain`);
  await page.waitForSelector("#tp-anchor");
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Searches, asserts nothing is auto-selected, then explicitly selects the first exact-name result. */
export async function searchAndSelect(page, query, exactName, { viaKeyboard = false, timeout = 30_000 } = {}) {
  await page.fill("#tp-anchor", query);
  await page.press("#tp-anchor", "Enter");
  await page.waitForSelector(".tp-ticket, .tp-results__empty, .tp-error", { timeout });
  if (await page.locator(".tp-error").count()) throw new Error(`search failed in the UI: ${await page.textContent(".tp-error")}`);
  assert.ok(await page.locator(".tp-ticket").count(), `no results for "${query}"`);
  assert.equal(await page.locator('.tp-ticket[aria-pressed="true"]').count(), 0, "a search never auto-selects");
  assert.ok(await page.getByRole("button", { name: /^Pick your|^Begin with/ }).isDisabled(), "cannot start before an explicit selection");
  const exact = page
    .locator(".tp-ticket")
    .filter({ has: page.locator(".tp-ticket__title", { hasText: new RegExp(`^${escapeRe(exactName)}$`) }) })
    .first();
  if (viaKeyboard) {
    await exact.focus();
    await page.keyboard.press("Space");
  } else {
    await exact.click();
  }
  assert.equal(await exact.getAttribute("aria-pressed"), "true");
  return { results: await page.locator(".tp-ticket").count() };
}

export async function begin(page, { timeout = 30_000 } = {}) {
  await page.getByRole("button", { name: /^Begin with/ }).click();
  await page.waitForSelector("#tp-question, #tp-programme-title, .tp-error", { timeout });
  if (await page.locator(".tp-error").count()) throw new Error(`start failed in the UI: ${await page.textContent(".tp-error")}`);
}
