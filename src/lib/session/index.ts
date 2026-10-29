import "server-only";
import { Redis } from "@upstash/redis";
import type { AppConfig } from "@/lib/config/env";
import { createMemorySessionStore } from "./memory-store";
import { createRedisSessionStore } from "./redis-store";
import type { SessionStore } from "./store";

export type { SessionStore } from "./store";
export { createSessionService, type SessionService } from "./service";

const REDIS_TIMEOUT_MS = 5_000;
const GLOBAL_KEY = Symbol.for("tasteprobe.sessionStores");

type Cache = { memory?: SessionStore; redis?: Map<string, SessionStore> };

function cache(): Cache {
  const g = globalThis as unknown as Record<symbol, Cache | undefined>;
  return (g[GLOBAL_KEY] ??= {});
}

/**
 * Returns the configured store. Config already guarantees production uses
 * Redis with credentials; memory is only reachable outside production.
 */
export function getSessionStore(config: Pick<AppConfig, "sessionStore">): SessionStore {
  const c = cache();
  const cfg = config.sessionStore;
  if (cfg.kind === "memory") return (c.memory ??= createMemorySessionStore());

  c.redis ??= new Map();
  let store = c.redis.get(cfg.url);
  if (!store) {
    const client = new Redis({
      url: cfg.url,
      token: cfg.token,
      // A transparently retried CAS could report "conflict" for a write that succeeded.
      retry: false,
      automaticDeserialization: false,
      signal: () => AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });
    store = createRedisSessionStore(client);
    c.redis.set(cfg.url, store);
  }
  return store;
}
