import { logEvent } from "@/lib/telemetry/logger";
import { sessionKey, storeUnavailable, type CasResult, type SessionStore, type StoredSession } from "./store";

/**
 * Upstash Redis store. Every write is one EVAL of a Lua script, so the
 * compare and the set execute atomically on the Redis server (no GET-then-SET).
 * Records are hashes {rev, lock, lockUntil, data, exp} with PEXPIREAT = exp.
 */

/** KEYS[1]=key. ARGV: rev, data, expiresAtMs. */
export const CREATE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'exists' end
redis.call('HSET', KEYS[1], 'rev', ARGV[1], 'lock', '', 'lockUntil', '0', 'data', ARGV[2], 'exp', ARGV[3])
redis.call('PEXPIREAT', KEYS[1], ARGV[3])
return 'ok'
`;

/** KEYS[1]=key. Returns {rev, lock, lockUntil, data, exp} or nil fields when absent. */
export const READ_SCRIPT = `
return redis.call('HMGET', KEYS[1], 'rev', 'lock', 'lockUntil', 'data', 'exp')
`;

/**
 * KEYS[1]=key. ARGV: expectedRev, expectedLock ('' = none), nowMs,
 * nextRev, nextLock ('' = none), nextLockUntil, nextData, nextExpiresAtMs.
 */
export const CAS_SCRIPT = `
local cur = redis.call('HMGET', KEYS[1], 'rev', 'lock', 'lockUntil', 'exp')
if not cur[1] then return 'missing' end
local now = tonumber(ARGV[3])
if tonumber(cur[4]) <= now then return 'missing' end
if cur[1] ~= ARGV[1] then return 'conflict' end
local lock = cur[2] or ''
local lockUntil = tonumber(cur[3] or '0') or 0
if lock ~= '' and lockUntil > now and lock ~= ARGV[2] then return 'locked' end
if ARGV[2] ~= '' and lock ~= ARGV[2] then return 'conflict' end
redis.call('HSET', KEYS[1], 'rev', ARGV[4], 'lock', ARGV[5], 'lockUntil', ARGV[6], 'data', ARGV[7], 'exp', ARGV[8])
redis.call('PEXPIREAT', KEYS[1], ARGV[8])
return 'ok'
`;

/** The one SDK method this adapter needs (matches @upstash/redis `Redis#eval`). */
export type EvalClient = {
  eval<TArgs extends unknown[], TData = unknown>(script: string, keys: string[], args: TArgs): Promise<TData>;
  del(...keys: string[]): Promise<number>;
};

async function guarded<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    // Log the failure class only; driver errors can include URLs.
    logEvent("error", "session_store.redis_error", { op, error: error instanceof Error ? error.name : "unknown" });
    throw storeUnavailable();
  }
}

const CAS_RESULTS = new Set<CasResult>(["ok", "conflict", "locked", "missing"]);

export function createRedisSessionStore(client: EvalClient): SessionStore {
  return {
    kind: "redis",

    async create(id, record) {
      const result = await guarded("create", () =>
        client.eval<string[], string>(CREATE_SCRIPT, [sessionKey(id)], [String(record.revision), record.data, String(record.expiresAt)]),
      );
      if (result !== "ok" && result !== "exists") throw storeUnavailable();
      return result;
    },

    async read(id, now) {
      const raw = await guarded("read", () => client.eval<[], Array<string | null>>(READ_SCRIPT, [sessionKey(id)], []));
      if (!Array.isArray(raw) || raw[0] === null || raw[0] === undefined) return null;
      const [rev, lock, lockUntil, data, exp] = raw;
      const record: StoredSession = {
        revision: Number(rev),
        lockId: lock ? lock : null,
        lockUntil: Number(lockUntil ?? 0),
        data: data ?? "",
        expiresAt: Number(exp),
      };
      if (!Number.isInteger(record.revision) || !Number.isFinite(record.expiresAt) || !record.data) throw storeUnavailable();
      return now >= record.expiresAt ? null : record;
    },

    async compareAndSwap(id, expect, next, now) {
      const result = await guarded("cas", () =>
        client.eval<string[], string>(CAS_SCRIPT, [sessionKey(id)], [
          String(expect.revision),
          expect.lockId ?? "",
          String(now),
          String(next.revision),
          next.lockId ?? "",
          String(next.lockUntil),
          next.data,
          String(next.expiresAt),
        ]),
      );
      if (!CAS_RESULTS.has(result as CasResult)) throw storeUnavailable();
      return result as CasResult;
    },

    async expire(id) {
      await guarded("expire", () => client.del(sessionKey(id)));
    },
  };
}
