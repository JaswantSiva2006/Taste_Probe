import { describe, expect, it, vi } from "vitest";
import {
  DOMAIN_PAIRS,
  PublicCapabilitiesSchema,
  QLOO_WIRE_TYPES,
  StartRequestSchema,
  enabledSourceDomains,
  isEnabledPair,
  pairStatus,
  publicCapabilities,
} from "@/lib/contracts";
import { assertEnabledPair, searchAnchors, startDiscovery } from "@/lib/discovery/service";
import { buildSearchUrl } from "@/lib/qloo/live-provider";
import { createMockQlooProvider } from "@/lib/qloo/mock-provider";
import type { QlooProvider } from "@/lib/qloo/provider";
import { interstellarStart, testDeps } from "../helpers";

function spyProvider(): { provider: QlooProvider; calls: () => number } {
  const inner = createMockQlooProvider();
  const spy = {
    mode: inner.mode,
    searchEntities: vi.fn(inner.searchEntities),
    getEntity: vi.fn(inner.getEntity),
    getRecommendations: vi.fn(inner.getRecommendations),
  } satisfies QlooProvider;
  return {
    provider: spy,
    calls: () => spy.searchEntities.mock.calls.length + spy.getEntity.mock.calls.length + spy.getRecommendations.mock.calls.length,
  };
}

describe("domain capability registry", () => {
  it("enables only movie -> book", () => {
    expect(pairStatus("movie", "book")).toBe("enabled");
    expect(pairStatus("music_artist", "book")).toBe("disabled");
    expect(pairStatus("movie", "music_artist")).toBe("disabled");
    expect(DOMAIN_PAIRS.filter((p) => p.enabled).map((p) => `${p.source}->${p.target}`)).toEqual(["movie->book"]);
  });

  it("treats unregistered pairs and unknown domains as unsupported", () => {
    for (const [s, t] of [["book", "movie"], ["book", "book"], ["movie", "movie"], ["podcast", "book"], ["movie", "podcast"]]) {
      expect(pairStatus(s!, t!)).toBe("unregistered");
      expect(isEnabledPair(s!, t!)).toBe(false);
    }
  });

  it("maps product domains to verified Qloo wire types", () => {
    expect(QLOO_WIRE_TYPES).toEqual({ movie: "urn:entity:movie", book: "urn:entity:book", music_artist: "urn:entity:artist" });
    expect(Object.values(QLOO_WIRE_TYPES)).not.toContain("urn:entity:music_artist");
    expect(buildSearchUrl("https://q.example", "x", "movie").searchParams.get("type")).toBe("urn:entity:movie");
  });

  it("is frozen against runtime mutation", () => {
    expect(Object.isFrozen(DOMAIN_PAIRS)).toBe(true);
    expect(() => {
      (DOMAIN_PAIRS[1] as { enabled: boolean }).enabled = true;
    }).toThrow();
    expect(pairStatus("music_artist", "book")).toBe("disabled");
  });

  it("public projection lists only enabled pairs, without wire types or evidence", () => {
    const pub = PublicCapabilitiesSchema.parse(publicCapabilities());
    expect(pub).toEqual({ pairs: [{ source: "movie", target: "book", sourceLabel: "film", targetLabel: "books" }] });
    expect(JSON.stringify(pub)).not.toMatch(/urn:|music_artist|evidence|enabled/);
    expect(enabledSourceDomains()).toEqual(["movie"]);
  });
});

describe("server-side pair validation", () => {
  it("accepts the legacy movie -> book start body unchanged", () => {
    expect(StartRequestSchema.parse(interstellarStart)).toEqual(interstellarStart);
    expect(() => assertEnabledPair(interstellarStart)).not.toThrow();
  });

  it("schema rejects unsupported domain values and client capability overrides", () => {
    expect(StartRequestSchema.safeParse({ ...interstellarStart, sourceType: "music_artist" }).success).toBe(false);
    expect(StartRequestSchema.safeParse({ ...interstellarStart, targetType: "artist" }).success).toBe(false);
    expect(StartRequestSchema.safeParse({ ...interstellarStart, enabled: true }).success).toBe(false);
    expect(StartRequestSchema.safeParse({ ...interstellarStart, capabilities: { pairs: [] } }).success).toBe(false);
  });

  it("rejects unregistered pairs before any provider call", async () => {
    for (const pair of [
      { sourceType: "book", targetType: "movie" },
      { sourceType: "book", targetType: "book" },
      { sourceType: "movie", targetType: "movie" },
    ] as const) {
      const { provider, calls } = spyProvider();
      await expect(startDiscovery(testDeps({ provider }), { ...interstellarStart, ...pair })).rejects.toMatchObject({
        code: "UNSUPPORTED_DOMAIN",
        status: 400,
      });
      expect(calls()).toBe(0);
    }
  });

  it("rejects a typed anchor search outside enabled sources before any provider call", async () => {
    const { provider, calls } = spyProvider();
    await expect(searchAnchors(testDeps({ provider }), "dune", "book")).rejects.toMatchObject({ code: "UNSUPPORTED_DOMAIN" });
    expect(calls()).toBe(0);
    await expect(searchAnchors(testDeps({ provider }), "interstellar", "movie")).resolves.toMatchObject({ results: expect.any(Array) });
    await expect(searchAnchors(testDeps({ provider }), "interstellar")).resolves.toMatchObject({ results: expect.any(Array) });
  });
});
