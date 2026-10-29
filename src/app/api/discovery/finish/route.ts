import { FinishRequestSchema } from "@/lib/contracts";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { finishDiscovery } from "@/lib/discovery/service";
import { handleApi, parseJsonBody } from "@/lib/validation/http";

export async function POST(request: Request): Promise<Response> {
  return handleApi("discovery.finish", async ({ config, requestId }) => {
    const { sessionToken } = await parseJsonBody(request, FinishRequestSchema);
    return finishDiscovery(createDiscoveryDeps(config, requestId), sessionToken);
  });
}
