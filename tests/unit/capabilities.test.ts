import { describe, expect, it, vi } from "vitest";
import {
  DOMAINS,
  DOMAIN_PAIRS,
  MUSIC_DESTINATION,
  destinationInScope,
  EntityTypeSchema,
  PublicCapabilitiesSchema,
  QLOO_WIRE_TYPES,
  SESSION_DOMAINS,
  StartRequestSchema,
  domainLabel,
  domainLanguageOfPlural,
  enabledSourceDomains,
  isEnabledPair,
  pairAccess,
  pairStatus,
  publicCapabilities,
  registryProblems,
  sessionDomainOfQlooType,
  tagQuestionText,
} from "@/lib/contracts";
import { deterministicTagWording, isSemanticallyFaithfulTagWording, renderTagQuestion } from "@/lib/agent/question-generation/renderer";
import { loadConfig } from "@/lib/config/env";
import { assertEnabledPair, searchAnchors, startDiscovery } from "@/lib/discovery/service";
import { buildInsightsUrl, buildSearchUrl } from "@/lib/qloo/live-provider";
import { createMockQlooProvider } from "@/lib/qloo/mock-provider";
import type { QlooProvider } from "@/lib/qloo/provider";
import { interstellarStart, newTestSecret, testConfig, testDeps } from "../helpers";

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

const SIX = ["movie", "book", "music_artist", "tv_show", "video_game", "podcast"] as const;

describe("domain capability registry", () => {
  it("registers all 30 directed cross-domain pairs and enables only verified ones", () => {
    expect(DOMAIN_PAIRS).toHaveLength(31);
    expect(pairStatus("movie", "book")).toBe("enabled");
    expect(DOMAIN_PAIRS.filter((p) => p.enabled).every((p) => p.evidence === "FULL_E2E_VERIFIED" || (p.target === "music_artist" && p.evidence === "VERIFIED_INSIGHTS"))).toBe(true);
    expect(DOMAIN_PAIRS.find((p) => p.source === "podcast" && p.target === "video_game")).toMatchObject({ enabled: false, evidence: "OFFLINE_MATRIX" });
  });

  it("treats same-domain pairs and unknown domains as unregistered", () => {
    for (const [s, t] of [["book", "book"], ["movie", "movie"], ["magazine", "book"], ["movie", "magazine"]]) {
      expect(pairStatus(s!, t!)).toBe("unregistered");
      expect(isEnabledPair(s!, t!)).toBe(false);
    }
  });

  it("maps product domains to Qloo wire types (artist and videogame are Qloo's spellings)", () => {
    expect(QLOO_WIRE_TYPES).toEqual({
      movie: "urn:entity:movie",
      book: "urn:entity:book",
      music_artist: "urn:entity:artist",
      tv_show: "urn:entity:tv_show",
      video_game: "urn:entity:videogame",
      podcast: "urn:entity:podcast",
    });
    expect(Object.values(QLOO_WIRE_TYPES)).not.toContain("urn:entity:music_artist");
    expect(buildSearchUrl("https://q.example", "x", "music_artist").searchParams.get("type")).toBe("urn:entity:artist");
    expect(buildInsightsUrl("https://q.example", { seedEntityIds: ["S"], targetType: "video_game", take: 5 }).searchParams.get("filter.type")).toBe("urn:entity:videogame");
  });

  it("keeps separate capability levels per domain", () => {
    expect(DOMAINS.movie).toMatchObject({ search: "LIVE_VERIFIED", sessionReady: true });
    expect(DOMAINS.book).toMatchObject({ insightsTarget: "LIVE_VERIFIED" });
    expect(DOMAINS.podcast).toMatchObject({ search: "LIVE_VERIFIED", insightsTarget: "LIVE_VERIFIED", sessionReady: true });
    expect(DOMAINS.book.search).toBe("DOCUMENTED");
  });

  it("is frozen against runtime mutation", () => {
    expect(Object.isFrozen(DOMAIN_PAIRS) && Object.isFrozen(DOMAINS) && Object.isFrozen(DOMAINS.book)).toBe(true);
    const row = DOMAIN_PAIRS.find((p) => p.source === "podcast" && p.target === "book")!;
    expect(() => {
      (row as { enabled: boolean }).enabled = true;
    }).toThrow();
    expect(pairStatus("podcast", "book")).toBe("disabled");
  });

  it("public projection lists only enabled pairs, without wire types, evidence or verification pairs", () => {
    const pub = PublicCapabilitiesSchema.parse(publicCapabilities());
    expect(pub.pairs.every((p) => isEnabledPair(p.source, p.target))).toBe(true);
    // S9.15: music only. The movie -> book pair stays registered and enabled for internal regression, never published.
    expect(pub.pairs.every((p) => p.target === MUSIC_DESTINATION)).toBe(true);
    expect(pub.pairs.map((p) => p.source)).toEqual(["movie", "music_artist", "tv_show", "video_game", "podcast"]);
    expect(pub.pairs.some((p) => p.source === "book" || p.target === "book")).toBe(false);
    expect(isEnabledPair("movie", "book")).toBe(true);
    expect(JSON.stringify(pub)).not.toMatch(/urn:|evidence|enabled|OFFLINE|VERIFIED/);
    expect(new Set(enabledSourceDomains())).toEqual(new Set(pub.pairs.map((p) => p.source)));
  });

  it("music-only scope refuses every non-music destination; legacy scope keeps internal regression paths", () => {
    expect(destinationInScope("music_artist", "music_only")).toBe(true);
    expect(destinationInScope("book", "music_only")).toBe(false);
    expect(destinationInScope("tv_show", "music_only")).toBe(false);
    expect(destinationInScope("book", "legacy_generic")).toBe(true);
  });
});

