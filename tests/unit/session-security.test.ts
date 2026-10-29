import { describe, expect, it } from "vitest";
import { createDeterministicMockAgent } from "@/lib/agent/mock-agent";
import type { DiscoveryAgent } from "@/lib/agent/types";
import type { DiscoveryView } from "@/lib/contracts";
import { answerDiscovery, finishDiscovery, startDiscovery, type DiscoveryDeps } from "@/lib/discovery/service";
import { createMockQlooProvider } from "@/lib/qloo/mock-provider";
import type { QlooProvider } from "@/lib/qloo/provider";
import { createMemorySessionStore } from "@/lib/session/memory-store";
import { createRedisSessionStore } from "@/lib/session/redis-store";
import { SessionStateSchema } from "@/lib/session/state";
import { storeUnavailable, type SessionStore } from "@/lib/session/store";
import { AppError } from "@/lib/validation/errors";
import { createLuaRedis } from "../support/lua-redis";
import { interstellarStart, newTestSecret, testConfig } from "../helpers";

/**
 * Replay / concurrency / budget security tests (S4 A–L) against the discovery
 * service with an authoritative store. Race tests use a barrier so every racing
 * request has READ the same revision before any of them writes: they are real
 * interleavings, not sequential calls.
 */

// ---- test doubles ----------------------------------------------------------------

type BarrierStore = SessionStore & { arm(parties: number): void };

/** Holds `parties` reads until all have completed, forcing them to observe the same revision. */
function withBarrier(inner: SessionStore): BarrierStore {
  let armed = 0;
  let waiting: Array<() => void> = [];
  return {
    kind: inner.kind,
    create: (id, r) => inner.create(id, r),
    compareAndSwap: (id, e, n, now) => inner.compareAndSwap(id, e, n, now),
    expire: (id) => inner.expire(id),
    arm(parties) {
      armed = parties;
    },
    async read(id, now) {
      const record = await inner.read(id, now);
      if (armed > 0) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === armed) {
            armed = 0;
            const release = waiting;
            waiting = [];
            release.forEach((r) => r());
          }
        });
      }
      return record;
    },
  };
}

/** Counts every recommendation request that reaches the (mock) provider. */
function countingProvider(): QlooProvider & { calls: number } {
  const inner = createMockQlooProvider();
  const p = {
    calls: 0,
    mode: inner.mode,
    searchEntities: inner.searchEntities.bind(inner),
    getEntity: inner.getEntity.bind(inner),
    async getRecommendations(req: Parameters<QlooProvider["getRecommendations"]>[0]) {
      p.calls += 1;
      return inner.getRecommendations(req);
    },
  };
  return p;
}

/** Re-retrieves from Qloo at the start of every turn, so answers incur real (counted) provider calls. */
function retrievingAgent(): DiscoveryAgent {
  const inner = createDeterministicMockAgent();
  let lastWasRetrieve = false;
  return {
    name: "retrieving-test-agent",
    async decide(ctx) {
      const decision =
        !lastWasRetrieve && ctx.qlooCallsRemaining > 0 && !ctx.stop.stop
          ? ({ action: "retrieve", reasonCode: "insufficient_candidates", done: false } as const)
          : await inner.decide(ctx);
      lastWasRetrieve = decision.action === "retrieve";
      return decision;
    },
  };
}

type Env = { store: BarrierStore; provider: ReturnType<typeof countingProvider>; deps: DiscoveryDeps; clock: { t: number } };

function setup(opts: { store?: SessionStore; env?: Record<string, string>; secret?: string; retrieving?: boolean } = {}): Env {
  const store = withBarrier(opts.store ?? createMemorySessionStore());
  const provider = countingProvider();
  const clock = { t: Date.now() };
  const config = testConfig({ SESSION_SIGNING_SECRET: opts.secret ?? newTestSecret(), ...opts.env });
  return {
    store,
    provider,
    clock,
    deps: {
      config,
      provider,
      agent: opts.retrieving ? retrievingAgent() : createDeterministicMockAgent(),
      store,
      now: () => clock.t,
    },
  };
}

