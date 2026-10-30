import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { createYouTubeDataLookup, matchRecording, parseIsoDuration } from "@/lib/music/youtube-data";

/** Opt-in diagnostic (PROBE_ARTIST="Name"): one search + one videos.list, printing why each result was accepted or not. */
it.runIf(!!process.env.PROBE_ARTIST)("diagnoses one artist name", async () => {
  createRequire(import.meta.url)("@next/env").loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  const config = loadConfig({ ...process.env, NODE_ENV: "production", QLOO_MODE: "live" });
  const name = process.env.PROBE_ARTIST!;
  const seen: Array<{ title: string; channel: string; seconds?: number; tier: string | null }> = [];
  const lookup = createYouTubeDataLookup({
    apiKey: config.music.youtubeApiKey!, timeoutMs: 10_000, quota: { take: async () => true },
    fetcher: async (url, init) => {
      const res = await fetch(url, init);
      if (String(url).includes("/videos?")) {
        const body = await res.clone().json() as { items?: Array<{ snippet: { title: string; channelTitle: string; description?: string }; contentDetails: { duration: string } }> };
        for (const v of body.items ?? []) {
          const seconds = parseIsoDuration(v.contentDetails.duration);
          seen.push({ title: v.snippet.title.slice(0, 90), channel: v.snippet.channelTitle, seconds, tier: matchRecording({ title: v.snippet.title, channelTitle: v.snippet.channelTitle, description: v.snippet.description, durationSeconds: seconds }, name) });
        }
      }
      return res;
    },
  });
  const context = (process.env.PROBE_CONTEXT ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const outcome = await lookup.lookup({ entityId: "probe", name }, "probe", { context });
  console.log(JSON.stringify({ outcome: outcome.kind, reason: "reason" in outcome ? outcome.reason : null, accepted: outcome.kind === "resolved" ? [outcome.video, ...(outcome.alternates ?? [])].map((v) => `${v.title.slice(0, 70)} · ${v.channelTitle}`) : [], seenCount: seen.length }, null, 1));
  expect(outcome).toBeTruthy();
}, 30_000);
