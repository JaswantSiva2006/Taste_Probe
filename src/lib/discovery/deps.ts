import "server-only";
import { createDeterministicMockAgent } from "@/lib/agent/mock-agent";
import type { AppConfig } from "@/lib/config/env";
import { getQlooProvider } from "@/lib/qloo";
import { getSessionStore } from "@/lib/session";
import type { DiscoveryDeps } from "./service";

/**
 * Composition root for route handlers. Swap the agent here when the Gemini
 * agent lands; swap the provider inside getQlooProvider for live Qloo.
 * The session store is memory outside production and Redis in production.
 */
export function createDiscoveryDeps(config: AppConfig): DiscoveryDeps {
  return {
    config,
    provider: getQlooProvider(config),
    agent: createDeterministicMockAgent(),
    store: getSessionStore(config),
  };
}
