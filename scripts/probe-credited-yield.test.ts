import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { createYouTubeDataLookup, type DynamicOutcome } from "@/lib/music/youtube-data";

/**
 * S9.17 opt-in live probe (PROBE_YOUTUBE=1): two YouTube searches + two videos.list
 * requests, zero Qloo, zero Gemini. Measures how many artists/recordings each identity
 * tier yields for two unrelated groups of artist names. Names are probe inputs only;
 * production code contains no artist names.
 */
const GROUPS = [
  ["A.R. Rahman", "Anirudh Ravichander", "Ilaiyaraaja", "Yuvan Shankar Raja", "Santhosh Narayanan", "Harris Jayaraj"],
  ["Dua Lipa", "Nils Frahm", "Burna Boy", "Rosalía", "Bad Bunny", "Ólafur Arnalds"],
];

it.runIf(process.env.PROBE_YOUTUBE === "1")("measures verified yield per identity tier", async () => {
  createRequire(import.meta.url)("@next/env").loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  const config = loadConfig({ ...process.env, NODE_ENV: "production", QLOO_MODE: "live" });
  expect(config.music.youtubeApiKey).toBeTruthy();
  let requests = 0;
  const lookup = createYouTubeDataLookup({
    apiKey: config.music.youtubeApiKey!, timeoutMs: 10_000,
    quota: { take: async () => true },
    fetcher: async (url, init) => {
      if (++requests > 4) throw new Error("probe_request_cap");
      return fetch(url, init);
    },
  });
  const report = [];
  for (const [g, names] of GROUPS.entries()) {
    const artists = names.map((name, i) => ({ entityId: `probe-${g}-${i}`, name }));
    const out = await lookup.lookupBatch!(artists, `probe-${g}`);
    report.push(artists.map((a) => {
      const o = out[a.entityId] as DynamicOutcome | null;
      const all = o?.kind === "resolved" ? [o.video, ...(o.alternates ?? [])] : [];
      const strict = all.filter((v) => v.channelKind === "topic" || v.channelKind === "vevo");
      return { name: a.name, outcome: o?.kind ?? "deferred", strictPolicy: strict.length, newPolicy: all.length, sample: all.slice(0, 4).map((v) => `${v.title} · ${v.channelTitle} [${v.channelKind}]`) };
    }));
  }
  await mkdir(".artifacts/s9-17", { recursive: true });
  await writeFile(".artifacts/s9-17/credited-yield.json", JSON.stringify({ requests, qlooCalls: 0, geminiCalls: 0, report }, null, 2));
  console.log(JSON.stringify(report, null, 1));
}, 60_000);
