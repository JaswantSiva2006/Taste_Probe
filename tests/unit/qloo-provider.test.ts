import { describe, expect, it, vi } from "vitest";
import { createLiveQlooProvider, getQlooProvider } from "@/lib/qloo";
import { buildInsightsUrl, parseInsightsResponse, parseSearchResponse } from "@/lib/qloo/live-provider";
import { normalizeRecommendations } from "@/lib/discovery/normalize";
import { MOCK_RECOMMENDATIONS, MOCK_SEARCH_ENTITIES } from "@/lib/qloo/fixtures";
import { createMockQlooProvider } from "@/lib/qloo/mock-provider";
import { AppError } from "@/lib/validation/errors";
import searchFixture from "../fixtures/qloo-search.json";
import insightsFixture from "../fixtures/qloo-insights.json";

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
        Object.values(byType).flatMap((list) => list!.flatMap((e) => [e.entity_id, ...(e.tags ?? []).flatMap((t) => t.tag_id ? [t.tag_id] : [])])),
      ),
    ];
    expect(ids.length).toBeGreaterThan(5);
    expect(ids.every((id) => id.startsWith("mock:"))).toBe(true);
  });
});

const liveConfig = { qloo: { apiKey: "test-key", baseUrl: "https://hackathon.api.qloo.com", timeoutMs: 100 } };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("live Qloo parsing and normalization", () => {
  it("parses Search results, Search tag_id, ordering, and drops malformed entities", () => {
    const parsed = parseSearchResponse(searchFixture);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toMatchObject({ entity_id: "057DA9D9-399B-437E-8BCA-A80E499125EF", tags: [{ tag_id: "urn:tag:genre:media:science_fiction" }] });
  });

  it("parses Insights tag id, optional metadata and explainability, then deduplicates stably", () => {
    const payload = parseInsightsResponse(insightsFixture);
    expect(payload.results.entities).toHaveLength(3);
    expect(payload.results.entities[0]).toMatchObject({ tags: [{ id: "urn:tag:genre:media:science_fiction" }], query: { affinity: 0.91 } });
    expect(payload.results.entities[1]).toMatchObject({ tags: [] });
    expect(payload.results.entities[1]?.properties).toBeUndefined();
    const normalized = normalizeRecommendations({ provenance: "qloo", requestId: "00000000-0000-4000-8000-000000000001", requestCount: 1, payload }, ["seed"], 10);
    expect(normalized).toHaveLength(2);
    expect(normalized.map((item) => item.rank)).toEqual([1, 2]);
    expect(normalized[0]).toMatchObject({ affinity: 0.91, evidence: { source: "qloo", explainability: { signal: { interests: {} } } } });
    expect(normalized[1]).not.toHaveProperty("description");
    expect(normalized[1]).not.toHaveProperty("imageUrl");
  });

  it("accepts empty valid lists and rejects malformed top-level responses", () => {
    expect(parseSearchResponse({ results: [] })).toEqual({ results: [] });
    expect(parseInsightsResponse({ success: true, results: { entities: [] } }).results.entities).toEqual([]);
    expect(() => parseSearchResponse({ entities: [] })).toThrowError(expect.objectContaining({ code: "QLOO_INVALID_RESPONSE" }));
    expect(() => parseInsightsResponse({ results: [] })).toThrowError(expect.objectContaining({ code: "QLOO_INVALID_RESPONSE" }));
  });
});

describe("live Qloo request construction and network handling", () => {
  it("constructs verified positive signals, exclusions, explainability, and bounded take", () => {
    const url = buildInsightsUrl(liveConfig.qloo.baseUrl, {
      seedEntityIds: ["seed"], positiveEntityIds: ["positive"], positiveTagIds: ["tag+one"],
      excludedEntityIds: ["excluded"], excludedTagIds: ["tag/excluded"], targetType: "book", take: 99,
      includeExplainability: true,
    });
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "filter.type": "urn:entity:book", "signal.interests.entities": "seed,positive",
      "signal.interests.tags": "tag+one", "filter.exclude.entities": "excluded",
      "filter.exclude.tags": "tag/excluded", take: "50", "feature.explainability": "true",
    });
  });

  it("authenticates Search and creates an application UUID correlation ID", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(searchFixture));
    const result = await createLiveQlooProvider(liveConfig, fetcher).searchEntities(" Interstellar ", "movie");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain("query=Interstellar&type=urn%3Aentity%3Amovie");
    expect(init?.headers).toMatchObject({ "X-Api-Key": "test-key" });
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result).toMatchObject({ provenance: "qloo", requestCount: 1 });
  });

  it.each([[401, "QLOO_AUTH_ERROR"], [403, "QLOO_PERMISSION_ERROR"], [400, "QLOO_BAD_REQUEST"], [429, "QLOO_RATE_LIMITED"]])(
    "maps HTTP %i without retry", async (status, code) => {
      const fetcher = vi.fn(async () => jsonResponse({}, status));
      await expect(createLiveQlooProvider(liveConfig, fetcher).searchEntities("x", "movie")).rejects.toMatchObject({ code });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("retries a transient 5xx once and reports the actual request count", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({}, 503)).mockResolvedValueOnce(jsonResponse(searchFixture));
    const result = await createLiveQlooProvider(liveConfig, fetcher).searchEntities("x", "movie");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.requestCount).toBe(2);
  });

  it("does not retry 5xx when the caller has one attempt left", async () => {
    const fetcher = vi.fn(async () => jsonResponse({}, 503));
    await expect(createLiveQlooProvider(liveConfig, fetcher).getRecommendations({ seedEntityIds: ["seed"], targetType: "book", take: 5, maxAttempts: 1 })).rejects.toMatchObject({ code: "QLOO_UPSTREAM_ERROR" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("maps timeout and invalid JSON safely", async () => {
    const timeout = vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); });
    await expect(createLiveQlooProvider(liveConfig, timeout).searchEntities("x")).rejects.toMatchObject({ code: "QLOO_TIMEOUT" });
    const invalidJson = vi.fn(async () => new Response("not-json", { status: 200 }));
    await expect(createLiveQlooProvider(liveConfig, invalidJson).searchEntities("x")).rejects.toMatchObject({ code: "QLOO_INVALID_RESPONSE" });
  });

  it("requires safe live configuration and selects providers by mode", () => {
    expect(() => createLiveQlooProvider({ qloo: { timeoutMs: 100 } })).toThrowError(expect.objectContaining({ code: "CONFIG_ERROR" }));
    expect(() => createLiveQlooProvider({ qloo: { apiKey: "x", baseUrl: "http://example.test", timeoutMs: 100 } })).toThrowError(AppError);
    expect(getQlooProvider({ mode: "live", ...liveConfig }).mode).toBe("live");
    expect(getQlooProvider({ mode: "mock", ...liveConfig }).mode).toBe("mock");
  });
});
