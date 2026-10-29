import { describe, expect, it } from "vitest";
import { createLiveQlooProvider, getQlooProvider } from "@/lib/qloo";
import { MOCK_RECOMMENDATIONS, MOCK_SEARCH_ENTITIES } from "@/lib/qloo/fixtures";
import { createMockQlooProvider } from "@/lib/qloo/mock-provider";
import { AppError } from "@/lib/validation/errors";

describe("mock Qloo provider", () => {
  const provider = createMockQlooProvider();

  it("finds Interstellar as a mock movie", async () => {
    const result = await provider.searchEntities("interstellar", "movie");
    expect(result.provenance).toBe("mock");
    expect(result.requestId).toMatch(/^mock-/);
    expect(result.payload.results.map((r) => r.entity_id)).toContain("mock:movie:interstellar");
    expect(result.payload.results.every((r) => r.types.includes("urn:entity:movie"))).toBe(true);
  });

  it("returns no results for unknown queries", async () => {
    expect((await provider.searchEntities("zzz-not-a-title")).payload.results).toEqual([]);
  });

  it("resolves known IDs and returns null for unknown IDs", async () => {
    expect((await provider.getEntity("mock:movie:interstellar")).payload?.name).toBe("Interstellar");
    expect((await provider.getEntity("mock:movie:unknown")).payload).toBeNull();
  });

  it("returns deterministic book recommendations, capped by take", async () => {
    const req = { seedEntityIds: ["mock:movie:interstellar"], targetType: "book" as const, take: 4 };
    const a = await provider.getRecommendations(req);
    const b = await provider.getRecommendations(req);
    expect(a.payload.results.entities).toHaveLength(4);
    expect(a.payload.results.entities).toEqual(b.payload.results.entities);
  });

  it("returns copies, so callers cannot mutate fixtures", async () => {
    const r = await provider.getRecommendations({ seedEntityIds: ["mock:movie:interstellar"], targetType: "book", take: 10 });
    r.payload.results.entities[0]!.name = "changed";
    expect(MOCK_RECOMMENDATIONS["mock:movie:interstellar"]!.book![0]!.name).not.toBe("changed");
  });

  it("uses only mock-namespaced IDs in fixtures", () => {
    const ids = [
      ...MOCK_SEARCH_ENTITIES.map((e) => e.entity_id),
      ...Object.values(MOCK_RECOMMENDATIONS).flatMap((byType) =>
        Object.values(byType).flatMap((list) => list!.flatMap((e) => [e.entity_id, ...(e.tags ?? []).map((t) => t.tag_id)])),
      ),
    ];
    expect(ids.length).toBeGreaterThan(5);
    expect(ids.every((id) => id.startsWith("mock:"))).toBe(true);
  });
});

describe("live Qloo provider placeholder", () => {
  it("fails explicitly instead of returning fixtures", async () => {
    const live = createLiveQlooProvider();
    expect(live.mode).toBe("live");
    for (const call of [
      () => live.searchEntities("Interstellar"),
      () => live.getEntity("mock:movie:interstellar"),
      () => live.getRecommendations({ seedEntityIds: ["mock:movie:interstellar"], targetType: "book", take: 5 }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "LIVE_PROVIDER_NOT_IMPLEMENTED", status: 501 });
      await expect(call()).rejects.toBeInstanceOf(AppError);
    }
  });

  it("is selected by live mode", () => {
    expect(getQlooProvider({ mode: "live" }).mode).toBe("live");
    expect(getQlooProvider({ mode: "mock" }).mode).toBe("mock");
  });
});
