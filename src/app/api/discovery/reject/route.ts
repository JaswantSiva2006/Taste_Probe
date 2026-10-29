import { RecommendationFeedbackRequestSchema } from "@/lib/contracts";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { rejectRecommendation } from "@/lib/discovery/service";
import { handleApi, parseJsonBody } from "@/lib/validation/http";
import { enforceRateLimit } from "@/lib/reliability/rate-limit";

/** S9.6: reject one recommendation shown in the current round's results (no provider call). */
export async function POST(request: Request): Promise<Response> {
  return handleApi("discovery.reject", async ({ config, requestId }) => {
    await enforceRateLimit(request, config, "answer");
    const input = await parseJsonBody(request, RecommendationFeedbackRequestSchema);
    return rejectRecommendation(createDiscoveryDeps(config, requestId), input);
  });
}