describe("registry extensibility (adding a pair is a local, guarded change)", () => {
  it("the session enum is derived from the registry", () => {
    expect(EntityTypeSchema.options).toEqual([...SESSION_DOMAINS]);
    expect([...SESSION_DOMAINS]).toEqual([...SIX]);
    expect(SESSION_DOMAINS.every((d) => DOMAINS[d].sessionReady)).toBe(true);
  });

  it("the shipped registry has no structural problems", () => {
    expect(registryProblems(DOMAIN_PAIRS, DOMAINS)).toEqual([]);
  });

  it("refuses to enable a pair without FULL_E2E_VERIFIED evidence", () => {
    const proposed = DOMAIN_PAIRS.map((p) => (p.source === "podcast" && p.target === "book" ? { ...p, enabled: true } : p));
    expect(registryProblems(proposed, DOMAINS)).toEqual(["podcast->book: enabled without FULL_E2E_VERIFIED evidence"]);
  });

  it("refuses a domain whose adapter is not ready", () => {
    const domains = { ...DOMAINS, podcast: { ...DOMAINS.podcast, sessionReady: false } };
    const proposed = DOMAIN_PAIRS.map((p) => (p.source === "podcast" && p.target === "book" ? { ...p, enabled: true, evidence: "FULL_E2E_VERIFIED" as const } : p));
    expect(registryProblems(proposed, domains)).toEqual([
      "podcast: sessionReady disagrees with SESSION_DOMAINS",
      "podcast->book: podcast has no session adapter",
      "podcast->music_artist: podcast has no session adapter",
    ]);
  });

  it("promoting a verified pair is a one-row change; duplicates are refused", () => {
    const proposed = DOMAIN_PAIRS.map((p) => (p.source === "book" && p.target === "movie" ? { ...p, enabled: true, evidence: "FULL_E2E_VERIFIED" as const } : p));
    expect(registryProblems(proposed, DOMAINS)).toEqual([]);
    expect(registryProblems([...DOMAIN_PAIRS, DOMAIN_PAIRS[0]!], DOMAINS)).toContain("duplicate pair");
  });

  it("normalization and nouns come from the registry (exact URNs only)", () => {
    for (const d of SIX) expect(sessionDomainOfQlooType(DOMAINS[d].qlooType)).toBe(d);
    expect(sessionDomainOfQlooType("urn:entity:music_artist")).toBeUndefined();
    expect(sessionDomainOfQlooType("urn:entity:place")).toBeUndefined();
    expect(sessionDomainOfQlooType("urn:entity")).toBeUndefined();
    expect([domainLabel("book"), domainLabel("tv_show", true), domainLabel("video_game", true)]).toEqual(["book", "TV shows", "video games"]);
    expect(domainLanguageOfPlural("movies")).toMatchObject({ verb: "watch", narrative: true });
    expect(domainLanguageOfPlural("podcasts")).toMatchObject({ verb: "listen to", narrative: false });
  });
});

