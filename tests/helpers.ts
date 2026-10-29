import { randomBytes } from "node:crypto";
import { createDeterministicMockAgent } from "@/lib/agent/mock-agent";
import { loadConfig, type AppConfig } from "@/lib/config/env";
import type { DiscoveryDeps } from "@/lib/discovery/service";
import { createMockQlooProvider } from "@/lib/qloo/mock-provider";
import { createMemorySessionStore } from "@/lib/session/memory-store";
import type { StartRequest } from "@/lib/contracts";

/** Isolated, randomly generated test secret: never read from .env.local. */
export const newTestSecret = (): string => randomBytes(32).toString("hex");

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    QLOO_MODE: "mock",
    SESSION_SIGNING_SECRET: newTestSecret(),
    ...env,
  });
}

export function testDeps(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    config: testConfig(),
    provider: createMockQlooProvider(),
    agent: createDeterministicMockAgent(),
    store: createMemorySessionStore(),
    ...overrides,
  };
}

export const interstellarStart: StartRequest = {
  entityQuery: "Interstellar",
  sourceType: "movie",
  targetType: "book",
  maxQuestions: 3,
  selectedEntityId: "mock:movie:interstellar",
};
