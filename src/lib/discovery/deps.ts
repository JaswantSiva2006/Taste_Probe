import "server-only";
import { createBoundedAgent } from "@/lib/agent/factory";
import { createFetchGeminiTransport } from "@/lib/agent/gemini-transport";
import { createGeminiQuestionGenerator } from "@/lib/agent/question-generation/proposer";
import { createDeterministicMockAgent } from "@/lib/agent/mock-agent";
import { GEMINI_PROVIDERS } from "@/lib/agent/factory";
import { createGeminiSongSelector } from "@/lib/agent/song-selector";
import { defaultDynamicLookup } from "@/lib/music/service";
import type { AppConfig } from "@/lib/config/env";
import { getQlooProvider } from "@/lib/qloo";
import { getSessionStore } from "@/lib/session";
import type { DiscoveryDeps } from "./service";

/**
 * Composition root for route handlers.
 * - mock: fixture provider + deterministic mock agent (original S1–S5 path, no inference).
 * - live: S3 Qloo provider + S6 bounded agent (Gemini; fails with CONFIG_ERROR if
 *   Gemini is misconfigured, never silently mock), driving the S7 live loop.
 * The session store is memory outside production and Redis in production.
 */
export function createDiscoveryDeps(config: AppConfig, requestId?: string): DiscoveryDeps {
  const questionGenerator =
    config.mode === "live" &&
    config.features.questionGenerationMode === "llm_grounded" &&
    config.llm.provider !== "none" &&
    config.llm.model &&
    config.llm.apiKey
      ? createGeminiQuestionGenerator({
          model: config.llm.model,
          temperature: config.llm.temperature,
          timeoutMs: config.llm.timeoutMs,
          transport: createFetchGeminiTransport(config.llm.apiKey),
        })
      : undefined;
  // S9.12: the same Gemini model/key in song-selection mode; live mode only (mock never calls Gemini).
  const songSelector =
    config.mode === "live" && GEMINI_PROVIDERS.has(config.llm.provider) && config.llm.model && config.llm.apiKey
      ? createGeminiSongSelector({
          model: config.llm.model,
          temperature: config.llm.temperature,
          timeoutMs: config.llm.timeoutMs,
          transport: createFetchGeminiTransport(config.llm.apiKey),
        })
      : undefined;
  const deps: DiscoveryDeps = {
    config,
    provider: getQlooProvider(config),
    agent: createDeterministicMockAgent(),
    store: getSessionStore(config),
    requestId,
    ...(config.mode === "live" ? { boundedAgent: createBoundedAgent(config) } : {}),
    ...(questionGenerator ? { questionGenerator } : {}),
    ...(songSelector ? { songSelector } : {}),
  };
  // S9.9 Tier B (only with a dedicated YOUTUBE_API_KEY): cache → dedup → quota → Data API.
  const musicLookup = defaultDynamicLookup(deps);
  return musicLookup ? { ...deps, musicLookup } : deps;
}
