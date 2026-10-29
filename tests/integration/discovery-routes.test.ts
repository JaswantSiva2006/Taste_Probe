import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as answerRoute } from "@/app/api/discovery/answer/route";
import { POST as finishRoute } from "@/app/api/discovery/finish/route";
import { POST as startRoute } from "@/app/api/discovery/start/route";
import { GET as searchRoute } from "@/app/api/entities/search/route";
import { GET as healthRoute } from "@/app/api/health/route";
import {
  ApiFailureSchema,
  DiscoveryViewSchema,
  apiSuccessSchema,
  type DiscoveryView,
} from "@/lib/contracts";
import { newTestSecret } from "../helpers";

/** Exercises the real route handlers with Web Request objects (no network). */

const BASE = "http://localhost/api";
const START_BODY = {
  entityQuery: "Interstellar",
  sourceType: "movie",
  targetType: "book",
  maxQuestions: 3,
  selectedEntityId: "mock:movie:interstellar",
};

const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function ok(res: Response): Promise<DiscoveryView> {
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(200);
  expect(res.headers.get("x-request-id")).toBe(json.meta.requestId);
  return apiSuccessSchema(DiscoveryViewSchema).parse(json).data;
}

async function fail(res: Response, status: number, code: string) {
  const json = ApiFailureSchema.parse(await res.json());
  expect(res.status).toBe(status);
  expect(json.error.code).toBe(code);
  expect(json.meta.requestId).toBeTruthy();
  return json;
}

const start = async () => ok(await startRoute(post("/discovery/start", START_BODY)));
const answer = (v: DiscoveryView, response = "like", questionId = v.currentQuestion?.questionId ?? "none") =>
  answerRoute(post("/discovery/answer", { sessionToken: v.sessionToken, questionId, response }));

