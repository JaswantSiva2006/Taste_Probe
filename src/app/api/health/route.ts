import type { HealthData } from "@/lib/contracts";
import { DETERMINISTIC_MOCK_AGENT_NAME } from "@/lib/agent/mock-agent";
import { LIVE_QLOO_IMPLEMENTED } from "@/lib/qloo";
import { handleApi } from "@/lib/validation/http";

// Reads provider mode from the runtime environment, so never prerender.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handleApi("health", async ({ config }): Promise<HealthData> => ({
    status: "ok",
    mode: config.mode,
    qloo: { mode: config.mode, implemented: config.mode === "mock" || LIVE_QLOO_IMPLEMENTED },
    agent: DETERMINISTIC_MOCK_AGENT_NAME,
  }));
}
