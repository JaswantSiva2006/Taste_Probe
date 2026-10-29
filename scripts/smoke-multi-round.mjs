#!/usr/bin/env node
/**
 * npm run smoke:multi-round — S9.6 offline HTTP smoke over the REAL routes.
 * Starts `next dev` in QLOO_MODE=mock (synthetic fixtures; provider keys blanked)
 * and drives one exploration through three rounds:
 *   start → answer → finish R1 → reject → continue → answer → finish R2 → reject
 *   → continue → (answer) → finish R3 → accept
 * Verifies one exploration identity, monotonic rounds and revisions, cumulative
 * preferences and question history, no repeated questions, no rejected START HERE,
 * replay rejection and the final accepted state. Never prints tokens.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";

const require = createRequire(import.meta.url);
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--port", String(port), "--hostname", "127.0.0.1"], {
  env: { ...process.env, QLOO_MODE: "mock", QLOO_API_KEY: "", GOOGLE_API_KEY: "", NODE_ENV: "development", SESSION_STORE: "memory", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
  detached: process.platform !== "win32",
});
const stop = () => {
  if (server.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
};

const step = (msg) => console.log(`  [ok] ${msg}`);
async function call(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
async function ok(path, body) {
  const r = await call(path, body);
  assert.equal(r.status, 200, `${path}: ${r.status} ${r.json.error?.code}`);
  assert.equal(r.json.meta.mode, "mock");
  return r.json.data;
}

const asked = [];
async function round(view, responses) {
  let v = view;
  for (const want of responses) {
    if (v.status !== "asking") break;
    asked.push(v.currentQuestion.questionId);
    const response = v.currentQuestion.allowedResponses.includes(want) ? want : "unknown";
    const before = v.revision;
    v = await ok("/api/discovery/answer", { sessionToken: v.sessionToken, questionId: v.currentQuestion.questionId, response });
    assert.equal(v.revision, before + 1);
  }
  if (v.status === "asking") {
    asked.push(v.currentQuestion.questionId);
    const before = v.revision;
    v = await ok("/api/discovery/finish", { sessionToken: v.sessionToken });
    assert.equal(v.revision, before + 1);
  }
  assert.equal(v.status, "finished");
  return v;
}
const lead = (v) => v.discoveryPath.featured[0].recommendationEntityId;

try {
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("mock server did not start");
    if (server.exitCode !== null) throw new Error(`mock server exited (${server.exitCode})`);
    try {
      const h = await fetch(`${base}/api/health`).then((r) => r.json());
      if (h.data?.mode === "mock") break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(`smoke:multi-round against ${base} (next dev, QLOO_MODE=mock)`);

  const v0 = await ok("/api/discovery/start", { entityQuery: "Interstellar", sourceType: "movie", targetType: "book", maxQuestions: 3, selectedEntityId: "mock:movie:interstellar" });
  const id = v0.exploration.explorationId;
  assert.equal(v0.exploration.round, 1);
  step(`start: exploration ${id.slice(0, 8)}…, round 1, revision 0, question "${v0.currentQuestion.text}"`);

  const f1 = await round(v0, ["like", "dislike", "unknown"]);
  const prefs1 = f1.preferences;
  step(`round 1 finished at revision ${f1.revision}: liked ${prefs1.positiveTagIds.length} tag, passed ${prefs1.rejectedTagIds.length}; START HERE ${lead(f1)}`);
  const s1 = lead(f1);
  const r1 = await ok("/api/discovery/reject", { sessionToken: f1.sessionToken, entityId: s1 });
  assert.deepEqual(r1.exploration.rejectedRecommendationIds, [s1]);
  assert.deepEqual(r1.preferences.rejectedTagIds, prefs1.rejectedTagIds, "an item rejection must not reject tags");
  step(`rejected ${s1}; new START HERE ${lead(r1)}`);

  const c2 = await ok("/api/discovery/continue", { sessionToken: r1.sessionToken });
  assert.equal(c2.exploration.explorationId, id);
  assert.equal(c2.exploration.round, 2);
  assert.deepEqual(c2.preferences.positiveTagIds, prefs1.positiveTagIds);
  assert.ok(!asked.includes(c2.currentQuestion.questionId), "round 2 repeated a question");
  step(`continue → round 2 (revision ${c2.revision}), new question "${c2.currentQuestion.text}"`);
  const replay = await call("/api/discovery/continue", { sessionToken: r1.sessionToken });
  assert.equal(replay.status, 409);
  step(`replayed continue rejected (409 ${replay.json.error.code})`);

  const f2 = await round(c2, ["like", "unknown", "dislike"]);
  const s2 = lead(f2);
  assert.notEqual(s2, s1, "a rejected item returned as START HERE");
  const r2 = await ok("/api/discovery/reject", { sessionToken: f2.sessionToken, entityId: s2 });
  step(`round 2 finished; rejected ${s2}`);

  const c3 = await ok("/api/discovery/continue", { sessionToken: r2.sessionToken });
  assert.equal(c3.exploration.round, 3);
  const f3 = await round(c3, ["like", "like", "like"]);
  const featured = f3.discoveryPath.featured.map((f) => f.recommendationEntityId);
  assert.ok(!featured.includes(s1) && !featured.includes(s2), "rejected items featured again");
  assert.equal(new Set(asked).size, asked.length, "a question was repeated across rounds");
  const done = await ok("/api/discovery/accept", { sessionToken: f3.sessionToken, entityId: lead(f3) });
  assert.equal(done.exploration.status, "accepted");
  assert.equal(done.exploration.acceptedEntityId, lead(f3));
  assert.equal(done.exploration.explorationId, id);
  step(`round 3 finished; accepted ${lead(f3)} at revision ${done.revision}`);

  const again = await call("/api/discovery/accept", { sessionToken: f3.sessionToken, entityId: lead(f3) });
  assert.equal(again.status, 409);
  const closed = await call("/api/discovery/continue", { sessionToken: done.sessionToken });
  assert.equal(closed.json.error.code, "EXPLORATION_CLOSED");
  step(`replayed accept → 409 ${again.json.error.code}; continue after accept → 409 ${closed.json.error.code}`);
  step(`questions asked across 3 rounds: ${asked.length} (all distinct); rejected: ${done.exploration.rejectedRecommendationIds.length}; Qloo calls ${done.usage.qlooCallCount}/${done.usage.maxQlooCalls}`);
  console.log("MULTI-ROUND SMOKE PASSED");
} catch (error) {
  console.error(`MULTI-ROUND SMOKE FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  stop();
}
