import { createRequire } from "node:module";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it, expect } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { createLiveQlooProvider, buildInsightsUrl } from "@/lib/qloo/live-provider";
import { normalizeTargetCandidates, normalizeSearchResults } from "@/lib/discovery/normalize";

it.skipIf(process.env.RUN_DISCOVERY_SUPPLY_LIVE !== "1")("S9.16R independently authorized six-request supplier campaign", async () => {
  createRequire(import.meta.url)("@next/env").loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  const config = loadConfig({ ...process.env, NODE_ENV: "test", QLOO_MODE: "live" });
  const dir = resolve(".artifacts/s9-16r"); mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "qloo-ledger.json");
  const ledger = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { allowance: 6, requests: [], results: {} };
  const persist = () => writeFileSync(path, JSON.stringify(ledger, null, 2));
  const fetcher: typeof fetch = async (input, init) => {
    if (ledger.requests.length >= 6) throw new Error("S9.16R separate Qloo allowance exhausted");
    const url = new URL(String(input));
    if (url.hostname !== new URL(config.qloo.baseUrl ?? "https://hackathon.api.qloo.com").hostname) throw new Error("Unexpected provider host");
    const row = { number: ledger.requests.length + 1, status: "reserved", at: new Date().toISOString(), endpoint: url.pathname };
    ledger.requests.push(row); persist();
    const response = await fetch(input, init);
    row.status = String(response.status); persist();
    return response;
  };
  const provider = createLiveQlooProvider(config, fetcher);
  const phase = process.env.SUPPLY_PROBE_PHASE ?? "base";
  if (phase === "base" && !ledger.results.base) {
    const results = normalizeSearchResults(await provider.searchEntities("Dua Lipa", "music_artist"));
    const anchor = results.find((e) => e.name.toLowerCase() === "dua lipa");
    expect(anchor).toBeTruthy();
    ledger.results.anchor = anchor; persist();
    const response = await provider.getRecommendations({ seedEntityIds: [anchor!.entityId], targetType: "music_artist", take: 50, includeExplainability: true, maxAttempts: 1 });
    const normalized = normalizeTargetCandidates(response, [anchor!.entityId], 50, { targetType: "music_artist", provenance: "qloo" });
    ledger.results.base = { ...normalized, returned: response.payload.results.entities.length }; persist();
  }
  if (phase === "strategies") {
    const base = ledger.results.base; const anchor = ledger.results.anchor;
    if (!base || !anchor) throw new Error("Run base phase first");
    for (const family of ["profile", "tag", "exclusions", "page2"]) {
      if (ledger.results[family]) continue;
      const artist = base.candidates[0]; const tag = base.candidates.flatMap((c: { tags: Array<{ id: string }> }) => c.tags)[0];
      const url = buildInsightsUrl(config.qloo.baseUrl ?? "https://hackathon.api.qloo.com", { seedEntityIds: [anchor.entityId], targetType: "music_artist", take: 50, ...(family === "profile" ? { positiveEntityIds: [artist.entityId] } : family === "tag" ? { positiveTagIds: [tag.id] } : family === "exclusions" ? { excludedEntityIds: base.candidates.slice(0, 10).map((c: { entityId: string }) => c.entityId) } : {}), includeExplainability: true });
      if (family === "page2") url.searchParams.set("page", "2");
      const response = await fetcher(url, { headers: { "X-Api-Key": config.qloo.apiKey! }, signal: AbortSignal.timeout(10_000) });
      const body = await response.json();
      const entities = body.results?.entities ?? [];
      ledger.results[family] = { status: response.status, returned: entities.length, newIds: entities.filter((c: { entity_id: string }) => !base.candidates.some((old: { entityId: string }) => old.entityId === c.entity_id)).map((c: { entity_id: string }) => c.entity_id), entities }; persist();
    }
  }
  console.log("S9_16R_LIVE_SUPPLY", JSON.stringify({ calls: ledger.requests.length, anchor: ledger.results.anchor, baseCount: ledger.results.base?.candidates.length, strategies: Object.fromEntries(["profile", "tag", "exclusions", "page2"].filter((k) => ledger.results[k]).map((k) => [k, { status: ledger.results[k].status, count: ledger.results[k].returned, newIds: ledger.results[k].newIds.length }])) }));
}, 90_000);
