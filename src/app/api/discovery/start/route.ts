import { StartRequestSchema } from "@/lib/contracts";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { startDiscovery } from "@/lib/discovery/service";
import { handleApi, parseJsonBody } from "@/lib/validation/http";

export async function POST(request: Request): Promise<Response> {
  return handleApi("discovery.start", async ({ config }) => {
    const input = await parseJsonBody(request, StartRequestSchema);
    return startDiscovery(createDiscoveryDeps(config), input);
  });
}
