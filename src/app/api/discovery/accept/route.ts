import { RecommendationFeedbackRequestSchema } from "@/lib/contracts";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { acceptRecommendation } from "@/lib/discovery/service";
import { handleApi, parseJsonBody } from "@/lib/validation/http";
import { enforceRateLimit } from "@/lib/reliability/rate-limit";

/** S9.6: accept one shown recommendation (an intention to try it; ends the exploration). */
export async function POST(request: Request): Promise<Response> {
  return handleApi("discovery.accept", async ({ config, requestId }) => {
    await enforceRateLimit(request, config, "answer");
    const input = await parseJsonBody(request, RecommendationFeedbackRequestSchema);
    return acceptRecommendation(createDiscoveryDeps(config, requestId), input);
  });
}
