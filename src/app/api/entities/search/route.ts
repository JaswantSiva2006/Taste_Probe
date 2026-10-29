import { SearchQuerySchema, type SearchData } from "@/lib/contracts";
import { createDiscoveryDeps } from "@/lib/discovery/deps";
import { searchEntities } from "@/lib/discovery/service";
import { handleApi, parseQuery } from "@/lib/validation/http";

export async function GET(request: Request): Promise<Response> {
  return handleApi("entities.search", async ({ config }): Promise<SearchData> => {
    const { q, type } = parseQuery(request, SearchQuerySchema);
    return searchEntities(createDiscoveryDeps(config), q, type);
  });
}
