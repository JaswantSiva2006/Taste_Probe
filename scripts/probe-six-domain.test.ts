import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { createLiveQlooProvider } from "@/lib/qloo/live-provider";
import { normalizeSearchResults, normalizeTargetCandidates } from "@/lib/discovery/normalize";
import type { EntityType } from "@/lib/contracts";

it("records six real typed source-to-artist queries within the persistent release budget", async () => {
  createRequire(import.meta.url)("@next/env").loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  const path = ".artifacts/s9-14/ledger.json";
  await mkdir(".artifacts/s9-14", { recursive: true });
  const ledger = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : { qloo: 0, gemini: 0, youtubeSearch: 0, youtubeVideos: 0, costUsd: 0, domains: {} };
  const provider = createLiveQlooProvider({ qloo: { apiKey: process.env.QLOO_API_KEY, baseUrl: process.env.QLOO_BASE_URL, timeoutMs: 8000 } }, async (url, init) => {
    if (ledger.qloo >= 18) throw new Error("release_campaign_cap");
    ledger.qloo += 1;
    await writeFile(path, JSON.stringify(ledger, null, 2));
    return fetch(url, init);
  });
  const cases: [EntityType, string][] = [["movie", "Interstellar"], ["book", "Dune"], ["music_artist", "Nils Frahm"], ["tv_show", "Breaking Bad"], ["video_game", "Celeste"], ["podcast", "Radiolab"]];
  for (const [domain, query] of cases) {
    if (ledger.domains[domain]) continue;
    let stage = "search";
    let verifiedSource: unknown = null;
    try {
      const search = await provider.searchEntities(query, domain);
      const matches = normalizeSearchResults(search).filter((item) => item.entityType === domain);
      const source = matches.find((item) => item.name.toLowerCase() === query.toLowerCase()) ?? matches[0];
      if (!source) throw new Error("no_typed_source");
      verifiedSource = source;
      stage = "insights";
      const result = await provider.getRecommendations({ seedEntityIds: [source.entityId], targetType: "music_artist", take: 8, includeExplainability: true, maxAttempts: 1 });
      const normalized = normalizeTargetCandidates(result, [source.entityId], 8, { targetType: "music_artist", provenance: "qloo" });
      ledger.domains[domain] = { status: normalized.candidates.length ? "VERIFIED_INSIGHTS" : "SUPPORTED_BUT_EMPTY", source, artistCount: normalized.candidates.length, artistIds: normalized.candidates.map((item) => item.entityId), subtypes: [...new Set(result.payload.results.entities.map((item) => item.subtype))], selfExcluded: normalized.candidates.every((item) => item.entityId !== source.entityId) };
    } catch (error) {
      ledger.domains[domain] = { status: "BLOCKED_BY_PROVIDER", stage, source: verifiedSource, error: (error as { code?: string }).code ?? "probe_failed" };
    }
    await writeFile(path, JSON.stringify(ledger, null, 2));
    console.log(JSON.stringify({ domain, ...ledger.domains[domain], remainingQloo: 18 - ledger.qloo }));
  }
  expect(ledger.qloo).toBeLessThanOrEqual(18);
}, 180000);
