import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as acceptRoute } from "@/app/api/discovery/accept/route";
import { POST as answerRoute } from "@/app/api/discovery/answer/route";
import { POST as continueRoute } from "@/app/api/discovery/continue/route";
import { POST as finishRoute } from "@/app/api/discovery/finish/route";
import { POST as rejectRoute } from "@/app/api/discovery/reject/route";
import { POST as startRoute } from "@/app/api/discovery/start/route";
import { ApiFailureSchema, DiscoveryViewSchema, apiSuccessSchema, type DiscoveryView, type PreferenceResponse } from "@/lib/contracts";
import { deterministicDecision, type AgentResult, type BoundedAgent } from "@/lib/agent/bounded";
import { createDeterministicMockAgent } from "@/lib/agent/mock-agent";
import { discoveryPathProblems } from "@/lib/discovery/path";
import {
  acceptRecommendation,
  answerDiscovery,
  continueExploration,
  finishDiscovery,
  rejectRecommendation,
  startDiscovery,
  type DiscoveryDeps,
} from "@/lib/discovery/service";
import type { QlooProvider } from "@/lib/qloo/provider";
import type { RawInsightEntity } from "@/lib/qloo/raw-types";
import { createMemorySessionStore } from "@/lib/session/memory-store";
import { newTestSecret, testConfig } from "../helpers";

/**
 * S9.6 multi-round exploration through the REAL route handlers (mock providers,
 * memory store; Redis CAS semantics are covered by the store tests and S9.5 live).
 */

const BASE = "http://localhost/api";
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function ok(res: Response): Promise<DiscoveryView> {
  const json = await res.json();
  expect(res.status, JSON.stringify(json.error)).toBe(200);
  return apiSuccessSchema(DiscoveryViewSchema).parse(json).data;
}
async function fail(res: Response, status: number, code: string) {
  const json = ApiFailureSchema.parse(await res.json());
  expect(json.error.code).toBe(code);
  expect(res.status).toBe(status);
  return json;
}

const START = { entityQuery: "Interstellar", sourceType: "movie", targetType: "book", maxQuestions: 3, selectedEntityId: "mock:movie:interstellar" };
const start = async (body: Record<string, unknown> = START) => ok(await startRoute(post("/discovery/start", body)));
const answer = (v: DiscoveryView, response: PreferenceResponse) =>
  answerRoute(post("/discovery/answer", { sessionToken: v.sessionToken, questionId: v.currentQuestion!.questionId, response }));
const finish = (v: DiscoveryView) => finishRoute(post("/discovery/finish", { sessionToken: v.sessionToken }));
const reject = (v: DiscoveryView, entityId: string) => rejectRoute(post("/discovery/reject", { sessionToken: v.sessionToken, entityId }));
const accept = (v: DiscoveryView, entityId: string) => acceptRoute(post("/discovery/accept", { sessionToken: v.sessionToken, entityId }));
const cont = (v: DiscoveryView) => continueRoute(post("/discovery/continue", { sessionToken: v.sessionToken }));

/** Plays one round: answers with the given responses while questions are asked, then finishes. Records every asked question. */
async function playRound(v: DiscoveryView, responses: PreferenceResponse[], asked: DiscoveryView["currentQuestion"][]) {
  let cur = v;
  for (const r of responses) {
    if (cur.status !== "asking") break;
    asked.push(cur.currentQuestion);
    const allowed = cur.currentQuestion!.allowedResponses;
    cur = await ok(await answer(cur, allowed.includes(r) ? r : "unknown"));
  }
  if (cur.status === "asking") {
    asked.push(cur.currentQuestion); // asked but left unanswered when the user ends the round
    cur = await ok(await finish(cur));
  }
  return cur;
}

const startHere = (v: DiscoveryView) => v.discoveryPath!.featured[0]!.recommendationEntityId;
const ids = (v: DiscoveryView) => v.recommendations.map((r) => r.candidate.entityId);