/** A second "server instance": own provider/agent/config object, same secret and same authoritative store. */
function secondInstance(env: Env, secret: string): DiscoveryDeps {
  return {
    config: testConfig({ SESSION_SIGNING_SECRET: secret }),
    provider: createMockQlooProvider(),
    agent: createDeterministicMockAgent(),
    store: env.store,
    now: () => env.clock.t,
  };
}

const answer = (deps: DiscoveryDeps, v: DiscoveryView, response: "like" | "dislike" | "unknown" = "like", questionId?: string) =>
  answerDiscovery(deps, { sessionToken: v.sessionToken, questionId: questionId ?? v.currentQuestion!.questionId, response });

async function stored(env: Env, v: DiscoveryView) {
  const record = await env.store.read(v.sessionId, env.clock.t);
  return { record: record!, state: SessionStateSchema.parse(JSON.parse(record!.data)) };
}

const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? (r.reason as AppError).code : "ok");

// ---- tests ---------------------------------------------------------------------------

describe.each([
  ["memory store", () => createMemorySessionStore()],
  ["redis store (Lua via fengari)", () => createRedisSessionStore(createLuaRedis())],
])("session security with %s", (_name, makeStore) => {
  it("A: rejects reuse of an old token after an answer, without side effects", async () => {
    const env = setup({ store: makeStore() });
    const v0 = await startDiscovery(env.deps, interstellarStart);
    const v1 = await answer(env.deps, v0, "like");
    expect(v1.revision).toBe(1);
    const before = await stored(env, v1);

    await expect(answer(env.deps, v0, "dislike")).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT", status: 409 });
    await expect(finishDiscovery(env.deps, v0.sessionToken)).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });

    const after = await stored(env, v1);
    expect(after.record).toEqual(before.record);
    expect(after.state.session.answers).toHaveLength(1);
    // The current token still works.
    expect((await answer(env.deps, v1)).revision).toBe(2);
  });

  it("B: of two simultaneous answers with the same token exactly one succeeds, and only it calls Qloo", async () => {
    const env = setup({ store: makeStore(), retrieving: true });
    const v0 = await startDiscovery(env.deps, interstellarStart);
    const callsBefore = env.provider.calls;

    env.store.arm(2);
    const results = await Promise.allSettled([answer(env.deps, v0, "like"), answer(env.deps, v0, "dislike")]);

    expect(results.map(codeOf).sort()).toEqual(["SESSION_REVISION_CONFLICT", "ok"]);
    expect(env.provider.calls - callsBefore).toBe(1);
    const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<DiscoveryView>).value;
    const { state, record } = await stored(env, winner);
    expect(record.revision).toBe(1);
    expect(record.lockId).toBeNull();
    expect(state.session.answers).toHaveLength(1);
    expect(state.session.answers[0]!.response).toBe(winner.lastAnswer!.response);
    expect(state.session.qlooCallCount).toBe(2); // start + the winner's retrieval only
  });

  it("C: simultaneous answer and finish: exactly one transition wins and the state matches it", async () => {
    for (const order of [0, 1]) {
      const env = setup({ store: makeStore() });
      const v0 = await startDiscovery(env.deps, interstellarStart);
      env.store.arm(2);
      const ops = [() => answer(env.deps, v0, "like"), () => finishDiscovery(env.deps, v0.sessionToken)];
      const results = await Promise.allSettled(order ? ops.reverse().map((f) => f()) : ops.map((f) => f()));
      const codes = results.map(codeOf);
      expect(codes.filter((c) => c === "ok")).toHaveLength(1);
      expect(codes.filter((c) => c === "SESSION_REVISION_CONFLICT")).toHaveLength(1);

      const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<DiscoveryView>).value;
      const { state, record } = await stored(env, winner);
      expect(record.revision).toBe(1);
      if (winner.status === "finished") {
        expect(state.session.status).toBe("finished");
        expect(state.session.answers).toHaveLength(0);
      } else {
        expect(state.session.status).toBe("active");
        expect(state.session.answers).toHaveLength(1);
      }
    }
  });

  it("D: a token issued before finish cannot reopen or modify the finished session", async () => {
    const env = setup({ store: makeStore() });
    const v0 = await startDiscovery(env.deps, interstellarStart);
    const done = await finishDiscovery(env.deps, v0.sessionToken);
    expect(done.status).toBe("finished");

    await expect(answer(env.deps, v0)).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    await expect(finishDiscovery(env.deps, v0.sessionToken)).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    await expect(answer(env.deps, done, "like", v0.currentQuestion!.questionId)).rejects.toMatchObject({ code: "SESSION_FINISHED" });

    // Repeating finish with the current token is read-only and idempotent.
    const again = await finishDiscovery(env.deps, done.sessionToken);
    expect(again.revision).toBe(done.revision);
    const { state, record } = await stored(env, done);
    expect(state.session.status).toBe("finished");
    expect(record.revision).toBe(1);
  });

  it("E: rejects tampered tokens (revision, session ID, signature) and tokens from another secret", async () => {
    const env = setup({ store: makeStore() });
    const v0 = await startDiscovery(env.deps, interstellarStart);
    const other = await startDiscovery(env.deps, interstellarStart);
    const [ver, body, sig] = v0.sessionToken.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    const forge = (c: object) => `${ver}.${Buffer.from(JSON.stringify({ ...claims, ...c })).toString("base64url")}.${sig}`;

    for (const token of [forge({ rev: 5 }), forge({ sid: other.sessionId }), forge({ exp: claims.exp + 1e9 }), `${ver}.${body}.AAAA${sig.slice(4)}`]) {
      await expect(answerDiscovery(env.deps, { sessionToken: token, questionId: v0.currentQuestion!.questionId, response: "like" })).rejects.toMatchObject({
        code: "INVALID_SESSION_TOKEN",
      });
    }
    const foreign = setup({ store: env.store });
    await expect(answer(foreign.deps, v0)).rejects.toMatchObject({ code: "INVALID_SESSION_TOKEN" });
    expect((await stored(env, v0)).record.revision).toBe(0);
  });

  it("F: rejects expired tokens and expired or evicted store records", async () => {
    const env = setup({ store: makeStore() });
    const v0 = await startDiscovery(env.deps, interstellarStart);
    env.clock.t += 31 * 60 * 1000;
    await expect(answer(env.deps, v0)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });

    const env2 = setup({ store: makeStore() });
    const v1 = await startDiscovery(env2.deps, interstellarStart);
    await env2.store.expire(v1.sessionId); // record gone although the token is still within its lifetime
    await expect(answer(env2.deps, v1)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(finishDiscovery(env2.deps, v1.sessionToken)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("G: an answer to an unknown question has no side effects", async () => {
    const env = setup({ store: makeStore() });
    const v0 = await startDiscovery(env.deps, interstellarStart);
    const before = await stored(env, v0);
    await expect(answer(env.deps, v0, "like", "tag:mock:tag:not-real")).rejects.toMatchObject({ code: "INVALID_QUESTION" });
    await expect(answerDiscovery(env.deps, { sessionToken: v0.sessionToken, questionId: v0.currentQuestion!.questionId, response: "prefer_a" })).rejects.toMatchObject({
      code: "INVALID_ANSWER",
    });
    expect((await stored(env, v0)).record).toEqual(before.record); // no lease, no revision change
    expect((await answer(env.deps, v0)).revision).toBe(1);
  });

  it("H: never exceeds three questions, even with replays and races on the last question", async () => {
    const env = setup({ store: makeStore() });
    const tokens: DiscoveryView[] = [];
    let v = await startDiscovery(env.deps, interstellarStart);
    while (v.questionCount < 3) {
      tokens.push(v);
      v = await answer(env.deps, v);
    }
    expect(v.status).toBe("asking");
    // Race two answers on the final question.
    env.store.arm(2);
    const results = await Promise.allSettled([answer(env.deps, v, "like"), answer(env.deps, v, "dislike")]);
    expect(results.map(codeOf).sort()).toEqual(["SESSION_REVISION_CONFLICT", "ok"]);
    const done = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<DiscoveryView>).value;
    expect(done.status).toBe("finished");
    expect(done.questionCount).toBe(3);

    // Replaying any earlier token cannot ask or record another answer.
    for (const old of [...tokens, v]) {
      await expect(answer(env.deps, old)).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    }
    await expect(answer(env.deps, done, "like", tokens[0]!.currentQuestion!.questionId)).rejects.toMatchObject({
      code: "QUESTION_BUDGET_EXHAUSTED",
    });
    const { state } = await stored(env, done);
    expect(state.session.questionCount).toBe(3);
    expect(state.session.answers).toHaveLength(3);
  });

  it("I: usage budgets cannot be reset by replaying an older token", async () => {
    const env = setup({ store: makeStore(), retrieving: true, env: { MAX_QLOO_CALLS_PER_SESSION: "2" } });
    const v0 = await startDiscovery(env.deps, interstellarStart); // 1 call
    const v1 = await answer(env.deps, v0); // retrieval: 2 calls, budget exhausted
    expect(v1.usage.qlooCallCount).toBe(2);
    const calls = env.provider.calls;

    // The v0 token carried qlooCallCount=1 in S1's design; now it is simply stale.
    await expect(answer(env.deps, v0)).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    expect(env.provider.calls).toBe(calls);
    expect((await stored(env, v1)).state.session.qlooCallCount).toBe(2);
  });

  it("I: usage consumed by a failed turn is kept, and the retry cannot exceed the budget", async () => {
    const env = setup({ store: makeStore(), retrieving: true, env: { MAX_QLOO_CALLS_PER_SESSION: "3" } });
    const v0 = await startDiscovery(env.deps, interstellarStart); // qloo = 1
    const realGet = env.provider.getRecommendations.bind(env.provider);
    env.provider.getRecommendations = async (req) => {
      env.provider.calls += 1;
      expect(req.maxAttempts).toBe(2);
      throw new AppError("QLOO_UPSTREAM_ERROR", 502, "Qloo is temporarily unavailable");
    };
    await expect(answer(env.deps, v0)).rejects.toMatchObject({ code: "QLOO_UPSTREAM_ERROR" });

    // Lease released, revision unchanged, the failed attempt is charged at its cap (2).
    const { record, state } = await stored(env, v0);
    expect(record.revision).toBe(0);
    expect(record.lockId).toBeNull();
    expect(state.session.qlooCallCount).toBe(3);
    expect(state.session.answers).toHaveLength(0);

    // Same token retried: the agent sees 0 calls remaining, so the turn completes with no provider call
    // and the charged usage is not reset.
    env.provider.getRecommendations = realGet;
    const callsBefore = env.provider.calls;
    const retried = await answer(env.deps, v0);
    expect(env.provider.calls).toBe(callsBefore);
    expect(retried.usage.qlooCallCount).toBe(3);
  });

  it("I: an agent that insists on retrieving past the budget is stopped before calling Qloo", async () => {
    const env = setup({ store: makeStore(), env: { MAX_QLOO_CALLS_PER_SESSION: "1" } });
    const v0 = await startDiscovery(env.deps, interstellarStart); // budget used up by start
    env.deps.agent = { name: "greedy", decide: async () => ({ action: "retrieve", reasonCode: "insufficient_candidates", done: false }) };
    const calls = env.provider.calls;
    await expect(answer(env.deps, v0)).rejects.toMatchObject({ code: "QLOO_BUDGET_EXHAUSTED" });
    expect(env.provider.calls).toBe(calls);
    const { record, state } = await stored(env, v0);
    expect(record.lockId).toBeNull(); // lease released
    expect(state.session.qlooCallCount).toBe(1);
    expect(state.session.answers).toHaveLength(0);
  });

  it("L: two service instances sharing one store enforce the same revision", async () => {
    const secret = newTestSecret();
    const env = setup({ store: makeStore(), secret });
    const instanceB = secondInstance(env, secret);

    const v0 = await startDiscovery(env.deps, interstellarStart); // instance A
    const v1 = await answer(instanceB, v0); // instance B continues it
    await expect(answer(env.deps, v0)).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" }); // replay on A

    env.store.arm(2);
    const results = await Promise.allSettled([answer(env.deps, v1, "like"), answer(instanceB, v1, "dislike")]);
    expect(results.map(codeOf).sort()).toEqual(["SESSION_REVISION_CONFLICT", "ok"]);
    expect((await stored(env, v1)).record.revision).toBe(2);
  });

  it("isolates sessions from each other", async () => {
    const env = setup({ store: makeStore() });
    const a = await startDiscovery(env.deps, interstellarStart);
    const b = await startDiscovery(env.deps, interstellarStart);
    expect(a.sessionId).not.toBe(b.sessionId);
    await answer(env.deps, a, "like");
    const sb = await stored(env, b);
    expect(sb.record.revision).toBe(0);
    expect(sb.state.session.answers).toHaveLength(0);
  });

  it("unknown/skip answers advance the revision but infer no preference", async () => {
    const env = setup({ store: makeStore() });
    const v1 = await answer(env.deps, await startDiscovery(env.deps, interstellarStart), "unknown");
    const { state } = await stored(env, v1);
    expect(state.session.revision).toBe(1);
    expect([...state.session.positiveTagIds, ...state.session.rejectedTagIds]).toEqual([]);
  });
});

