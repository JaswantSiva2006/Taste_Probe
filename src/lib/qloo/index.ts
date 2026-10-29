import "server-only";
import type { AppConfig } from "@/lib/config/env";
import { createMockQlooProvider } from "./mock-provider";
import { createLiveQlooProvider } from "./live-provider";
import type { QlooProvider } from "./provider";

export type { QlooProvider, RecommendationRequest } from "./provider";

export { createLiveQlooProvider } from "./live-provider";

export const LIVE_QLOO_IMPLEMENTED = true;

export function getQlooProvider(config: Pick<AppConfig, "mode" | "qloo">): QlooProvider {
  return config.mode === "mock" ? createMockQlooProvider() : createLiveQlooProvider(config);
}