describe("domain-aware question wording", () => {
  it("book and movie wording is byte-identical to S9.2", () => {
    expect(tagQuestionText("book", "Space Opera")).toBe("Do you enjoy Space Opera books?");
    expect(tagQuestionText("movie", "Space Opera")).toBe("Do you enjoy Space Opera movies?");
    expect(deterministicTagWording("Space Opera", "urn:tag:genre:media", "books")).toBe("Would you like to read more Space Opera?");
    expect(deterministicTagWording("Space Opera", "urn:tag:genre:media", "movies")).toBe("Would you like to watch more Space Opera?");
    expect(deterministicTagWording("Space", "urn:tag:theme:qloo", "books")).toBe("Do you like stories that explore the theme of Space?");
  });

  it("each target domain gets its own grammar with the verified label verbatim", () => {
    expect(tagQuestionText("music_artist", "Synth Pop")).toBe("Do you enjoy music artists associated with Synth Pop?");
    expect(tagQuestionText("tv_show", "Heist")).toBe("Do you enjoy Heist TV shows?");
    expect(tagQuestionText("video_game", "Open World")).toBe("Do you enjoy Open World video games?");
    expect(tagQuestionText("podcast", "True Crime")).toBe("Would you be interested in podcasts about True Crime?");
  });

  it("non-narrative targets never get story or reading wording, even from the renderer", () => {
    for (const [noun, type] of [["music artists", "urn:tag:theme:qloo"], ["podcasts", "urn:tag:setting:qloo"], ["video games", "urn:tag:style:qloo"]] as const) {
      const text = deterministicTagWording("Nostalgia", type, noun);
      expect(text).not.toMatch(/\b(stor(y|ies)|storytelling|read|books?)\b/i);
      expect(text).toContain("Nostalgia");
    }
    expect(isSemanticallyFaithfulTagWording("Do you enjoy stories about Synth Pop?", "Synth Pop", "music artists")).toBe(false);
    expect(isSemanticallyFaithfulTagWording("Do you enjoy Synth Pop storytelling?", "Synth Pop", "music artists")).toBe(false);
    expect(isSemanticallyFaithfulTagWording("Would you like to read more Synth Pop?", "Synth Pop", "music artists")).toBe(false);
    expect(isSemanticallyFaithfulTagWording("Do you enjoy music artists associated with Synth Pop?", "Synth Pop", "music artists")).toBe(true);
    expect(isSemanticallyFaithfulTagWording("Would you like to play more Roguelike?", "Roguelike", "video games")).toBe(true);
    const proposal = { proposalId: "p", questionText: "Do you like stories that explore Synth Pop?", questionType: "tag" as const, preferenceDimension: "Synth Pop", evidence: [], targetIds: ["t"], supportedAnswerTypes: ["like" as const] };
    expect(renderTagQuestion({ proposal, tag: { id: "t", name: "Synth Pop", type: "urn:tag:genre:media" }, noun: "music artists" })).toBe(
      "Do you enjoy music artists associated with Synth Pop?",
    );
  });
});

