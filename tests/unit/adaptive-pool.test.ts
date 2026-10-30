import { describe, expect, it } from "vitest";
import type { RecommendationCandidate } from "@/lib/contracts";
import { ADAPTIVE_POOL_MAX_CANDIDATES, AdaptivePoolStateSchema, createQueryPlan, evaluatePool, initializeAdaptivePool, selectLocalReplacements, synchronizeAdaptivePool } from "@/lib/discovery/adaptive-pool";
import { loadConfig } from "@/lib/config/env";
import { startDiscovery } from "@/lib/discovery/service";
import { createSessionService } from "@/lib/session/service";
import { interstellarStart, testConfig, testDeps } from "../helpers";

const candidate = (n: number, tags = [`tag:${n % 4}`]): RecommendationCandidate => ({
  entityId: `candidate:${n}`, name: `Candidate ${n}`, entityType: "music_artist", rank: n + 1,
  description: `Verified description ${n}`,
  tags: tags.map((id) => ({ id, name: id, type: "genre" })), syntheticScore: 1 - n / 100,
  evidence: { source: "mock", requestId: "request-1", seedEntityIds: ["seed:1"], fixtureId: `mock:candidate:${n}`, note: "test fixture" },
});

describe("adaptive candidate-pool foundation", () => {
  it("is disabled by default and explicitly opt-in", () => {
    const base = { NODE_ENV: "test", QLOO_MODE: "mock", SESSION_SIGNING_SECRET: "x".repeat(32) };
    expect(loadConfig(base).features.adaptivePool).toBe(false);
    expect(loadConfig({ ...base, ADAPTIVE_POOL_ENABLED: "true" }).features.adaptivePool).toBe(true);
  });

  it("stores the optional reservoir in the existing signed session and leaves disabled sessions unchanged", async () => {
    for (const enabled of [false, true]) {
      const config = testConfig({ ADAPTIVE_POOL_ENABLED: String(enabled) });
      const deps = testDeps({ config });
      const view = await startDiscovery(deps, interstellarStart);
      const sessions = createSessionService({ store: deps.store, settings: config.session, mode: config.mode });
      const loaded = await sessions.load(view.sessionToken);
      expect(Boolean(loaded.state.adaptivePool)).toBe(enabled);
      if (enabled) expect(loaded.state.adaptivePool?.entries.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("persists a bounded, validated 90-candidate reservoir with compact verified metadata", () => {
    const pool = initializeAdaptivePool(Array.from({ length: 100 }, (_, i) => candidate(i)), "music_artist", ["candidate:0", "candidate:1"], 1, 10);
    expect(pool.entries).toHaveLength(ADAPTIVE_POOL_MAX_CANDIDATES);
    expect(AdaptivePoolStateSchema.parse(JSON.parse(JSON.stringify(pool)))).toEqual(pool);
    expect(Buffer.byteLength(JSON.stringify(pool))).toBeLessThan(100_000);
  });

  it("keeps an adequate slate without forced churn and protects pins", () => {
    const base = initializeAdaptivePool(Array.from({ length: 12 }, (_, i) => candidate(i)), "music_artist", Array.from({ length: 5 }, (_, i) => `candidate:${i}`), 1, 10);
    const pool = AdaptivePoolStateSchema.parse({ ...base, pinnedIds: ["candidate:4"] });
    expect(evaluatePool(pool)).toEqual({ decision: "KEEP", reasons: ["current_slate_is_adequate"] });
    expect(selectLocalReplacements(pool)).toEqual(["candidate:4", "candidate:0", "candidate:1", "candidate:2", "candidate:3"]);
  });

  it("locally replaces a rejected recommendation, never returns it, and keeps tag dislike distinct", () => {
    const base = initializeAdaptivePool(Array.from({ length: 8 }, (_, i) => candidate(i)), "music_artist", Array.from({ length: 5 }, (_, i) => `candidate:${i}`), 1, 10);
    const updated = synchronizeAdaptivePool(base, { displayedIds: base.displayedIds, presentedIds: [], rejectedIds: ["candidate:1"], round: 2, at: 20 });
    expect(evaluatePool(updated).decision).toBe("LOCAL_REPLACE");
    expect(selectLocalReplacements(updated)).toEqual(["candidate:0", "candidate:2", "candidate:3", "candidate:4", "candidate:5"]);
    expect(selectLocalReplacements(updated)).not.toContain("candidate:1");
  });

  it("returns deterministic adequacy outcomes for small, weak, and exhausted pools", () => {
    const small = initializeAdaptivePool(Array.from({ length: 3 }, (_, i) => candidate(i)), "music_artist", ["candidate:0"], 1, 1);
    expect(evaluatePool(small).decision).toBe("FETCH_AND_MERGE");
    const weak = initializeAdaptivePool(Array.from({ length: 6 }, (_, i) => candidate(i, [])), "music_artist", Array.from({ length: 5 }, (_, i) => `candidate:${i}`), 1, 1);
    expect(evaluatePool(weak).decision).toBe("EXPAND");
    const exhausted = AdaptivePoolStateSchema.parse({ ...small, rejectedIds: small.entries.map((entry) => entry.candidateId) });
    expect(evaluatePool(exhausted).decision).toBe("DEGRADED_KEEP");
  });

  it("builds typed, deduplicated, non-executable plans from validated IDs and tags", () => {
    const knownEntityIds = new Set(["seed:1", "candidate:1"]); const knownTagIds = new Set(["tag:1"]);
    const input = { family: "TAG_FOCUS" as const, targetType: "music_artist", seedEntityIds: ["seed:1", "seed:1"], positiveTagIds: ["tag:1"], excludedCandidateIds: ["candidate:1"], knownEntityIds, knownTagIds };
    const a = createQueryPlan(input); const b = createQueryPlan(input);
    expect(a).toMatchObject({ family: "TAG_FOCUS", executable: false, seedEntityIds: ["seed:1"] });
    expect(a.queryHash).toBe(b.queryHash);
    expect(() => createQueryPlan({ ...input, positiveTagIds: ["invented"] })).toThrow("query_plan_unknown_tag");
    expect(() => createQueryPlan({ ...input, family: "PAGINATE", cursor: undefined })).toThrow("query_plan_missing_cursor");
  });

  it("retains round 1-3 history while bounding transition records", () => {
    let pool = initializeAdaptivePool(Array.from({ length: 8 }, (_, i) => candidate(i)), "music_artist", Array.from({ length: 5 }, (_, i) => `candidate:${i}`), 1, 1);
    pool = synchronizeAdaptivePool(pool, { displayedIds: pool.displayedIds, presentedIds: pool.displayedIds, rejectedIds: [], round: 2, at: 2 });
    pool = synchronizeAdaptivePool(pool, { displayedIds: pool.displayedIds.slice(1), presentedIds: pool.displayedIds, rejectedIds: ["candidate:0"], round: 3, at: 3 });
    expect(pool.presentedIds).toHaveLength(5); expect(pool.rejectedIds).toEqual(["candidate:0"]);
    expect(new Set(pool.transitionHistory.map((entry) => entry.round))).toEqual(new Set([1, 2, 3]));
  });
});
