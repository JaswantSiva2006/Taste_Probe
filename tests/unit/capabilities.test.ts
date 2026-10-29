import { describe, expect, it, vi } from "vitest";
import {
  DOMAINS,
  DOMAIN_PAIRS,
  EntityTypeSchema,
  PublicCapabilitiesSchema,
  QLOO_WIRE_TYPES,
  SESSION_DOMAINS,
  StartRequestSchema,
  domainLabel,
  domainLanguageOfPlural,
  enabledSourceDomains,
  isEnabledPair,
  pairStatus,
  publicCapabilities,
  registryProblems,
  sessionDomainOfQlooType,
} from "@/lib/contracts";
import { deterministicTagWording, isSemanticallyFaithfulTagWording } from "@/lib/agent/question-generation/renderer";
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
    expect(pub).toEqual({ pairs: [{ source: "movie", target: "book", sourceLabel: "movie", targetLabel: "books" }] });
    expect(JSON.stringify(pub)).not.toMatch(/urn:|music_artist|evidence|enabled/);
    expect(enabledSourceDomains()).toEqual(["movie"]);
  });
});

describe("registry extensibility (adding a pair is a local, guarded change)", () => {
  it("the session enum is derived from the registry", () => {
    expect(EntityTypeSchema.options).toEqual([...SESSION_DOMAINS]);
    expect(SESSION_DOMAINS.every((d) => DOMAINS[d].sessionReady)).toBe(true);
    expect(DOMAINS.music_artist.sessionReady).toBe(false);
  });

  it("the shipped registry has no structural problems", () => {
    expect(registryProblems(DOMAIN_PAIRS, DOMAINS)).toEqual([]);
  });

  it("refuses to enable a pair whose domain has no session adapter or no E2E evidence", () => {
    const proposed = DOMAIN_PAIRS.map((p) => (p.source === "music_artist" ? { ...p, enabled: true } : p));
    expect(registryProblems(proposed, DOMAINS)).toEqual([
      "music_artist->book: music_artist has no session adapter",
      "music_artist->book: enabled without FULL_E2E_VERIFIED evidence",
    ]);
  });

  it("an independently configured source/target pair needs only registry rows", () => {
    // Hypothetical book -> movie: both domains are already session-ready, so a
    // verified pair row is the entire change.
    const proposed = [...DOMAIN_PAIRS, { source: "book", target: "movie", enabled: true, evidence: "FULL_E2E_VERIFIED" } as const];
    expect(registryProblems(proposed, DOMAINS)).toEqual([]);
    expect(registryProblems([...DOMAIN_PAIRS, DOMAIN_PAIRS[0]!], DOMAINS)).toContain("duplicate pair");
  });

  it("normalization and nouns come from the registry", () => {
    expect(sessionDomainOfQlooType("urn:entity:book")).toBe("book");
    expect(sessionDomainOfQlooType("urn:entity:movie")).toBe("movie");
    // Registered but not session-ready, and unknown types: never coerced.
    expect(sessionDomainOfQlooType("urn:entity:artist")).toBeUndefined();
    expect(sessionDomainOfQlooType("urn:entity:podcast")).toBeUndefined();
    expect([domainLabel("book"), domainLabel("book", true), domainLabel("music_artist", true)]).toEqual(["book", "books", "music artists"]);
    expect(domainLanguageOfPlural("movies")).toMatchObject({ verb: "watch", narrative: true });
    expect(domainLanguageOfPlural("music artists")).toMatchObject({ verb: "listen to", narrative: false });
  });

  it("question rendering is unchanged for books/movies and follows the registry for other nouns", () => {
    expect(deterministicTagWording("Space Opera", "urn:tag:genre:media", "books")).toBe("Would you like to read more Space Opera?");
    expect(deterministicTagWording("Space Opera", "urn:tag:genre:media", "movies")).toBe("Would you like to watch more Space Opera?");
    expect(deterministicTagWording("Synth Pop", "urn:tag:genre:media", "music artists")).toBe("Would you like to listen to more Synth Pop?");
    expect(isSemanticallyFaithfulTagWording("Do you enjoy books about Space Opera?", "Space Opera", "books")).toBe(true);
    expect(isSemanticallyFaithfulTagWording("Do you enjoy stories about Space Opera?", "Space Opera", "books")).toBe(true);
    // Non-narrative domains do not accept "stories" as a synonym.
    expect(isSemanticallyFaithfulTagWording("Do you enjoy stories about Synth Pop?", "Synth Pop", "music artists")).toBe(false);
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
