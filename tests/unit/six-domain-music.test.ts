import { expect, it } from "vitest";
import { DOMAINS, type EntityType } from "@/lib/contracts";
import { buildInsightsUrl, buildSearchUrl } from "@/lib/qloo/live-provider";
import { normalizeTargetCandidates } from "@/lib/discovery/normalize";
import { loadConfig } from "@/lib/config/env";

it.each(["movie", "book", "music_artist", "tv_show", "video_game", "podcast"] as EntityType[])("%s preserves its source type and requests artists", (source) => {
  expect(buildSearchUrl("https://hackathon.api.qloo.com", "example", source).searchParams.get("type")).toBe(DOMAINS[source].qlooType);
  const url = buildInsightsUrl("https://hackathon.api.qloo.com", { seedEntityIds: ["SOURCE-ID"], targetType: "music_artist", take: 8 });
  expect(url.searchParams.get("filter.type")).toBe("urn:entity:artist");
  expect(url.searchParams.get("signal.interests.entities")).toBe("SOURCE-ID");
});

it("excludes the original artist by canonical identity from normalized discovery results", () => {
  const result = normalizeTargetCandidates({ provenance: "qloo", requestId: "test", requestCount: 1, payload: {
    success: true, results: { entities: [
      { entity_id: "ABCDEFAB-0000-0000-0000-000000000001", name: "Source artist", subtype: "urn:entity:artist", tags: [] },
      { entity_id: "ABCDEFAB-0000-0000-0000-000000000002", name: "Different artist", subtype: "urn:entity:artist", tags: [] },
    ] },
  } }, ["abcdefab-0000-0000-0000-000000000001"], 8, { targetType: "music_artist", provenance: "qloo" });
  expect(result.candidates.map((candidate) => candidate.name)).toEqual(["Different artist"]);
  expect(result.rejected).toBe(1);
});

it("refuses the local QA certificate bypass in production", () => {
  expect(() => loadConfig({ NODE_ENV: "production", NODE_TLS_REJECT_UNAUTHORIZED: "0" })).toThrow("TLS certificate verification cannot be disabled in production");
});
