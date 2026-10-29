import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Redis } from "@upstash/redis";
import { afterAll, describe, expect, it } from "vitest";
import { createRedisSessionStore } from "@/lib/session/redis-store";
import type { StoredSession } from "@/lib/session/store";

/**
 * OPTIONAL live check against a real Upstash database (npm run test:redis).
 * Skipped unless RUN_REDIS_LIVE_TEST=1 and both UPSTASH_* variables are set
 * (process env, .env.local or .env). Writes only short-lived keys under
 * tasteprobe:session:live-test-* and deletes them afterwards.
 */
if (process.env.RUN_REDIS_LIVE_TEST === "1") {
  const require = createRequire(import.meta.url);
  require("@next/env").loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
}
const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
const enabled = process.env.RUN_REDIS_LIVE_TEST === "1" && Boolean(url && token);

describe.skipIf(!enabled)("live Upstash Redis session store", () => {
  const client = new Redis({ url: url!, token: token!, retry: false, automaticDeserialization: false });
  const store = createRedisSessionStore(client);
  const ids: string[] = [];
  const id = () => {
    const v = `live-test-${randomUUID()}`;
    ids.push(v);
    return v;
  };
  const record = (over: Partial<StoredSession> = {}): StoredSession => ({
    revision: 0,
    lockId: null,
    lockUntil: 0,
    data: '{"live":true}',
    expiresAt: Date.now() + 60_000,
    ...over,
  });

  afterAll(async () => {
    for (const i of ids) await store.expire(i);
  });

  it("creates, reads and advances a revision atomically", async () => {
    const sid = id();
    expect(await store.create(sid, record())).toBe("ok");
    expect(await store.create(sid, record())).toBe("exists");
    expect(await store.compareAndSwap(sid, { revision: 0, lockId: null }, record({ revision: 1 }), Date.now())).toBe("ok");
    expect(await store.compareAndSwap(sid, { revision: 0, lockId: null }, record({ revision: 1 }), Date.now())).toBe("conflict");
    expect((await store.read(sid, Date.now()))?.revision).toBe(1);
  });

  it("lets exactly one of concurrent network CAS calls win", async () => {
    const sid = id();
    await store.create(sid, record());
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        store.compareAndSwap(sid, { revision: 0, lockId: null }, record({ revision: 1, data: `"w${i}"` }), Date.now()),
      ),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
  });

  it("honours leases", async () => {
    const sid = id();
    await store.create(sid, record());
    await store.compareAndSwap(sid, { revision: 0, lockId: null }, record({ lockId: "L1", lockUntil: Date.now() + 30_000 }), Date.now());
    expect(await store.compareAndSwap(sid, { revision: 0, lockId: null }, record({ revision: 1 }), Date.now())).toBe("locked");
    expect(await store.compareAndSwap(sid, { revision: 0, lockId: "L1" }, record({ revision: 1 }), Date.now())).toBe("ok");
  });
});