beforeEach(() => {
  vi.stubEnv("QLOO_MODE", "mock");
  vi.stubEnv("SESSION_SIGNING_SECRET", newTestSecret());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("S9.6 Movie → Books across three rounds (route level)", () => {
  it("reject → continue → reject → continue → accept, with cumulative, non-repeating, replay-safe state", async () => {
    const asked: DiscoveryView["currentQuestion"][] = [];
    const v0 = await start();
    expect(v0.exploration).toMatchObject({ round: 1, status: "asking", canContinue: false, continueBlockedReason: "round_in_progress" });
    const explorationId = v0.exploration!.explorationId;
    expect(explorationId).toBe(v0.sessionId);

    // ---- round 1: like, dislike, skip
    const f1 = await playRound(v0, ["like", "dislike", "unknown"], asked);
    expect(f1.status).toBe("finished");
    expect(f1.exploration).toMatchObject({ round: 1, status: "presenting", canContinue: true });
    const prefs1 = f1.preferences;
    expect(prefs1.positiveTagIds.length).toBe(1);
    expect(prefs1.rejectedTagIds.length).toBe(1);
    const s1 = startHere(f1);
    const r1 = await ok(await reject(f1, s1));
    expect(r1.revision).toBe(f1.revision + 1);
    expect(r1.exploration!.rejectedRecommendationIds).toEqual([s1]);
    expect(ids(r1)).not.toContain(s1);
    expect(startHere(r1)).not.toBe(s1);
    // An item rejection is entity-level only: no tag preference changed.
    expect(r1.preferences.positiveTagIds).toEqual(prefs1.positiveTagIds);
    expect(r1.preferences.rejectedTagIds).toEqual(prefs1.rejectedTagIds);
    expect(discoveryPathProblems(r1.discoveryPath!, { ...r1, previouslyPresentedIds: [] })).toEqual([]);
    const shownRound1 = ids(r1);

    // ---- round 2 starts from the stored context, never cold
    const c2 = await ok(await cont(r1));
    expect(c2.revision).toBe(r1.revision + 1);
    expect(c2.exploration).toMatchObject({ explorationId, round: 2, status: "asking" });
    expect(c2.questionCount).toBe(1); // per-round counter restarted
    expect(c2.exploration!.totalQuestionsAsked).toBe(asked.length + 1);
    expect(c2.preferences.positiveTagIds).toEqual(prefs1.positiveTagIds);
    expect(c2.preferences.rejectedTagIds).toEqual(prefs1.rejectedTagIds);
    expect(c2.exploration!.previouslyPresentedIds.sort()).toEqual([...shownRound1].sort());
    const f2 = await playRound(c2, ["like", "unknown", "dislike"], asked);
    expect(f2.exploration).toMatchObject({ round: 2, status: "presenting" });
    expect(f2.lastAnswer?.round ?? 2).toBe(2);
    const s2 = startHere(f2);
    expect(s2).not.toBe(s1);
    // A verified candidate not shown in round 1 leads round 2 when one exists.
    const unseenInRound2 = ids(f2).filter((id) => !shownRound1.includes(id));
    if (unseenInRound2.length) expect(unseenInRound2).toContain(s2);
    expect(f2.preferences.positiveTagIds).toEqual(expect.arrayContaining(prefs1.positiveTagIds));
    expect(f2.preferences.rejectedTagIds).toEqual(expect.arrayContaining(prefs1.rejectedTagIds));
    const r2 = await ok(await reject(f2, s2));
    expect(r2.exploration!.rejectedRecommendationIds.sort()).toEqual([s1, s2].sort());

    // ---- round 3
    const c3 = await ok(await cont(r2));
    expect(c3.exploration).toMatchObject({ explorationId, round: 3 });
    const f3 = await playRound(c3, ["like", "like", "like"], asked);
    expect(f3.exploration!.round).toBe(3);
    const featured3 = f3.discoveryPath!.featured.map((f) => f.recommendationEntityId);
    expect(featured3).not.toContain(s1);
    expect(featured3).not.toContain(s2);
    expect(new Set([...featured3, ...f3.discoveryPath!.remainingEntityIds]).size).toBe(f3.recommendations.length);
    // Later-round paths pass the full grounding validator, including the "shown before" wording.
    for (const f of [f2, f3]) {
      expect(discoveryPathProblems(f.discoveryPath!, { ...f, previouslyPresentedIds: f.exploration!.previouslyPresentedIds })).toEqual([]);
    }
    const lead3 = f3.discoveryPath!.featured[0]!;
    if (f3.exploration!.previouslyPresentedIds.includes(lead3.recommendationEntityId)) {
      expect(lead3.explanation.text).toMatch(/You were shown it in an earlier round/);
    }
    const choice = startHere(f3);
    const done = await ok(await accept(f3, choice));
    expect(done.exploration).toMatchObject({ explorationId, status: "accepted", acceptedEntityId: choice, canContinue: false, continueBlockedReason: "accepted" });
    expect(done.status).toBe("finished"); // legacy view status stays "finished"

    // ---- question history: no repeated ID, tag label or entity pair across rounds
    const qIds = asked.map((q) => q!.questionId);
    expect(new Set(qIds).size).toBe(qIds.length);
    expect(qIds.length).toBeGreaterThanOrEqual(5);
    const tagLabel = (q: NonNullable<DiscoveryView["currentQuestion"]>) => q.text.toLowerCase();
    expect(new Set(asked.map((q) => tagLabel(q!))).size).toBe(asked.length);

    // ---- revisions: every transition advanced exactly one
    expect(done.revision).toBe(f3.revision + 1);

    // ---- replay and closed-exploration protections
    await fail(await accept(f3, choice), 409, "SESSION_REVISION_CONFLICT"); // replayed token
    await fail(await accept(done, choice), 409, "EXPLORATION_CLOSED"); // second accept
    await fail(await reject(done, choice), 409, "EXPLORATION_CLOSED");
    await fail(await cont(done), 409, "EXPLORATION_CLOSED");
    const closedAnswer = await answer({ ...done, currentQuestion: asked[0]! }, "like");
    expect(closedAnswer.status).toBe(409);
    expect(["SESSION_FINISHED", "QUESTION_BUDGET_EXHAUSTED"]).toContain((await closedAnswer.json()).error.code);
    await fail(await cont(r1), 409, "SESSION_REVISION_CONFLICT"); // an old continue cannot fork a round
    // finish stays idempotent on the accepted exploration
    expect((await ok(await finish(done))).exploration!.acceptedEntityId).toBe(choice);

    // ---- budgets: never beyond the configured per-exploration Qloo cap
    expect(done.usage.qlooCallCount).toBeLessThanOrEqual(done.usage.maxQlooCalls);
  });
});

describe("S9.6 feedback semantics and safety", () => {
  it("continue without rejection keeps everything and leads with an unseen pick", async () => {
    const f1 = await playRound(await start(), ["like"], []);
    const c2 = await ok(await cont(f1));
    expect(c2.exploration!.rejectedRecommendationIds).toEqual([]);
    expect(c2.preferences).toEqual(f1.preferences);
    const f2 = await playRound(c2, ["unknown"], []);
    const shown1 = ids(f1);
    const unseen = ids(f2).filter((id) => !shown1.includes(id));
    expect(unseen.length).toBeGreaterThan(0);
    expect(unseen).toContain(startHere(f2));
    expect(f2.discoveryPath!.featured[0]!.explanation.text).toMatch(/haven't been shown yet|highest-ranked result\./);
  });

  it("accept in round 1 ends the exploration", async () => {
    const f1 = await playRound(await start(), [], []);
    const done = await ok(await accept(f1, ids(f1)[2]!));
    expect(done.exploration).toMatchObject({ round: 1, status: "accepted", acceptedEntityId: ids(f1)[2] });
  });

  it("skips stay unknown across rounds", async () => {
    const f1 = await playRound(await start(), ["unknown", "unknown", "unknown"], []);
    const f2 = await playRound(await ok(await cont(f1)), ["unknown"], []);
    expect(f2.preferences).toEqual({ positiveTagIds: [], rejectedTagIds: [], positiveEntityIds: [], rejectedEntityIds: [] });
  });

  it("refuses fabricated, unshown, or mid-round feedback before any change", async () => {
    const v0 = await start();
    await fail(await reject(v0, ids(v0)[0]!), 409, "ROUND_IN_PROGRESS");
    await fail(await cont(v0), 409, "ROUND_IN_PROGRESS");
    const f1 = await playRound(v0, [], []);
    await fail(await reject(f1, "mock:book:invented"), 400, "INVALID_RECOMMENDATION");
    await fail(await accept(f1, "B6FA456F-0000-0000-0000-000000000000"), 400, "INVALID_RECOMMENDATION");
    // A real candidate that is NOT in the shown results cannot be chosen either.
    const all = (await ok(await finish(f1))).recommendations.length;
    expect(all).toBe(5);
    await fail(await accept(f1, "mock:book:zeta"), 400, "INVALID_RECOMMENDATION");
    await fail(await rejectRoute(post("/discovery/reject", { sessionToken: f1.sessionToken, entityId: ids(f1)[0], history: [] })), 400, "VALIDATION_ERROR");
    // State untouched: the same token still works.
    expect((await ok(await reject(f1, ids(f1)[0]!))).revision).toBe(f1.revision + 1);
  });

  it("two simultaneous continues create exactly one next round", async () => {
    const f1 = await playRound(await start(), ["like"], []);
    const res = await Promise.all([cont(f1), cont(f1)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = await ok(res.find((r) => r.status === 200)!);
    expect(winner.exploration!.round).toBe(2);
    await fail(await cont(f1), 409, "SESSION_REVISION_CONFLICT");
  });

  it("simultaneous accept and reject: exactly one transition wins", async () => {
    const f1 = await playRound(await start(), [], []);
    const res = await Promise.all([accept(f1, ids(f1)[0]!), reject(f1, ids(f1)[1]!)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("continuing until the pool and questions run out returns a typed exhausted state and keeps context", async () => {
    let v = await playRound(await start(), ["like"], []);
    let rounds = 1;
    for (; rounds < 12; rounds += 1) {
      const res = await cont(v);
      if (res.status !== 200) {
        await fail(res, 409, "EXPLORATION_EXHAUSTED");
        break;
      }
      v = await playRound(await ok(res), ["unknown", "unknown", "unknown"], []);
      if (v.exploration!.canContinue) v = await ok(await reject(v, startHere(v)));
    }
    expect(rounds).toBeLessThan(12);
    expect(v.exploration!.canContinue).toBe(false);
    expect(v.exploration!.continueBlockedReason).toBe("candidates_exhausted");
    // Context preserved and still readable with the current token.
    const again = await ok(await finish(v));
    expect(again.revision).toBe(v.revision);
    expect(again.exploration!.rejectedRecommendationIds).toEqual(v.exploration!.rejectedRecommendationIds);
  });

  it("an expired exploration cannot be continued", async () => {
    const f1 = await playRound(await start(), [], []);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    await fail(await cont(f1), 401, "SESSION_EXPIRED");
  });

  it("the legacy one-round client still works unchanged", async () => {
    const v0 = await start();
    const v1 = await ok(await answer(v0, "like"));
    const done = await ok(await finish(v1));
    expect([v0.revision, v1.revision, done.revision]).toEqual([0, 1, 2]);
    expect(done.status).toBe("finished");
    expect(done.discoveryPath!.featured[0]!.recommendationEntityId).toBe(done.recommendations[0]!.candidate.entityId);
    await fail(await answer({ ...done, currentQuestion: v1.currentQuestion ?? v0.currentQuestion }, "like"), 409, "SESSION_FINISHED");
  });
});

describe("S9.6 cross-domain continuation (fixtures)", () => {
  it.each([
    ["music_artist → book", { entityQuery: "Glass Harbor (synthetic)", sourceType: "music_artist", targetType: "book", maxQuestions: 3, selectedEntityId: "mock:music_artist:glass-harbor" }, "book"],
    ["movie → music_artist", { ...START, targetType: "music_artist" }, "music_artist"],
  ])("%s: reject → continue keeps context and stays in the target domain", async (_label, body, target) => {
    const f1 = await playRound(await start(body), ["like"], []);
    const r1 = await ok(await reject(f1, startHere(f1)));
    const c2 = await ok(await cont(r1));
    expect(c2.exploration!.round).toBe(2);
    expect(c2.preferences.positiveTagIds).toEqual(f1.preferences.positiveTagIds);
    const f2 = await playRound(c2, ["unknown"], []);
    expect(f2.recommendations.every((r) => r.candidate.entityType === target)).toBe(true);
    expect(f2.discoveryPath!.featured.map((f) => f.recommendationEntityId)).not.toContain(startHere(f1));
  });
});

// ---------------------------------------------------------------- service level: live agent budget and corrections

const untaggedBooks = (n: number): RawInsightEntity[] =>
  Array.from({ length: n }, (_, i) => ({ entity_id: `BOOK-${i + 1}`, name: `Untagged ${i + 1}`, subtype: "urn:entity:book", query: { affinity: 0.9 - i * 0.02 }, tags: [] }));

function provider(entities: RawInsightEntity[]): QlooProvider & { calls: () => number } {
  let calls = 0;
  const res = <T>(payload: T) => ({ provenance: "qloo" as const, requestId: randomUUID(), requestCount: 1, payload });
  return {
    mode: "live",
    calls: () => calls,
    async searchEntities() {
      calls += 1;
      return res({ results: [{ entity_id: "SEED-1", name: "Seed", types: ["urn:entity:movie"] }] });
    },
    async getEntity() {
      calls += 1;
      return res(null);
    },
    async getRecommendations() {
      calls += 1;
      return res({ success: true, results: { entities: structuredClone(entities) } });
    },
  };
}

/** Pretends to be the live Gemini agent (1 request per decision) while deciding deterministically. */
function countingAgent(): BoundedAgent & { calls: number } {
  const agent = {
    name: "counting-gemini",
    mode: "LIVE_GEMINI" as const,
    calls: 0,
    async decide(context: Parameters<BoundedAgent["decide"]>[0]): Promise<AgentResult> {
      agent.calls += 1;
      return {
        decision: deterministicDecision(context),
        mode: "LIVE_GEMINI",
        model: "fake",
        requestId: randomUUID(),
        toolCalls: { allowed: [], attempted: 1, accepted: null, names: [] },
        validation: "valid",
        usage: { promptTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0, requests: 1, latencyMs: 0, estimatedCostUsd: 0 },
        questionCandidates: context.questions.length,
      };
    },
  };
  return agent;
}

function liveDeps(entities: RawInsightEntity[], env: Record<string, string> = {}) {
  const qloo = provider(entities);
  const agent = countingAgent();
  const deps: DiscoveryDeps = {
    config: testConfig({ QLOO_MODE: "live", QLOO_API_KEY: "k", LLM_PROVIDER: "none", ...env }),
    provider: qloo,
    agent: createDeterministicMockAgent(),
    store: createMemorySessionStore(),
    boundedAgent: agent,
  };
  return { deps, qloo, agent };
}
const LIVE_START = { entityQuery: "Seed", sourceType: "movie" as const, targetType: "book" as const, maxQuestions: 3 as const, selectedEntityId: "SEED-1" };

describe("S9.6 exploration-level budgets (service level)", () => {
  it("the Gemini allowance spans rounds: continue is refused (typed) with no provider call once it cannot cover a decision", async () => {
    const { deps, qloo, agent } = liveDeps(untaggedBooks(12), { MAX_GEMINI_REQUESTS_PER_EXPLORATION: "4" });
    let v = await startDiscovery(deps, LIVE_START); // decision 1
    v = await finishDiscovery(deps, v.sessionToken);
    v = await continueExploration(deps, { sessionToken: v.sessionToken }); // decision 2
    expect(v.exploration!.round).toBe(2);
    v = await finishDiscovery(deps, v.sessionToken);
    // 2 used + reserve 2 = 4: one more round fits
    v = await continueExploration(deps, { sessionToken: v.sessionToken }); // decision 3
    v = await finishDiscovery(deps, v.sessionToken);
    expect(v.exploration).toMatchObject({ canContinue: false, continueBlockedReason: "budget_exhausted", budget: { geminiUsed: 3, geminiMax: 4 } });
    const before = { agent: agent.calls, qloo: qloo.calls() };
    await expect(continueExploration(deps, { sessionToken: v.sessionToken })).rejects.toMatchObject({ code: "EXPLORATION_BUDGET_EXHAUSTED", status: 429 });
    expect({ agent: agent.calls, qloo: qloo.calls() }).toEqual(before);
    // Context kept: the presenting round is still readable and acceptable.
    const done = await acceptRecommendation(deps, { sessionToken: v.sessionToken, entityId: v.recommendations[0]!.candidate.entityId });
    expect(done.exploration!.status).toBe("accepted");
  });

  it("inside a round, an exhausted allowance falls back deterministically instead of calling Gemini", async () => {
    const { deps, agent } = liveDeps(untaggedBooks(12), { MAX_GEMINI_REQUESTS_PER_EXPLORATION: "2" });
    const v0 = await startDiscovery(deps, LIVE_START); // 1 call; 1 left < reserve 2
    expect(v0.status).toBe("asking");
    const calls = agent.calls;
    const v1 = await answerDiscovery(deps, { sessionToken: v0.sessionToken, questionId: v0.currentQuestion!.questionId, response: "prefer_a" });
    expect(agent.calls).toBe(calls);
    expect(v1.agent).toMatchObject({ mode: "DETERMINISTIC_FALLBACK", fallbackReason: "exploration_gemini_budget_exhausted" });
  });

  it("rejecting a title the user explicitly preferred is recorded as a correction (entity-level only)", async () => {
    const { deps } = liveDeps(untaggedBooks(8));
    const v0 = await startDiscovery(deps, LIVE_START);
    expect(v0.currentQuestion!.targetType).toBe("entity"); // untagged → grounded A/B comparison
    const preferred = v0.currentQuestion!.targetIds[0]!;
    const v1 = await answerDiscovery(deps, { sessionToken: v0.sessionToken, questionId: v0.currentQuestion!.questionId, response: "prefer_a" });
    expect(v1.preferences.positiveEntityIds).toContain(preferred);
    const f1 = await finishDiscovery(deps, v1.sessionToken);
    expect(f1.recommendations.map((r) => r.candidate.entityId)).toContain(preferred);
    const r1 = await rejectRecommendation(deps, { sessionToken: f1.sessionToken, entityId: preferred });
    expect(r1.preferences.positiveEntityIds).not.toContain(preferred);
    expect(r1.preferences.rejectedEntityIds).toContain(preferred);
    expect(r1.preferences.rejectedTagIds).toEqual([]);
    expect(r1.exploration!.rejectedRecommendationIds).toEqual([preferred]);
  });

  it("state lives only in the store: a fresh app instance continues the exploration", async () => {
    const { deps } = liveDeps(untaggedBooks(12));
    const f1 = await finishDiscovery(deps, (await startDiscovery(deps, LIVE_START)).sessionToken);
    // New deps object (as after a restart or on another serverless instance), same store and secret.
    const other: DiscoveryDeps = { ...liveDeps(untaggedBooks(12)).deps, store: deps.store, config: deps.config };
    const c2 = await continueExploration(other, { sessionToken: f1.sessionToken });
    expect(c2.exploration).toMatchObject({ explorationId: f1.sessionId, round: 2 });
  });

  it("store failure fails closed on every new transition, before any provider call", async () => {
    const { deps, qloo, agent } = liveDeps(untaggedBooks(12));
    const f1 = await finishDiscovery(deps, (await startDiscovery(deps, LIVE_START)).sessionToken);
    const before = { qloo: qloo.calls(), agent: agent.calls };
    const broken: DiscoveryDeps = {
      ...deps,
      store: { ...deps.store, read: async () => { throw Object.assign(new Error("down"), { code: "SESSION_STORE_UNAVAILABLE", status: 503 }); } },
    };
    const entityId = f1.recommendations[0]!.candidate.entityId;
    for (const run of [
      () => continueExploration(broken, { sessionToken: f1.sessionToken }),
      () => rejectRecommendation(broken, { sessionToken: f1.sessionToken, entityId }),
      () => acceptRecommendation(broken, { sessionToken: f1.sessionToken, entityId }),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: "SESSION_STORE_UNAVAILABLE" });
    }
    expect({ qloo: qloo.calls(), agent: agent.calls }).toEqual(before);
  });

  it("the Qloo session budget is cumulative across rounds (continue never retrieves)", async () => {
    const { deps, qloo } = liveDeps(untaggedBooks(12));
    let v = await startDiscovery(deps, LIVE_START);
    const afterStart = qloo.calls();
    for (let round = 0; round < 3; round += 1) {
      v = await finishDiscovery(deps, v.sessionToken);
      v = await continueExploration(deps, { sessionToken: v.sessionToken });
    }
    expect(qloo.calls()).toBe(afterStart);
    expect(v.usage.qlooCallCount).toBe(1);
    expect(v.exploration!.round).toBe(4);
  });
});