describe("server-side pair validation", () => {
  it("accepts the legacy movie -> book start body unchanged", () => {
    expect(StartRequestSchema.parse(interstellarStart)).toEqual(interstellarStart);
    expect(assertEnabledPair(interstellarStart)).toBe("enabled");
    // S9.15: a public (music-only) deployment refuses the same pair before any provider call.
    expect(() => assertEnabledPair(interstellarStart, [], "music_only")).toThrow(/discovers music/);
    expect(assertEnabledPair({ sourceType: "podcast", targetType: "music_artist" }, [], "music_only")).toBe("enabled");
  });

  it("schema rejects unknown domain values and client capability overrides", () => {
    expect(StartRequestSchema.safeParse({ ...interstellarStart, sourceType: "magazine" }).success).toBe(false);
    expect(StartRequestSchema.safeParse({ ...interstellarStart, targetType: "artist" }).success).toBe(false);
    expect(StartRequestSchema.safeParse({ ...interstellarStart, enabled: true }).success).toBe(false);
    expect(StartRequestSchema.safeParse({ ...interstellarStart, verificationPairs: ["podcast->book"] }).success).toBe(false);
  });

  it("rejects disabled and same-domain pairs before any provider call", async () => {
    for (const pair of [
      { sourceType: "book", targetType: "movie" },
      { sourceType: "tv_show", targetType: "book" },
      { sourceType: "podcast", targetType: "video_game" },
      { sourceType: "book", targetType: "book" },
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
  });
});

describe("isolated verification configuration", () => {
  it("admits only registered disabled pairs, only from server config, never in production", () => {
    expect(pairAccess("podcast", "book", ["podcast->book"])).toBe("verification");
    expect(pairAccess("book", "book", ["book->book"])).toBe("unregistered");
    expect(pairAccess("movie", "book", ["movie->book"])).toBe("enabled");
    expect(testConfig({ VERIFICATION_PAIRS: "podcast->book, tv_show->movie" }).verification.pairs).toEqual(["podcast->book", "tv_show->movie"]);
    expect(() => testConfig({ VERIFICATION_PAIRS: "music_artist->book" })).toThrow(/registered, disabled/);
    expect(() => testConfig({ VERIFICATION_PAIRS: "book->book" })).toThrow(/registered, disabled/);
    expect(() => testConfig({ VERIFICATION_PAIRS: "movie->book" })).toThrow(/registered, disabled/);
    expect(() =>
      loadConfig({ NODE_ENV: "production", QLOO_MODE: "mock", SESSION_SIGNING_SECRET: newTestSecret(), UPSTASH_REDIS_REST_URL: "https://r.example", UPSTASH_REDIS_REST_TOKEN: "t", VERIFICATION_PAIRS: "podcast->book" }),
    ).toThrow(/not allowed in production/);
    expect(testConfig().verification.pairs).toEqual([]);
  });

  it("S9.15: production and live development are music-only; legacy generic journeys are refused in production", () => {
    const prod = { NODE_ENV: "production", QLOO_MODE: "mock", SESSION_SIGNING_SECRET: newTestSecret(), UPSTASH_REDIS_REST_URL: "https://r.example", UPSTASH_REDIS_REST_TOKEN: "t" } as const;
    expect(loadConfig(prod).publicScope).toBe("music_only");
    expect(() => loadConfig({ ...prod, LEGACY_GENERIC_JOURNEYS: "true" })).toThrow(/not allowed in production/);
    expect(loadConfig({ NODE_ENV: "development", QLOO_MODE: "live", QLOO_API_KEY: "k", QLOO_BASE_URL: "https://hackathon.api.qloo.com", SESSION_SIGNING_SECRET: newTestSecret() }).publicScope).toBe("music_only");
    expect(testConfig().publicScope).toBe("legacy_generic");
  });

  it("a verification pair can start but stays out of the public projection", async () => {
    const deps = testDeps({ config: testConfig({ VERIFICATION_PAIRS: "podcast->book" }) });
    expect(assertEnabledPair({ sourceType: "podcast", targetType: "book" }, deps.config.verification.pairs)).toBe("verification");
    expect(enabledSourceDomains(deps.config.verification.pairs)).toContain("podcast");
    expect(enabledSourceDomains()).toContain("podcast");
    expect(publicCapabilities().pairs.some((p) => p.source === "podcast" && p.target === "book")).toBe(false);
  });
});
