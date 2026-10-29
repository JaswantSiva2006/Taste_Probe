import "server-only";
import type { AppConfig } from "@/lib/config/env";
import { AppError } from "@/lib/validation/errors";
import { createMockQlooProvider } from "./mock-provider";
import type { QlooProvider } from "./provider";

export type { QlooProvider, RecommendationRequest } from "./provider";

const notImplemented = (): never => {
  throw new AppError(
    "LIVE_PROVIDER_NOT_IMPLEMENTED",
    501,
    "Live Qloo integration is not implemented yet. Set QLOO_MODE=mock to use synthetic fixtures.",
  );
};

/**
 * Live placeholder: fails explicitly on every call and never falls back to fixtures.
 * Replaced by the real Qloo client in a later segment.
 */
export function createLiveQlooProvider(): QlooProvider {
  return {
    mode: "live",
    searchEntities: async () => notImplemented(),
    getEntity: async () => notImplemented(),
    getRecommendations: async () => notImplemented(),
  };
}

export const LIVE_QLOO_IMPLEMENTED = false;

export function getQlooProvider(config: Pick<AppConfig, "mode">): QlooProvider {
  return config.mode === "mock" ? createMockQlooProvider() : createLiveQlooProvider();
}