beforeEach(() => {
  vi.stubEnv("QLOO_MODE", "mock");
  vi.stubEnv("SESSION_SIGNING_SECRET", newTestSecret());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("GET /api/health and /api/entities/search", () => {
  it("reports mock mode", async () => {
    const json = await (await healthRoute()).json();
    expect(json).toMatchObject({ ok: true, data: { status: "ok", mode: "mock" }, meta: { mode: "mock" } });
  });

  it("searches mock entities", async () => {
    const res = await searchRoute(new Request(`${BASE}/entities/search?q=interstellar&type=movie`));
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.meta.mode).toBe("mock");
    expect(json.data.results[0]).toMatchObject({ entityId: "mock:movie:interstellar", provenance: "mock" });
  });

  it("validates search query parameters", async () => {
    await fail(await searchRoute(new Request(`${BASE}/entities/search`)), 400, "VALIDATION_ERROR");
    await fail(await searchRoute(new Request(`${BASE}/entities/search?q=x&type=podcast`)), 400, "VALIDATION_ERROR");
  });
});

describe("POST /api/discovery/start", () => {
  it("starts a session with a mock shortlist and a first question", async () => {
    const v = await start();
    expect(v.status).toBe("asking");
    expect(v.seed.entityId).toBe("mock:movie:interstellar");
    expect(v.questionCount).toBe(1);
    expect(v.maxQuestions).toBe(3);
    expect(v.revision).toBe(0);
    expect(v.currentQuestion).not.toBeNull();
    expect(v.recommendations.length).toBeGreaterThan(1);
    expect(v.recommendations.every((r) => r.candidate.evidence.source === "mock")).toBe(true);
    expect(v.agent).toMatchObject({ name: "deterministic-mock-agent", decision: { action: "ask" } });
    expect(v.usage.qlooCallCount).toBe(1);
    expect(v.rankingChanged).toBe(false);
  });

  it("finishes without asking when adaptive questioning is disabled", async () => {
    vi.stubEnv("ENABLE_ADAPTIVE_QUESTIONING", "false");
    const view = await start();
    expect(view.status).toBe("finished");
    expect(view.currentQuestion).toBeNull();
    expect(view.questionCount).toBe(0);
  });

  it("resolves an exact query without an explicit selection", async () => {
    const rest = { ...START_BODY, selectedEntityId: undefined };
    expect((await ok(await startRoute(post("/discovery/start", rest)))).seed.entityId).toBe("mock:movie:interstellar");
  });

  it("rejects unknown entity IDs", async () => {
    await fail(await startRoute(post("/discovery/start", { ...START_BODY, selectedEntityId: "mock:movie:nope" })), 404, "ENTITY_NOT_FOUND");
  });

  it("rejects an entity of the wrong type", async () => {
    await fail(await startRoute(post("/discovery/start", { ...START_BODY, selectedEntityId: "mock:book:alpha" })), 400, "ENTITY_TYPE_MISMATCH");
  });

  it("rejects malformed input", async () => {
    await fail(await startRoute(post("/discovery/start", "{not json")), 400, "INVALID_JSON");
    await fail(await startRoute(post("/discovery/start", { ...START_BODY, maxQuestions: 10 })), 400, "VALIDATION_ERROR");
    await fail(await startRoute(post("/discovery/start", [])), 400, "VALIDATION_ERROR");
  });

  it("fails explicitly when live credentials are absent instead of returning fixtures", async () => {
    vi.stubEnv("QLOO_MODE", "live");
    const json = await fail(await startRoute(post("/discovery/start", START_BODY)), 500, "CONFIG_ERROR");
    expect(json.meta.mode).toBe("live");
  });
});

describe("POST /api/discovery/answer", () => {
  it("updates preferences, bumps the revision and reranks", async () => {
    const v0 = await start();
    const v1 = await ok(await answer(v0, "like"));
    expect(v1.revision).toBe(1);
    expect(v1.lastAnswer).toMatchObject({ questionId: v0.currentQuestion!.questionId, response: "like" });
    expect(v1.preferences.positiveTagIds).toEqual(v0.currentQuestion!.targetIds);
    expect(v1.rankingChanged).toBe(true);
    expect(v1.recommendations.map((r) => r.candidate.entityId)).not.toEqual(v0.recommendations.map((r) => r.candidate.entityId));
    expect(v1.recommendations.some((r) => r.previousPosition !== r.position)).toBe(true);
    expect(v1.currentQuestion?.questionId).not.toBe(v0.currentQuestion!.questionId);
  });

  it("an unknown answer changes no preferences", async () => {
    const v1 = await ok(await answer(await start(), "unknown"));
    expect(v1.preferences.positiveTagIds).toEqual([]);
    expect(v1.preferences.rejectedTagIds).toEqual([]);
    expect(v1.rankingChanged).toBe(false);
  });

  it("rejects an unknown question ID", async () => {
    await fail(await answer(await start(), "like", "tag:mock:tag:does-not-exist"), 400, "INVALID_QUESTION");
  });

  it("rejects a known but inactive question", async () => {
    const v0 = await start();
    const v1 = await ok(await answer(v0, "like"));
    await fail(await answer(v1, "like", v0.currentQuestion!.questionId), 409, "QUESTION_MISMATCH");
  });

  it("rejects responses not allowed for the question", async () => {
    await fail(await answer(await start(), "prefer_a"), 400, "INVALID_ANSWER");
    const v = await start();
    const bad = answerRoute(post("/discovery/answer", { sessionToken: v.sessionToken, questionId: v.currentQuestion!.questionId, response: "love" }));
    await fail(await bad, 400, "VALIDATION_ERROR");
  });

  it("rejects tampered tokens", async () => {
    const v = await start();
    const other = await start();
    const [ver, body, sig] = v.sessionToken.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    // Tokens now carry only {sid, rev, exp}; forging any of them must fail.
    for (const change of [{ rev: payload.rev + 1 }, { sid: other.sessionId }, { exp: payload.exp + 86_400_000 }]) {
      const forged = `${ver}.${Buffer.from(JSON.stringify({ ...payload, ...change })).toString("base64url")}.${sig}`;
      await fail(await answer({ ...v, sessionToken: forged }), 401, "INVALID_SESSION_TOKEN");
    }
    await fail(await answer({ ...v, sessionToken: "garbage" }), 401, "INVALID_SESSION_TOKEN");
  });

  it("rejects replay of an older token over HTTP and keeps the newer state", async () => {
    const v0 = await start();
    const v1 = await ok(await answer(v0, "like"));
    const replay = await fail(await answer(v0, "dislike"), 409, "SESSION_REVISION_CONFLICT");
    expect(replay.error.message).not.toMatch(/secret|redis|stack/i);
    const v2 = await ok(await answer(v1, "unknown"));
    expect(v2.revision).toBe(2);
    expect(v2.preferences.positiveTagIds).toEqual(v1.preferences.positiveTagIds);
  });

  it("lets only one of two simultaneous HTTP answers with the same token succeed", async () => {
    const v0 = await start();
    const res = await Promise.all([answer(v0, "like"), answer(v0, "dislike")]);
    const statuses = res.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("rejects tokens signed with a different secret", async () => {
    const v = await start();
    vi.stubEnv("SESSION_SIGNING_SECRET", newTestSecret());
    await fail(await answer(v), 401, "INVALID_SESSION_TOKEN");
  });

  it("rejects expired sessions", async () => {
    const v = await start();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    await fail(await answer(v), 401, "SESSION_EXPIRED");
  });

  it("never asks more than 3 questions and blocks budget overflow", async () => {
    let v = await start();
    const seen = new Set<string>();
    let answered = 0;
    while (v.status === "asking") {
      expect(v.questionCount).toBeLessThanOrEqual(3);
      seen.add(v.currentQuestion!.questionId);
      v = await ok(await answer(v, "like"));
      answered += 1;
      expect(answered).toBeLessThanOrEqual(3);
    }
    expect(v.questionCount).toBe(3);
    expect(seen.size).toBe(3);
    expect(v.finishReason).toBe("question_budget_exhausted");
    expect(v.recommendations.length).toBeLessThanOrEqual(5);
    await fail(await answer(v, "like", [...seen][0]), 409, "QUESTION_BUDGET_EXHAUSTED");
  });
});

describe("POST /api/discovery/finish", () => {
  it("finishes early with at most 5 mock recommendations", async () => {
    const v0 = await start();
    const done = await ok(await finishRoute(post("/discovery/finish", { sessionToken: v0.sessionToken })));
    expect(done.status).toBe("finished");
    expect(done.finishReason).toBe("user_finished");
    expect(done.currentQuestion).toBeNull();
    expect(done.questionCount).toBe(1);
    expect(done.recommendations.length).toBeGreaterThan(0);
    expect(done.recommendations.length).toBeLessThanOrEqual(5);
    expect(done.recommendations.every((r) => r.candidate.evidence.source === "mock")).toBe(true);

    await fail(await answer(done, "like", v0.currentQuestion!.questionId), 409, "SESSION_FINISHED");
    const again = await ok(await finishRoute(post("/discovery/finish", { sessionToken: done.sessionToken })));
    expect(again.recommendations.map((r) => r.candidate.entityId)).toEqual(done.recommendations.map((r) => r.candidate.entityId));
    // The pre-finish token cannot reopen the session.
    await fail(await answer(v0, "like"), 409, "SESSION_REVISION_CONFLICT");
    await fail(await finishRoute(post("/discovery/finish", { sessionToken: v0.sessionToken })), 409, "SESSION_REVISION_CONFLICT");
  });

  it("fails closed in production without Redis credentials", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const json = await fail(await startRoute(post("/discovery/start", START_BODY)), 500, "CONFIG_ERROR");
    expect(json.error.message).toContain("UPSTASH_REDIS_REST_URL");
    await fail(await healthRoute(), 500, "CONFIG_ERROR");
  });

  it("keeps preferences learned before finishing", async () => {
    const v1 = await ok(await answer(await start(), "like"));
    const done = await ok(await finishRoute(post("/discovery/finish", { sessionToken: v1.sessionToken })));
    expect(done.preferences.positiveTagIds).toEqual(v1.preferences.positiveTagIds);
    expect(done.recommendations.map((r) => r.candidate.entityId)).toEqual(
      v1.recommendations.slice(0, 5).map((r) => r.candidate.entityId),
    );
  });

  it("validates the body", async () => {
    await fail(await finishRoute(post("/discovery/finish", {})), 400, "VALIDATION_ERROR");
    await fail(await finishRoute(post("/discovery/finish", { sessionToken: "x.y.z" })), 401, "INVALID_SESSION_TOKEN");
  });
});
