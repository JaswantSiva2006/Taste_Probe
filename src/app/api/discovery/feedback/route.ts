import { ListeningFeedbackRequestSchema } from "@/lib/contracts";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { listeningFeedback } from "@/lib/discovery/service";
import { enforceRateLimit } from "@/lib/reliability/rate-limit";
import { handleApi, parseJsonBody } from "@/lib/validation/http";

/** S9.12: one listening action (LOVE … FINISH) on the recording the server last presented. */
export async function POST(request: Request): Promise<Response> {
  return handleApi("discovery.feedback", async ({ config, requestId }) => {
    await enforceRateLimit(request, config, "feedback");
    const input = await parseJsonBody(request, ListeningFeedbackRequestSchema);
    return listeningFeedback(createDiscoveryDeps(config, requestId), input);
  });
}
