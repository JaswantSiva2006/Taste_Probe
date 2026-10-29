import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import type { EntityType } from "@/lib/contracts";
import { buildQuestionCandidates } from "@/lib/discovery/questions";
import { normalizeRecommendations } from "@/lib/discovery/normalize";
import { createLiveQlooProvider } from "@/lib/qloo/live-provider";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as typeof import("@next/env");
// Public product label stays `music_artist`; Qloo's documented wire type is `artist`.
const ARTIST_QLOO_TYPE = "urn:entity:artist";
const ARTIST_PROVIDER_TYPE = "artist" as EntityType;

beforeAll(() => loadEnvConfig(process.cwd(), true, { info() {}, error() {} }));

describe("bounded music artist to books capability probe", () => {
  it("searches a verified artist and requests book Insights with two Qloo calls", async () => {
    expect(process.env.QLOO_API_KEY, "QLOO_API_KEY is required").toBeTruthy();
    const provider = createLiveQlooProvider({
      qloo: {
        apiKey: process.env.QLOO_API_KEY,
        baseUrl: process.env.QLOO_BASE_URL,
        timeoutMs: Number(process.env.QLOO_TIMEOUT_MS) || 8_000,
      },
    });

    const search = await provider.searchEntities("Coldplay", ARTIST_PROVIDER_TYPE);
    const verifiedArtists = search.payload.results.filter((entity) => entity.types.includes(ARTIST_QLOO_TYPE));
    const artist = verifiedArtists.find((entity) => entity.name.trim().toLowerCase() === "coldplay") ?? verifiedArtists[0];
    expect(artist, "Qloo returned no verified music artist").toBeTruthy();

    const insights = await provider.getRecommendations({
      seedEntityIds: [artist!.entity_id],
      targetType: "book",
      take: 10,
      includeExplainability: true,
      maxAttempts: 1,
    });
    const books = normalizeRecommendations(insights, [artist!.entity_id], 10).filter(
      (candidate) => candidate.entityType === "book" && candidate.evidence.source === "qloo",
    );
    const questions = buildQuestionCandidates(books, "book");
    const tagCount = new Set(books.flatMap((book) => book.tags.map((tag) => tag.id))).size;
    const usefulTagQuestionCount = questions.filter((question) => question.targetType === "tag").length;
    const summary = {
      qlooRequests: search.requestCount + insights.requestCount,
      searchType: ARTIST_QLOO_TYPE,
      artistCandidateCount: verifiedArtists.length,
      selectedArtist: { entityId: artist!.entity_id, name: artist!.name, types: artist!.types },
      targetType: "urn:entity:book",
      bookCandidateCount: books.length,
      returnedBookIds: books.map((book) => book.entityId),
      descriptionCoverage: `${books.filter((book) => Boolean(book.description)).length}/${books.length}`,
      imageCoverage: `${books.filter((book) => Boolean(book.imageUrl)).length}/${books.length}`,
      taggedBookCoverage: `${books.filter((book) => book.tags.length > 0).length}/${books.length}`,
      distinctTagCount: tagCount,
      usefulTagQuestionCount,
      entityQuestionCount: questions.filter((question) => question.targetType === "entity").length,
      normalizedByCurrentCode: books.length === insights.payload.results.entities.length,
      sampleNames: books.slice(0, 3).map((book) => book.name),
      sampleTagNames: [...new Set(books.flatMap((book) => book.tags.map((tag) => tag.name)))].slice(0, 8),
    };
    console.log(`PIVOT_PROBE ${JSON.stringify(summary)}`);

    expect(search.requestCount).toBe(1);
    expect(insights.requestCount).toBe(1);
    expect(books.length).toBeGreaterThan(0);
    expect(books.every((book) => book.entityId.length > 0)).toBe(true);
  });
});
