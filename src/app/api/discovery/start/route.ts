import { StartRequestSchema } from "@/lib/contracts";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { startDiscovery } from "@/lib/discovery/service";
import { handleApi, parseJsonBody } from "@/lib/validation/http";
import { enforceRateLimit } from "@/lib/reliability/rate-limit";
import { AppError } from "@/lib/validation/errors";

export async function POST(request: Request): Promise<Response> {
  return handleApi("discovery.start", async ({ config, requestId }) => {
    await enforceRateLimit(request, config, "start");
    if (!config.features.expensiveOperations) throw new AppError("SERVICE_DISABLED", 503, "New discovery sessions are temporarily paused", 60);
    const input = await parseJsonBody(request, StartRequestSchema);
    return startDiscovery(createDiscoveryDeps(config, requestId), input);
  });
}
