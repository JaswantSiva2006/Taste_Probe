import { AnswerRequestSchema } from "@/lib/contracts";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { answerDiscovery } from "@/lib/discovery/service";
import { handleApi, parseJsonBody } from "@/lib/validation/http";
import { enforceRateLimit } from "@/lib/reliability/rate-limit";

export async function POST(request: Request): Promise<Response> {
  return handleApi("discovery.answer", async ({ config, requestId }) => {
    await enforceRateLimit(request, config, "answer");
    const input = await parseJsonBody(request, AnswerRequestSchema);
    return answerDiscovery(createDiscoveryDeps(config, requestId), input);
  });
}
