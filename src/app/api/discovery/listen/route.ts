import { ListenRequestSchema } from "@/lib/contracts";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { startListening } from "@/lib/discovery/service";
import { enforceRateLimit } from "@/lib/reliability/rate-limit";
import { handleApi, parseJsonBody } from "@/lib/validation/http";

/** S9.12: start (or switch to) listening — the server picks a verified recording for an authorized artist. */
export async function POST(request: Request): Promise<Response> {
  return handleApi("discovery.listen", async ({ config, requestId }) => {
    await enforceRateLimit(request, config, "listen");
    const input = await parseJsonBody(request, ListenRequestSchema);
    return startListening(createDiscoveryDeps(config, requestId), input);
  });
}
