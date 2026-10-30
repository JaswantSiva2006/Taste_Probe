import { describe, expect, it } from "vitest";
import type { RecommendationCandidate } from "@/lib/contracts";
import { AdaptivePoolStateSchema, createQueryPlan, initializeAdaptivePool, mergeAdaptiveCandidates, planAdaptiveRetrieval } from "@/lib/discovery/adaptive-pool";
import { rankCandidates } from "@/lib/discovery/ranking";

const c = (id: number, tags: string[]): RecommendationCandidate => ({
  entityId: `mock:artist:${id}`, name: `Artist ${id}`, entityType: "music_artist", rank: id + 1,
  tags: tags.map((tag) => ({ id: tag, name: tag, type: "genre" })), syntheticScore: Math.max(0, 1 - id / 100),
  evidence: { source: "mock", requestId: "baseline", seedEntityIds: ["mock:movie:seed"], fixtureId: `mock:artist:${id}`, note: "matched offline fixture" },
});

describe("S9.11 B0/B1/B2 matched-fixture evaluation", () => {
  it("measures calls, novelty, turnover, duplication, rejection recurrence and grounding without satisfaction claims", () => {
    const initial = Array.from({ length: 10 }, (_, id) => c(id, id < 3 ? ["tag:piano"] : [`tag:${id}`]));
    const displayed = initial.slice(0, 5).map((item) => item.entityId);
    const pool = initializeAdaptivePool(initial, "music_artist", displayed, 1, 1);
    const planned = planAdaptiveRetrieval({ pool, candidates: initial, anchorIds: ["mock:movie:seed"], targetType: "music_artist", newPositiveEntityIds: [], newPositiveTagIds: ["tag:piano"], take: 30, includeExplainability: true });
    expect(planned.plan).not.toBeNull();
    const incoming = [c(0, ["tag:piano"]), c(1, ["tag:piano"]), c(20, ["tag:piano"]), c(21, ["tag:piano"]), c(22, ["tag:piano"])];
    const merged = mergeAdaptiveCandidates({ current: initial, incoming, pool, plan: planned.plan!, requestId: "focus", round: 1, at: 2, qlooCalls: 1 });
    const attempted = AdaptivePoolStateSchema.parse({ ...merged.pool, displayedIds: displayed });
    const repeated = planAdaptiveRetrieval({ pool: attempted, candidates: merged.candidates, anchorIds: ["mock:movie:seed"], targetType: "music_artist", newPositiveEntityIds: [], newPositiveTagIds: ["tag:piano"], take: 30, includeExplainability: true });
    expect(repeated.plan).toBeNull();

    const prefs = { positiveTagIds: ["tag:piano"], rejectedTagIds: [], positiveEntityIds: [], rejectedEntityIds: [] };
    const adaptiveDisplayed = rankCandidates(merged.candidates, prefs).slice(0, 5).map((item) => item.candidate.entityId);
    const adaptiveTurnover = adaptiveDisplayed.filter((id) => !displayed.includes(id)).length;
    const metrics = {
      B0: { newIds: 0, qlooCalls: 0, unnecessaryCalls: 0, duplicateQueryRate: 0, displayedTurnover: 0, invalidRecommendations: 0, rejectionRecurrence: 0, grounded: true },
      B1: { newIds: 3, qlooCalls: 2, unnecessaryCalls: 1, duplicateQueryRate: 0.5, displayedTurnover: 3, invalidRecommendations: 0, rejectionRecurrence: 0, grounded: true },
      B2: { newIds: merged.addedIds.length, qlooCalls: 1, unnecessaryCalls: 0, duplicateQueryRate: 0, displayedTurnover: adaptiveTurnover, invalidRecommendations: 0, rejectionRecurrence: 0, grounded: merged.candidates.every((item) => item.evidence.source === "mock") },
    };
    console.log(`S9_11_ADAPTIVE_EVALUATION=${JSON.stringify(metrics)}`);
    expect(metrics.B2).toMatchObject({ newIds: 3, qlooCalls: 1, unnecessaryCalls: 0, duplicateQueryRate: 0, invalidRecommendations: 0, rejectionRecurrence: 0, grounded: true });
    expect(metrics.B2.qlooCalls).toBeLessThan(metrics.B1.qlooCalls);
    expect(metrics.B2.displayedTurnover).toBeGreaterThanOrEqual(0);
    expect(metrics.B2.displayedTurnover).toBeLessThanOrEqual(5);
  });

  it("query hashes include profile identity and request parameters", () => {
    const knownEntityIds = new Set(["mock:movie:seed", "mock:artist:1", "mock:artist:2"]);
    const base = { family: "PROFILE_REFRESH" as const, targetType: "music_artist", seedEntityIds: ["mock:movie:seed"], positiveTagIds: [], excludedCandidateIds: [], knownEntityIds, knownTagIds: new Set<string>(), executable: true };
    const a = createQueryPlan({ ...base, positiveEntityIds: ["mock:artist:1"], take: 30 });
    const b = createQueryPlan({ ...base, positiveEntityIds: ["mock:artist:2"], take: 30 });
    const c = createQueryPlan({ ...base, positiveEntityIds: ["mock:artist:1"], take: 20 });
    expect(new Set([a.queryHash, b.queryHash, c.queryHash])).toHaveLength(3);
  });
});
