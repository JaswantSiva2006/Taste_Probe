import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { normalizeTargetCandidates } from "@/lib/discovery/normalize";
import { buildInsightsUrl, createLiveQlooProvider } from "@/lib/qloo/live-provider";
import type { RecommendationRequest } from "@/lib/qloo/provider";

/**
 * S9.8 bounded adaptive-retrieval probe (npm run probe:adaptive). Qloo only, no
 * Gemini, hard-capped by a counting fetch, one attempt per request, no retries.
 * Question: does a changed, supported Insights query built from a signal Qloo
 * itself returned introduce previously unseen, correctly typed artist IDs?
 * Prints sanitized query parameters, IDs, names and timings — no keys or raw bodies.
 */

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as typeof import("@next/env");
const MAX_REQUESTS = 4;
// Interstellar's public Qloo ID, verified by live Search in S2 and S9.3.
const ANCHOR = { id: "057DA9D9-399B-437E-8BCA-A80E499125EF", name: "Interstellar" };
const TAKE = 30; // production MAX_RECOMMENDATION_CANDIDATES
const ARTIST_URN = "urn:entity:artist";

beforeAll(() => loadEnvConfig(process.cwd(), true, { info() {}, error() {} }));

function sanitizedQuery(request: RecommendationRequest) {
  const url = buildInsightsUrl("https://qloo.invalid", request);
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const hash = createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 12);
  return { params: Object.fromEntries(params), hash };
}

describe("bounded adaptive retrieval probe", () => {
  it("measures novelty of changed Insights queries within the request cap", async () => {
    expect(process.env.QLOO_API_KEY, "QLOO_API_KEY is required").toBeTruthy();
    let requests = 0;
    let failures = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (requests >= MAX_REQUESTS) throw new Error(`probe request cap ${MAX_REQUESTS} reached`);
      requests += 1;
      const res = await fetch(input, init);
      if (!res.ok) failures += 1;
      return res;
    };
    const provider = createLiveQlooProvider(
      { qloo: { apiKey: process.env.QLOO_API_KEY, baseUrl: process.env.QLOO_BASE_URL, timeoutMs: Number(process.env.QLOO_TIMEOUT_MS) || 8_000 } },
      fetcher,
    );

    async function run(family: string, request: RecommendationRequest) {
      const query = sanitizedQuery(request);
      const started = performance.now();
      const res = await provider.getRecommendations(request);
      const latencyMs = Math.round(performance.now() - started);
      const raw = res.payload.results.entities;
      const rawIds = raw.map((e) => e.entity_id);
      const { candidates, rejected } = normalizeTargetCandidates(res, [ANCHOR.id], TAKE, { targetType: "music_artist", provenance: "qloo" });
      return {
        family,
        query,
        latencyMs,
        attempts: res.requestCount,
        returned: raw.length,
        uniqueRaw: new Set(rawIds).size,
        duplicatesInResponse: rawIds.length - new Set(rawIds).size,
        wrongType: raw.filter((e) => e.subtype !== ARTIST_URN && !(e.types ?? []).includes(ARTIST_URN)).length,
        anchorEchoed: rawIds.includes(ANCHOR.id),
        normalized: candidates.length,
        normalizationRejected: rejected,
        candidates,
      };
    }

    const base: RecommendationRequest = { seedEntityIds: [ANCHOR.id], targetType: "music_artist", take: TAKE, includeExplainability: true, maxAttempts: 1 };
    const A = await run("BASE", base);
    const seen = new Set(A.candidates.map((c) => c.entityId));

    // A genuine Qloo signal: the baseline tag carried by the most artists without carrying all of them.
    const counts = new Map<string, { name: string; type: string; n: number }>();
    for (const c of A.candidates) for (const t of c.tags) counts.set(t.id, { name: t.name, type: t.type, n: (counts.get(t.id)?.n ?? 0) + 1 });
    const [tagId, tag] = [...counts.entries()].filter(([, v]) => v.n >= 2 && v.n < A.candidates.length).sort((a, b) => b[1].n - a[1].n)[0] ?? [];
    const lovedArtist = A.candidates[0];

    const variants: Array<typeof A> = [];
    if (tagId) variants.push(await run("TAG_FOCUS", { ...base, positiveTagIds: [tagId] }));
    if (lovedArtist) variants.push(await run("PROFILE_REFRESH", { ...base, positiveEntityIds: [lovedArtist.entityId] }));

    const compare = (v: (typeof variants)[number]) => {
      const ids = v.candidates.map((c) => c.entityId);
      const fresh = v.candidates.filter((c) => !seen.has(c.entityId));
      return {
        family: v.family,
        queryHash: v.query.hash,
        changedParams: Object.fromEntries(Object.entries(v.query.params).filter(([k, val]) => A.query.params[k] !== val)),
        uniqueArtists: new Set(ids).size,
        overlapWithBase: ids.filter((id) => seen.has(id)).length,
        previouslyUnseen: fresh.map((c) => ({ entityId: c.entityId, name: c.name })),
        topFiveOrderChanged: ids.slice(0, 5).join() !== A.candidates.slice(0, 5).map((c) => c.entityId).join(),
      };
    };

    const strip = ({ candidates, ...rest }: typeof A) => ({ ...rest, sample: candidates.slice(0, 8).map((c) => ({ entityId: c.entityId, name: c.name })) });
    console.log(
      `ADAPTIVE_PROBE ${JSON.stringify(
        {
          qlooRequests: requests,
          httpFailures: failures,
          geminiRequests: 0,
          anchor: ANCHOR,
          signal: { tag: tagId ? { id: tagId, ...tag } : null, lovedArtist: lovedArtist ? { entityId: lovedArtist.entityId, name: lovedArtist.name } : null },
          baseline: { ...strip(A), allIds: A.candidates.map((c) => c.entityId) },
          variants: variants.map((v) => ({ ...strip(v), comparison: compare(v) })),
        },
        null,
        1,
      )}`,
    );
    expect(requests).toBeLessThanOrEqual(MAX_REQUESTS);
  });
});
