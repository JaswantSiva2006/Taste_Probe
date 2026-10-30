import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { it, expect } from "vitest";
import { createLiveQlooProvider } from "@/lib/qloo/live-provider";
import { normalizeSearchResults } from "@/lib/discovery/normalize";

it("captures the precise sanitized book failure without repeating successful domains", async () => {
  createRequire(import.meta.url)("@next/env").loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  const path = ".artifacts/s9-14/ledger.json";
  const ledger = JSON.parse(await readFile(path, "utf8"));
  if (ledger.bookDiagnosis?.source) { console.log(JSON.stringify(ledger.bookDiagnosis)); return; }
  const requests: unknown[] = [];
  const provider = createLiveQlooProvider({ qloo: { apiKey: process.env.QLOO_API_KEY, baseUrl: process.env.QLOO_BASE_URL, timeoutMs: 8000 } }, async (url, init) => {
    if (ledger.qloo >= 15) throw new Error("book_diagnosis_cap");
    ledger.qloo += 1; await writeFile(path, JSON.stringify(ledger, null, 2));
    const response = await fetch(url, init);
    const body = await response.clone().text();
    requests.push({ url: String(url), status: response.status, error: response.ok ? null : body.slice(0, 2000).split(process.env.QLOO_API_KEY ?? "never-match").join("[REDACTED]") });
    return response;
  });
  let source: unknown = null;
  let error: string | null = null;
  try {
    const search = await provider.searchEntities("Dune", "book");
    const matches = normalizeSearchResults(search);
    const selected = matches.find((item) => item.name.toLowerCase() === "dune") ?? matches[0];
    source = selected ?? null;
    if (selected) await provider.getRecommendations({ seedEntityIds: [selected.entityId], targetType: "music_artist", take: 8, includeExplainability: true, maxAttempts: 1 });
  } catch (e) { error = (e as { code?: string }).code ?? "unknown_error"; }
  ledger.bookDiagnosis = { source, requests, error };
  await writeFile(path, JSON.stringify(ledger, null, 2));
  console.log(JSON.stringify(ledger.bookDiagnosis));
  expect(ledger.qloo).toBeLessThanOrEqual(15);
});
