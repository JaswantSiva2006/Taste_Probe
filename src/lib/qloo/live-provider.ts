import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "@/lib/config/env";
import { qlooTypeOf, type EntityType } from "@/lib/contracts";
import { logEvent } from "@/lib/telemetry/logger";
import { AppError } from "@/lib/validation/errors";
import type { QlooProvider, RecommendationRequest } from "./provider";
import type {
  ProviderResult,
  RawInsightEntity,
  RawInsightsResponse,
  RawSearchEntity,
  RawSearchResponse,
  RawTag,
} from "./raw-types";

const DEFAULT_BASE_URL = "https://hackathon.api.qloo.com";
const MAX_TAKE = 50;

const objectRecord = z.record(z.string(), z.unknown());
const searchResponseSchema = z.object({ results: z.array(z.unknown()) }).passthrough();
const insightsResponseSchema = z
  .object({ success: z.boolean(), results: z.object({ entities: z.array(z.unknown()) }).passthrough() })
  .passthrough();

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function record(value: unknown): Record<string, unknown> | undefined {
  const parsed = objectRecord.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseTags(value: unknown, idField: "tag_id" | "id"): RawTag[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const tag = record(item);
    if (!tag || !nonEmpty(tag[idField]) || !nonEmpty(tag.name) || !nonEmpty(tag.type)) return [];
    return [{ [idField]: tag[idField], name: tag.name, type: tag.type } as RawTag];
  });
}

export function parseSearchResponse(value: unknown): RawSearchResponse {
  const parsed = searchResponseSchema.safeParse(value);
  if (!parsed.success) throw new AppError("QLOO_INVALID_RESPONSE", 502, "Qloo search returned an unexpected response");
  const results = parsed.data.results.flatMap((item): RawSearchEntity[] => {
    const entity = record(item);
    const properties = record(entity?.properties);
    if (!entity || !nonEmpty(entity.entity_id) || !nonEmpty(entity.name) || !Array.isArray(entity.types)) return [];
    const types = entity.types.filter(nonEmpty);
    if (!types.length) return [];
    const releaseYear = finite(properties?.release_year);
    const publicationYear = finite(properties?.publication_year);
    return [{
      entity_id: entity.entity_id,
      name: entity.name,
      types,
      tags: parseTags(entity.tags, "tag_id"),
      ...(releaseYear === undefined && publicationYear === undefined ? {} : {
        properties: {
          ...(releaseYear === undefined ? {} : { release_year: releaseYear }),
          ...(publicationYear === undefined ? {} : { publication_year: publicationYear }),
        },
      }),
    }];
  });
  return { results };
}

export function parseInsightsResponse(value: unknown): RawInsightsResponse {
  const parsed = insightsResponseSchema.safeParse(value);
  if (!parsed.success) throw new AppError("QLOO_INVALID_RESPONSE", 502, "Qloo Insights returned an unexpected response");
  const entities = parsed.data.results.entities.flatMap((item): RawInsightEntity[] => {
    const entity = record(item);
    const properties = record(entity?.properties);
    const image = record(properties?.image);
    const query = record(entity?.query);
    if (!entity || !nonEmpty(entity.entity_id) || !nonEmpty(entity.name) || !nonEmpty(entity.subtype)) return [];
    const affinity = finite(query?.affinity);
    const popularity = finite(entity.popularity);
    const types = Array.isArray(entity.types) ? entity.types.filter(nonEmpty) : [];
    return [{
      entity_id: entity.entity_id,
      name: entity.name,
      subtype: entity.subtype,
      ...(nonEmpty(entity.type) ? { type: entity.type } : {}),
      ...(types.length ? { types } : {}),
      ...(popularity === undefined ? {} : { popularity }),
      ...(affinity === undefined && query?.explainability === undefined ? {} : {
        query: {
          ...(affinity === undefined ? {} : { affinity }),
          ...(query?.explainability === undefined ? {} : { explainability: query.explainability }),
        },
      }),
      ...(!nonEmpty(properties?.description) && !nonEmpty(image?.url) ? {} : {
        properties: {
          ...(nonEmpty(properties?.description) ? { description: properties.description } : {}),
          ...(nonEmpty(image?.url) ? { image: { url: image.url } } : {}),
        },
      }),
      tags: parseTags(entity.tags, "id"),
    }];
  });
  return { success: parsed.data.success, results: { entities } };
}

/** Wire types come from the S9.2 domain registry, never from the client. */
const typeUrn = (type: EntityType) => qlooTypeOf(type);

function appendIds(params: URLSearchParams, key: string, ids: string[] | undefined): void {
  const clean = [...new Set((ids ?? []).filter((id) => id.trim().length > 0))];
  if (clean.length) params.set(key, clean.join(","));
}

