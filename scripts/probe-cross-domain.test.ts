import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { DOMAINS, type EntityType } from "@/lib/contracts";
import { normalizeSearchResults, normalizeTargetCandidates } from "@/lib/discovery/normalize";
import { buildQuestionCandidates } from "@/lib/discovery/questions";
import { createLiveQlooProvider } from "@/lib/qloo/live-provider";

/**
 * S9.3 bounded capability probe (npm run probe:cross-domain). Qloo only, no
 * Gemini, hard-capped by a counting fetch. Gathers Search and Insights evidence
 * for TV shows, video games and podcasts. This is NOT an end-to-end session and
 * never enables a pair. Prints counts and names only — no keys or raw bodies.
 */

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as typeof import("@next/env");
const MAX_REQUESTS = Number(process.env.PROBE_MAX_QLOO) || 8;
// Interstellar's public Qloo ID, verified by live Search in S2 and S9.3.
const ANCHOR = { id: "057DA9D9-399B-437E-8BCA-A80E499125EF", name: "Interstellar" };
const TARGETS: EntityType[] = ["tv_show", "video_game", "podcast"];
const SEARCHES: Array<[EntityType, string]> = [["tv_show", "Breaking Bad"], ["video_game", "Minecraft"], ["podcast", "Serial"]];

beforeAll(() => loadEnvConfig(process.cwd(), true, { info() {}, error() {} }));

describe("bounded cross-domain capability probe", () => {
  it("probes Insights targets and Search sources within the request cap", async () => {
    expect(process.env.QLOO_API_KEY, "QLOO_API_KEY is required").toBeTruthy();
    let requests = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (requests >= MAX_REQUESTS) throw new Error(`probe request cap ${MAX_REQUESTS} reached`);
      requests += 1;
      return fetch(input, init);
    };
    const provider = createLiveQlooProvider(
      { qloo: { apiKey: process.env.QLOO_API_KEY, baseUrl: process.env.QLOO_BASE_URL, timeoutMs: Number(process.env.QLOO_TIMEOUT_MS) || 8_000 } },
      fetcher,
    );

    const insights: Record<string, unknown> = {};
    for (const target of TARGETS) {
      try {
        const res = await provider.getRecommendations({ seedEntityIds: [ANCHOR.id], targetType: target, take: 10, includeExplainability: true, maxAttempts: 1 });
        const raw = res.payload.results.entities;
        const { candidates, rejected } = normalizeTargetCandidates(res, [ANCHOR.id], 10, { targetType: target, provenance: "qloo" });
        const questions = buildQuestionCandidates(candidates, target);
        insights[target] = {
          wireType: DOMAINS[target].qlooType,
          returned: raw.length,
          rawSubtypes: [...new Set(raw.map((e) => e.subtype))],
          rawTypes: [...new Set(raw.map((e) => e.type).filter(Boolean))],
          normalized: candidates.length,
          rejected,
          description: `${candidates.filter((c) => c.description).length}/${candidates.length}`,
          image: `${candidates.filter((c) => c.imageUrl).length}/${candidates.length}`,
          tagged: `${candidates.filter((c) => c.tags.length).length}/${candidates.length}`,
          tagQuestions: questions.filter((q) => q.targetType === "tag").length,
          entityQuestions: questions.filter((q) => q.targetType === "entity").length,
          sampleQuestion: questions[0]?.text ?? null,
          sampleNames: candidates.slice(0, 3).map((c) => c.name),
        };
      } catch (error) {
        insights[target] = { error: (error as { code?: string }).code ?? (error as Error).message };
      }
    }

    const search: Record<string, unknown> = {};
    for (const [domain, query] of SEARCHES) {
      try {
        const res = await provider.searchEntities(query, domain);
        const normalized = normalizeSearchResults(res).filter((e) => e.entityType === domain);
        search[domain] = {
          query,
          returned: res.payload.results.length,
          rawTypes: [...new Set(res.payload.results.flatMap((e) => e.types))].slice(0, 6),
          normalizedAsDomain: normalized.length,
          exact: normalized.filter((e) => e.name.toLowerCase() === query.toLowerCase()).map((e) => ({ name: e.name, entityId: e.entityId, year: e.year ?? null })),
        };
      } catch (error) {
        search[domain] = { query, error: (error as { code?: string }).code ?? (error as Error).message };
      }
    }

    console.log(`CROSS_DOMAIN_PROBE ${JSON.stringify({ qlooRequests: requests, anchor: ANCHOR.name, insights, search }, null, 1)}`);
    expect(requests).toBeLessThanOrEqual(MAX_REQUESTS);
  });
});