describe("race harness negative control", () => {
  /** Deliberately broken store: compare and set are separate steps with an await between them. */
  function getThenSetStore(): SessionStore {
    const map = new Map<string, import("@/lib/session/store").StoredSession>();
    return {
      kind: "memory",
      create: async (id, r) => (map.set(id, { ...r }), "ok"),
      read: async (id) => (map.has(id) ? { ...map.get(id)! } : null),
      expire: async (id) => void map.delete(id),
      async compareAndSwap(id, expect, next) {
        const cur = map.get(id);
        if (!cur) return "missing";
        const ok = cur.revision === expect.revision; // GET + compare ...
        await new Promise((r) => setTimeout(r, 5)); // ... gap ...
        if (!ok) return "conflict";
        map.set(id, { ...next }); // ... SET
        return "ok";
      },
    };
  }

  it("the barrier race lets both answers through on a non-atomic store (so it does detect broken CAS)", async () => {
    const env = setup({ store: getThenSetStore() });
    const v0 = await startDiscovery(env.deps, interstellarStart);
    env.store.arm(2);
    const results = await Promise.allSettled([answer(env.deps, v0, "like"), answer(env.deps, v0, "dislike")]);
    expect(results.map(codeOf)).toEqual(["ok", "ok"]); // the bug the atomic stores prevent
  });
});

