import { MusicResolveRequestSchema } from "@/lib/contracts";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { resolveMusic } from "@/lib/music/service";
import { enforceRateLimit } from "@/lib/reliability/rate-limit";
import { handleApi, parseJsonBody } from "@/lib/validation/http";

/**
 * S9.9: resolve a verified YouTube video for one Qloo artist of the current exploration.
 * POST so the signed session token stays in the body, never in a URL. Read-only:
 * the session revision does not change.
 */
export async function POST(request: Request): Promise<Response> {
  return handleApi("music.resolve", async ({ config, requestId }) => {
    await enforceRateLimit(request, config, "resolve");
    const input = await parseJsonBody(request, MusicResolveRequestSchema);
    return resolveMusic(createDiscoveryDeps(config, requestId), input);
  });
}
