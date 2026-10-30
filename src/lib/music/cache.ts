import { Redis } from "@upstash/redis";
import type { AppConfig } from "@/lib/config/env";
import { normalizeName, type DynamicLookup, type DynamicOutcome } from "./youtube-data";

/**
 * S9.9 per-artist cache for Tier B (YouTube Data API) outcomes, keyed by the verified
 * Qloo artist ID. It keeps the chosen video stable for an artist (search results vary
 * between calls) and stops repeat lookups from spending quota. A hit is checked before
 * the quota guard, so it costs nothing.
 *
 * Only definite outcomes are stored: a resolved video (24 h) or "nothing confirmable"
 * (6 h). Quota refusals and upstream failures are never cached. Entries expire on their
 * own, so API-derived titles are not kept indefinitely; a cached entry whose artist
 * name no longer matches is ignored.
 */

export const RESOLVED_TTL_MS = 24 * 3_600_000;
export const NEGATIVE_TTL_MS = 6 * 3_600_000;

type Cached = Exclude<DynamicOutcome, { kind: "quota" } | { kind: "failed" }>;
type Entry = { artistName: string; outcome: Cached };

export interface LookupCache {
  get(key: string): Promise<Entry | null>;
  set(key: string, value: Entry, ttlMs: number): Promise<void>;
}

export function createMemoryLookupCache(now = () => Date.now()): LookupCache {
  const entries = new Map<string, { value: Entry; expiresAt: number }>();
  return {
    async get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return structuredClone(hit.value);
    },
    async set(key, value, ttlMs) {
      if (entries.size > 2_000) for (const [k, v] of entries) if (v.expiresAt <= now()) entries.delete(k);
      entries.set(key, { value: structuredClone(value), expiresAt: now() + ttlMs });
    },
  };
}

export function createRedisLookupCache(client: Pick<Redis, "get" | "set">): LookupCache {
  return {
    async get(key) {
      try {
        return (await client.get<Entry>(key)) ?? null;
      } catch {
        return null; // a cache outage only costs a lookup, never a failure
      }
    },
    async set(key, value, ttlMs) {
      try {
        await client.set(key, value, { px: ttlMs });
      } catch {}
    },
  };
}

const GLOBAL_KEY = Symbol.for("tasteprobe.musicLookupCache");

/** Same backing store as sessions and rate limits: Redis in production, memory otherwise. */
export function lookupCacheFor(config: AppConfig): LookupCache {
  const g = globalThis as unknown as Record<symbol, Map<string, LookupCache> | undefined>;
  const caches = (g[GLOBAL_KEY] ??= new Map());
  const id = config.sessionStore.kind === "memory" ? "memory" : config.sessionStore.url;
  const existing = caches.get(id);
  if (existing) return existing;
  const cache =
    config.sessionStore.kind === "memory"
      ? createMemoryLookupCache()
      : createRedisLookupCache(
          new Redis({ url: config.sessionStore.url, token: config.sessionStore.token, retry: false, automaticDeserialization: true, signal: () => AbortSignal.timeout(3_000) }),
        );
  caches.set(id, cache);
  return cache;
}

/** Bump whenever the verifier admits a new identity class or changes negative semantics. */
export const RESOLVER_POLICY_VERSION = "v2-topic-vevo";
export const lookupCacheKey = (artistId: string) => `tp:yt:artist:${RESOLVER_POLICY_VERSION}:${artistId}`;

/** Wraps a lookup with the per-artist cache (outermost: a hit never touches quota). */
export function cachedLookup(inner: DynamicLookup, cache: LookupCache): DynamicLookup {
  return {
    ...(inner.lookupBatch ? { async lookupBatch(artists, explorationId) {
      const out: Record<string, DynamicOutcome | null> = {};
      const missing = [];
      for (const artist of artists.slice(0, 6)) {
        const hit = await cache.get(lookupCacheKey(artist.entityId));
        if (hit && normalizeName(hit.artistName) === normalizeName(artist.name)) out[artist.entityId] = { ...hit.outcome, cached: true };
        else missing.push(artist);
      }
      if (missing.length) {
        const found = await inner.lookupBatch!(missing, explorationId);
        for (const artist of missing) {
          const result = found[artist.entityId] ?? null; out[artist.entityId] = result;
          // Incomplete OR-query coverage must NEVER poison a single-artist negative cache.
          if (result?.kind === "resolved") await cache.set(lookupCacheKey(artist.entityId), { artistName: artist.name, outcome: result }, RESOLVED_TTL_MS);
        }
      }
      return out;
    } } : {}),
    async peek(artist) {
      const hit = await cache.get(lookupCacheKey(artist.entityId));
      return hit && normalizeName(hit.artistName) === normalizeName(artist.name) ? { ...hit.outcome, cached: true } : null;
    },
    async lookup(artist, explorationId) {
      const hit = await cache.get(lookupCacheKey(artist.entityId));
      if (hit && normalizeName(hit.artistName) === normalizeName(artist.name)) return { ...hit.outcome, cached: true };
      const outcome = await inner.lookup(artist, explorationId);
      if (outcome.kind === "resolved" || outcome.kind === "ambiguous" || outcome.kind === "none") {
        const plain = { ...outcome };
        delete plain.cached;
        await cache.set(lookupCacheKey(artist.entityId), { artistName: artist.name, outcome: plain }, outcome.kind === "resolved" ? RESOLVED_TTL_MS : NEGATIVE_TTL_MS);
      }
      return outcome;
    },
  };
}
