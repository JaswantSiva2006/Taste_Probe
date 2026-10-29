import { describe, expect, it } from "vitest";
import { createMemorySessionStore } from "@/lib/session/memory-store";
import { CAS_SCRIPT, CREATE_SCRIPT, createRedisSessionStore, type EvalClient } from "@/lib/session/redis-store";
import { sessionKey, type SessionStore, type StoredSession } from "@/lib/session/store";
import { createLuaRedis } from "../support/lua-redis";

/**
 * SessionStore contract, run against both implementations. The Redis variant
 * executes the adapter's real Lua scripts in a Lua VM (see tests/support/lua-redis.ts).
 */
const T0 = Date.now();
const record = (over: Partial<StoredSession> = {}): StoredSession => ({
  revision: 0,
  lockId: null,
  lockUntil: 0,
  data: '{"v":0}',
  expiresAt: T0 + 60_000,
  ...over,
});

const stores: Array<[string, () => SessionStore]> = [
  ["memory", () => createMemorySessionStore()],
  ["redis (Lua via fengari)", () => createRedisSessionStore(createLuaRedis(() => T0))],
];

describe.each(stores)("SessionStore contract: %s", (_name, make) => {
  it("creates once and reads back", async () => {
    const s = make();
    expect(await s.create("a", record())).toBe("ok");
    expect(await s.create("a", record({ data: "other" }))).toBe("exists");
    expect(await s.read("a", T0)).toEqual(record());
    expect(await s.read("missing", T0)).toBeNull();
  });

  it("CAS succeeds only for the current revision and advances it", async () => {
    const s = make();
    await s.create("a", record());
    expect(await s.compareAndSwap("a", { revision: 0, lockId: null }, record({ revision: 1, data: "r1" }), T0)).toBe("ok");
    expect(await s.read("a", T0)).toMatchObject({ revision: 1, data: "r1" });
    // Stale writer (still expects revision 0) cannot overwrite revision 1.
    expect(await s.compareAndSwap("a", { revision: 0, lockId: null }, record({ revision: 1, data: "stale" }), T0)).toBe("conflict");
    expect(await s.read("a", T0)).toMatchObject({ revision: 1, data: "r1" });
  });

  it("an active lease blocks other writers until it expires", async () => {
    const s = make();
    await s.create("a", record());
    const leased = record({ lockId: "L1", lockUntil: T0 + 1_000 });
    expect(await s.compareAndSwap("a", { revision: 0, lockId: null }, leased, T0)).toBe("ok");
    expect(await s.compareAndSwap("a", { revision: 0, lockId: null }, record({ revision: 1 }), T0)).toBe("locked");
    expect(await s.compareAndSwap("a", { revision: 0, lockId: "L2" }, record({ revision: 1 }), T0)).toBe("locked");
    // The owner commits.
    expect(await s.compareAndSwap("a", { revision: 0, lockId: "L1" }, record({ revision: 1, data: "c" }), T0)).toBe("ok");
    expect(await s.read("a", T0)).toMatchObject({ revision: 1, lockId: null, data: "c" });
  });

  it("an expired lease can be taken over, and its former owner then conflicts", async () => {
    const s = make();
    await s.create("a", record());
    await s.compareAndSwap("a", { revision: 0, lockId: null }, record({ lockId: "L1", lockUntil: T0 + 10 }), T0);
    const later = T0 + 20;
    expect(await s.compareAndSwap("a", { revision: 0, lockId: null }, record({ lockId: "L2", lockUntil: later + 10 }), later)).toBe("ok");
    expect(await s.compareAndSwap("a", { revision: 0, lockId: "L1" }, record({ revision: 1 }), later)).toBe("locked");
  });

  it("treats expired records as missing", async () => {
    const s = make();
    await s.create("a", record({ expiresAt: T0 + 5 }));
    expect(await s.read("a", T0 + 5)).toBeNull();
    expect(await s.compareAndSwap("a", { revision: 0, lockId: null }, record({ revision: 1 }), T0 + 5)).toBe("missing");
  });

  it("isolates sessions and supports expire()", async () => {
    const s = make();
    await s.create("a", record({ data: "A" }));
    await s.create("b", record({ data: "B" }));
    await s.compareAndSwap("a", { revision: 0, lockId: null }, record({ revision: 1, data: "A1" }), T0);
    expect(await s.read("b", T0)).toMatchObject({ revision: 0, data: "B" });
    await s.expire("a");
    expect(await s.read("a", T0)).toBeNull();
    expect(await s.read("b", T0)).not.toBeNull();
  });

  it("lets exactly one of many concurrent CAS calls on the same revision win", async () => {
    const s = make();
    await s.create("a", record());
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => s.compareAndSwap("a", { revision: 0, lockId: null }, record({ revision: 1, data: `w${i}` }), T0)),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "conflict")).toHaveLength(7);
  });
});

describe("Redis adapter specifics", () => {
  it("uses one EVAL per operation with namespaced keys and a TTL", async () => {
    const redis = createLuaRedis(() => T0);
    const store = createRedisSessionStore(redis);
    await store.create("abc", record());
    await store.compareAndSwap("abc", { revision: 0, lockId: null }, record({ revision: 1 }), T0);
    expect(redis.evalCount).toBe(2);
    expect(redis.keys()).toEqual([sessionKey("abc")]);
    expect(redis.raw(sessionKey("abc"))).toMatchObject({ rev: "1", lock: "", exp: String(T0 + 60_000) });
  });

  it("CAS is a single script containing both the compare and the write", () => {
    // Guard against regressing to GET-then-SET in application code.
    expect(CAS_SCRIPT).toMatch(/HMGET[\s\S]*~=[\s\S]*HSET[\s\S]*PEXPIREAT/);
    expect(CREATE_SCRIPT).toMatch(/EXISTS[\s\S]*HSET/);
  });

  it("maps driver failures to SESSION_STORE_UNAVAILABLE without leaking details", async () => {
    const failing: EvalClient = {
      eval: async () => {
        throw new Error("connect ECONNREFUSED https://secret-host.upstash.io token=abc");
      },
      del: async () => {
        throw new Error("down");
      },
    };
    const store = createRedisSessionStore(failing);
    for (const op of [
      () => store.read("a", T0),
      () => store.create("a", record()),
      () => store.compareAndSwap("a", { revision: 0, lockId: null }, record(), T0),
      () => store.expire("a"),
    ]) {
      const err = await op().catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "SESSION_STORE_UNAVAILABLE", status: 503 });
      expect((err as Error).message).not.toMatch(/upstash|token|ECONN/);
    }
  });

  it("rejects unexpected script replies instead of guessing", async () => {
    const weird: EvalClient = { eval: (async () => "maybe") as EvalClient["eval"], del: async () => 0 };
    await expect(createRedisSessionStore(weird).compareAndSwap("a", { revision: 0, lockId: null }, record(), T0)).rejects.toMatchObject({
      code: "SESSION_STORE_UNAVAILABLE",
    });
  });
});
