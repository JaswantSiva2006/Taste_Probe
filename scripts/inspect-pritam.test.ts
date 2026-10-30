import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { createQuotaGuard, createYouTubeDataLookup } from "@/lib/music/youtube-data";
import { rateLimitStoreFor } from "@/lib/reliability/rate-limit";

it("diagnoses Pritam against the existing strict YouTube policy with no Qloo request", async () => {
  createRequire(import.meta.url)("@next/env").loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  const config = loadConfig({ ...process.env, NODE_ENV: "production", QLOO_MODE: "live" });
  expect(config.music.youtubeApiKey).toBeTruthy();
  const requests: { endpoint: string; status: number; channels: string[] }[] = [];
  const lookup = createYouTubeDataLookup({
    apiKey: config.music.youtubeApiKey!, timeoutMs: config.music.timeoutMs,
    quota: createQuotaGuard(rateLimitStoreFor(config), { dailySearchMax: config.music.dailySearchMax, searchesPerExploration: 1, explorationWindowMs: 600000 }),
    fetcher: async (url, init) => {
      if (requests.length >= 2) throw new Error("diagnostic_request_cap");
      const response = await fetch(url, init);
      const body = await response.clone().json();
      requests.push({ endpoint: new URL(String(url)).pathname, status: response.status, channels: [...new Set<string>((body.items ?? []).map((item: { snippet?: { channelTitle?: string } }) => item.snippet?.channelTitle ?? ""))] });
      return response;
    },
  });
  // Name-only provider diagnostic: no Qloo identity is asserted or invented, and
  // no session recommendation or reviewed mapping is created by this script.
  const outcome = await lookup.lookup({ entityId: "", name: "Pritam" }, "release-pritam-diagnostic");
  const evidence = { outcome, requests, qlooCalls: 0 };
  await mkdir(".artifacts/release-preparation", { recursive: true });
  await writeFile(".artifacts/release-preparation/pritam.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  expect(requests.length).toBeLessThanOrEqual(2);
});