describe("K: session-store outage fails closed", () => {
  it("rejects answers before any external call when the store cannot be read", async () => {
    const env = setup({ retrieving: true });
    const v0 = await startDiscovery(env.deps, interstellarStart);
    const calls = env.provider.calls;
    env.deps.store = { ...env.store, read: async () => Promise.reject(storeUnavailable()) };
    await expect(answer(env.deps, v0)).rejects.toMatchObject({ code: "SESSION_STORE_UNAVAILABLE", status: 503 });
    await expect(finishDiscovery(env.deps, v0.sessionToken)).rejects.toMatchObject({ code: "SESSION_STORE_UNAVAILABLE" });
    expect(env.provider.calls).toBe(calls);
  });

  it("does not report success when the commit write fails", async () => {
    const env = setup();
    const v0 = await startDiscovery(env.deps, interstellarStart);
    let writes = 0;
    env.deps.store = {
      ...env.store,
      read: (id, now) => env.store.read(id, now),
      compareAndSwap: async (id, e, n, now) => {
        writes += 1;
        if (writes === 2) throw storeUnavailable(); // lease succeeds, commit fails
        return env.store.compareAndSwap(id, e, n, now);
      },
    };
    await expect(answer(env.deps, v0)).rejects.toMatchObject({ code: "SESSION_STORE_UNAVAILABLE" });
    const { record, state } = await stored(env, v0);
    expect(record.revision).toBe(0);
    expect(state.session.answers).toHaveLength(0);
  });

  it("start fails closed when the session cannot be created", async () => {
    const env = setup();
    env.deps.store = { ...env.store, create: async () => Promise.reject(storeUnavailable()) };
    await expect(startDiscovery(env.deps, interstellarStart)).rejects.toMatchObject({ code: "SESSION_STORE_UNAVAILABLE" });
  });

  it("maps a Redis transport failure to SESSION_STORE_UNAVAILABLE", async () => {
    const env = setup({
      store: createRedisSessionStore({
        eval: async () => {
          throw new Error("fetch failed");
        },
        del: async () => 0,
      }),
    });
    await expect(startDiscovery(env.deps, interstellarStart)).rejects.toMatchObject({ code: "SESSION_STORE_UNAVAILABLE" });
  });
});
