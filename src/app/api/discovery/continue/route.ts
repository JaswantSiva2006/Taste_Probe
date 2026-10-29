import { ContinueRequestSchema } from "@/lib/contracts";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { continueExploration } from "@/lib/discovery/service";
import { handleApi, parseJsonBody } from "@/lib/validation/http";
import { enforceRateLimit } from "@/lib/reliability/rate-limit";
import { AppError } from "@/lib/validation/errors";

/** S9.6: open the next round of an exploration from its stored context. */
export async function POST(request: Request): Promise<Response> {
  return handleApi("discovery.continue", async ({ config, requestId }) => {
    await enforceRateLimit(request, config, "continue");
    if (!config.features.expensiveOperations) throw new AppError("SERVICE_DISABLED", 503, "New discovery rounds are temporarily paused", 60);
    const input = await parseJsonBody(request, ContinueRequestSchema);
    return continueExploration(createDiscoveryDeps(config, requestId), input);
  });
}
