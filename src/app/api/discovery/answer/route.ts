import { AnswerRequestSchema } from "@/lib/contracts";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { answerDiscovery } from "@/lib/discovery/service";
import { handleApi, parseJsonBody } from "@/lib/validation/http";

export async function POST(request: Request): Promise<Response> {
  return handleApi("discovery.answer", async ({ config }) => {
    const input = await parseJsonBody(request, AnswerRequestSchema);
    return answerDiscovery(createDiscoveryDeps(config), input);
  });
}