export function buildSearchUrl(baseUrl: string, query: string, type?: EntityType): URL {
  const url = new URL("/search", `${baseUrl}/`);
  url.searchParams.set("query", query.trim());
  if (type) url.searchParams.set("type", typeUrn(type));
  return url;
}

export function buildInsightsUrl(baseUrl: string, request: RecommendationRequest): URL {
  const url = new URL("/v2/insights", `${baseUrl}/`);
  url.searchParams.set("filter.type", typeUrn(request.targetType));
  appendIds(url.searchParams, "signal.interests.entities", [
    ...request.seedEntityIds,
    ...(request.positiveEntityIds ?? []),
  ]);
  appendIds(url.searchParams, "signal.interests.tags", request.positiveTagIds);
  appendIds(url.searchParams, "filter.exclude.entities", request.excludedEntityIds);
  appendIds(url.searchParams, "filter.exclude.tags", request.excludedTagIds);
  url.searchParams.set("take", String(Math.min(MAX_TAKE, Math.max(1, Math.trunc(request.take)))));
  if (request.includeExplainability) url.searchParams.set("feature.explainability", "true");
  return url;
}

function validateConfig(config: Pick<AppConfig, "qloo">): { apiKey: string; baseUrl: string; timeoutMs: number } {
  if (!config.qloo.apiKey) throw new AppError("CONFIG_ERROR", 500, "QLOO_API_KEY is required in live mode");
  const baseUrl = config.qloo.baseUrl ?? DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AppError("CONFIG_ERROR", 500, "QLOO_BASE_URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") throw new AppError("CONFIG_ERROR", 500, "QLOO_BASE_URL must use HTTPS");
  return { apiKey: config.qloo.apiKey, baseUrl: parsed.toString(), timeoutMs: config.qloo.timeoutMs };
}

function httpError(status: number): AppError {
  if (status === 401) return new AppError("QLOO_AUTH_ERROR", 502, "Qloo authentication failed");
  if (status === 403) return new AppError("QLOO_PERMISSION_ERROR", 502, "Qloo denied this request");
  if (status === 400 || status === 422) return new AppError("QLOO_BAD_REQUEST", 502, "Qloo rejected the request");
  if (status === 402 || status === 429) return new AppError("QLOO_RATE_LIMITED", 503, "Qloo quota or rate limit was reached");
  return new AppError("QLOO_UPSTREAM_ERROR", 502, "Qloo is temporarily unavailable");
}

type Fetcher = typeof fetch;

export function createLiveQlooProvider(config: Pick<AppConfig, "qloo">, fetcher: Fetcher = fetch): QlooProvider {
  const settings = validateConfig(config);

  async function request<T>(url: URL, parse: (value: unknown) => T, maxAttempts = 2): Promise<ProviderResult<T>> {
    const requestId = randomUUID();
    const allowedAttempts = Math.min(2, Math.max(1, maxAttempts));
    let attempts = 0;
    for (;;) {
      attempts += 1;
      let response: Response;
      try {
        response = await fetcher(url, {
          headers: { accept: "application/json", "X-Api-Key": settings.apiKey },
          signal: AbortSignal.timeout(settings.timeoutMs),
          cache: "no-store",
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        logEvent("warn", "qloo.request_failed", { requestId, endpoint: url.pathname, attempt: attempts, timedOut });
        throw timedOut
          ? new AppError("QLOO_TIMEOUT", 504, "Qloo request timed out")
          : new AppError("QLOO_UPSTREAM_ERROR", 502, "Unable to reach Qloo");
      }
      if (!response.ok) {
        logEvent("warn", "qloo.http_error", { requestId, endpoint: url.pathname, attempt: attempts, status: response.status });
        if (response.status >= 500 && attempts < allowedAttempts) continue;
        throw httpError(response.status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new AppError("QLOO_INVALID_RESPONSE", 502, "Qloo returned invalid JSON");
      }
      return { provenance: "qloo", requestId, requestCount: attempts, payload: parse(body) };
    }
  }

  return {
    mode: "live",
    async searchEntities(query, type) {
      if (!query.trim()) throw new AppError("VALIDATION_ERROR", 400, "Search query must not be empty");
      return request(buildSearchUrl(settings.baseUrl, query, type), parseSearchResponse);
    },
    async getEntity(entityId) {
      if (!entityId.trim()) throw new AppError("VALIDATION_ERROR", 400, "Entity ID must not be empty");
      const result = await request(buildSearchUrl(settings.baseUrl, entityId), parseSearchResponse);
      return { ...result, payload: result.payload.results.find((entity) => entity.entity_id === entityId) ?? null };
    },
    async getRecommendations(input) {
      if (!input.seedEntityIds.length) throw new AppError("VALIDATION_ERROR", 400, "At least one seed entity is required");
      return request(buildInsightsUrl(settings.baseUrl, input), parseInsightsResponse, input.maxAttempts);
    },
  };
}
