import { SearchQuerySchema, type SearchData } from "@/lib/contracts";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { searchEntities } from "@/lib/discovery/service";
import { handleApi, parseQuery } from "@/lib/validation/http";
import { enforceRateLimit } from "@/lib/reliability/rate-limit";

export async function GET(request: Request): Promise<Response> {
  return handleApi("entities.search", async ({ config, requestId }): Promise<SearchData> => {
    await enforceRateLimit(request, config, "search");
    const { q, type } = parseQuery(request, SearchQuerySchema);
    return searchEntities(createDiscoveryDeps(config, requestId), q, type);
  });
}
