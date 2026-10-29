import { z } from "zod";
import {
  ApiFailureSchema,
  DiscoveryViewSchema,
  HealthDataSchema,
  SearchDataSchema,
  apiSuccessSchema,
  type DiscoveryView,
  type EntityType,
  type HealthData,
  type PreferenceResponse,
  type ProviderMode,
  type SearchData,
  type StartRequest,
} from "@/lib/contracts";

/** Browser client for the app's own API routes; validates every response. */

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

export type WithMode<T> = { data: T; mode: ProviderMode; requestId: string };

async function call<S extends z.ZodType>(url: string, schema: S, init?: RequestInit): Promise<WithMode<z.infer<S>>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "content-type": "application/json" }, cache: "no-store" });
  } catch {
    throw new ApiClientError("NETWORK_ERROR", "Could not reach the TasteProbe server");
  }
  const body: unknown = await res.json().catch(() => null);
  const failure = ApiFailureSchema.safeParse(body);
  if (failure.success) {
    throw new ApiClientError(failure.data.error.code, failure.data.error.message, failure.data.meta.requestId);
  }
  const envelope = apiSuccessSchema(z.unknown()).safeParse(body);
  const data = envelope.success ? schema.safeParse(envelope.data.data) : null;
  if (!envelope.success || !data?.success) {
    throw new ApiClientError("BAD_RESPONSE", `Unexpected response from ${url} (HTTP ${res.status})`);
  }
  return { data: data.data, mode: envelope.data.meta.mode, requestId: envelope.data.meta.requestId };
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  health: (): Promise<WithMode<HealthData>> => call("/api/health", HealthDataSchema),
  search: (q: string, type: EntityType): Promise<WithMode<SearchData>> =>
    call(`/api/entities/search?${new URLSearchParams({ q, type })}`, SearchDataSchema),
  start: (input: StartRequest): Promise<WithMode<DiscoveryView>> =>
    call("/api/discovery/start", DiscoveryViewSchema, post(input)),
  answer: (sessionToken: string, questionId: string, response: PreferenceResponse): Promise<WithMode<DiscoveryView>> =>
    call("/api/discovery/answer", DiscoveryViewSchema, post({ sessionToken, questionId, response })),
  finish: (sessionToken: string): Promise<WithMode<DiscoveryView>> =>
    call("/api/discovery/finish", DiscoveryViewSchema, post({ sessionToken })),
};
