import "server-only";
import { createBoundedAgent } from "@/lib/agent/factory";
import { createDeterministicMockAgent } from "@/lib/agent/mock-agent";
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
export function createDiscoveryDeps(config: AppConfig): DiscoveryDeps {
  return {
    config,
    provider: getQlooProvider(config),
    agent: createDeterministicMockAgent(),
    store: getSessionStore(config),
    ...(config.mode === "live" ? { boundedAgent: createBoundedAgent(config) } : {}),
  };
}
