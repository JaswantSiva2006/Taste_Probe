import "server-only";
import { createHmac } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { AppConfig } from "@/lib/config/env";
import { AppError } from "@/lib/validation/errors";

/** S9.6: "continue" opens a new paid round, so it is limited like "start" (own bucket, same max). */
/** S9.9: "resolve" (music video lookup) is read-only and has its own bucket. */
export type RateLimitAction = "search" | "start" | "answer" | "continue" | "resolve" | "listen";
export type RateLimitResult = { count: number; resetAt: number };
export interface RateLimitStore {
  increment(key: string, windowMs: number, now: number): Promise<RateLimitResult>;
}

const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

export function createMemoryRateLimitStore(): RateLimitStore {
  const entries = new Map<string, RateLimitResult>();
  return {
    async increment(key, windowMs, now) {
      if (entries.size > 10_000) for (const [k, value] of entries) if (value.resetAt <= now) entries.delete(k);
      const current = entries.get(key);
      const next = !current || current.resetAt <= now
        ? { count: 1, resetAt: now + windowMs }
        : { count: current.count + 1, resetAt: current.resetAt };
      entries.set(key, next);
      return next;
    },
  };
}

export function createRedisRateLimitStore(client: Pick<Redis, "eval">): RateLimitStore {
  return {
    async increment(key, windowMs, now) {
      try {
        const raw = await client.eval(SCRIPT, [key], [windowMs]) as [number, number];
        const count = Number(raw[0]);
        const ttl = Number(raw[1]);
        if (!Number.isInteger(count) || !Number.isFinite(ttl)) throw new Error("invalid rate-limit response");
        return { count, resetAt: now + Math.max(0, ttl) };
      } catch {
        throw new AppError("SESSION_STORE_UNAVAILABLE", 503, "Request protection is temporarily unavailable");
      }
    },
  };
}

const GLOBAL_KEY = Symbol.for("tasteprobe.rateLimitStores");
type StoreCache = { memory?: RateLimitStore; redis?: Map<string, RateLimitStore> };
function cache(): StoreCache {
  const value = globalThis as unknown as Record<symbol, StoreCache | undefined>;
  return (value[GLOBAL_KEY] ??= {});
}

/** The shared limiter store (Redis in production); S9.9 also keeps YouTube quota counters here. */
export function rateLimitStoreFor(config: AppConfig): RateLimitStore {
  const c = cache();
  if (config.sessionStore.kind === "memory") return (c.memory ??= createMemoryRateLimitStore());
  c.redis ??= new Map();
  const existing = c.redis.get(config.sessionStore.url);
  if (existing) return existing;
  const client = new Redis({
    url: config.sessionStore.url, token: config.sessionStore.token, retry: false,
    automaticDeserialization: true, signal: () => AbortSignal.timeout(5_000),
  });
  const store = createRedisRateLimitStore(client);
  c.redis.set(config.sessionStore.url, store);
  return store;
}

function sourceIdentity(request: Request, config: AppConfig): string {
  let value = "shared-anonymous";
  if (process.env.VERCEL === "1") value = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || value;
  else if (config.rateLimit.trustedProxyIpHeader) value = request.headers.get(config.rateLimit.trustedProxyIpHeader)?.split(",")[0]?.trim() || value;
  return createHmac("sha256", config.session.signingSecret).update(value).digest("hex").slice(0, 32);
}

export async function enforceRateLimit(
  request: Request,
  config: AppConfig,
  action: RateLimitAction,
  options: { store?: RateLimitStore; now?: number } = {},
): Promise<void> {
  if (!config.rateLimit.enabled) return;
  const max =
    action === "search" ? config.rateLimit.searchMax
      : action === "start" || action === "continue" ? config.rateLimit.startMax
      : action === "resolve" || action === "listen" ? config.rateLimit.resolveMax
      : config.rateLimit.answerMax;
  const now = options.now ?? Date.now();
  const windowMs = config.rateLimit.windowSeconds * 1_000;
  const key = `tp:rl:${action}:${sourceIdentity(request, config)}`;
  const result = await (options.store ?? rateLimitStoreFor(config)).increment(key, windowMs, now);
  if (result.count > max) {
    const retry = Math.max(1, Math.ceil((result.resetAt - now) / 1_000));
    throw new AppError("RATE_LIMITED", 429, "Too many requests; try again later", retry);
  }
}
