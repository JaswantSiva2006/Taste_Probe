import "server-only";
import { randomUUID } from "node:crypto";
import { ZodError, type z } from "zod";
import type { ApiFailure, ApiSuccess, ProviderMode } from "@/lib/contracts";
import { loadConfig, readProviderMode, type AppConfig } from "@/lib/config/env";
import { logEvent } from "@/lib/telemetry/logger";
import { AppError } from "./errors";

/** Shared route-handler plumbing: request IDs, config, validation and the JSON envelope. */

export type RouteContext = { requestId: string; config: AppConfig };

function json(body: ApiSuccess<unknown> | ApiFailure, status: number, requestId: string): Response {
  return Response.json(body, {
    status,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}

function describeZodError(error: ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export async function handleApi<T>(
  route: string,
  handler: (ctx: RouteContext) => Promise<T>,
): Promise<Response> {
  const requestId = randomUUID();
  let mode: ProviderMode = readProviderMode();
  try {
    const config = loadConfig();
    mode = config.mode;
    const data = await handler({ requestId, config });
    return json({ ok: true, data, meta: { requestId, mode } }, 200, requestId);
  } catch (error) {
    const fail = (code: ApiFailure["error"]["code"], message: string, status: number) =>
      json({ ok: false, error: { code, message }, meta: { requestId, mode } }, status, requestId);

    if (error instanceof ZodError) {
      return fail("VALIDATION_ERROR", describeZodError(error), 400);
    }
    if (error instanceof AppError) {
      logEvent(error.status >= 500 ? "error" : "warn", "api.error", { route, requestId, code: error.code });
      return fail(error.code, error.message, error.status);
    }
    logEvent("error", "api.unhandled", {
      route,
      requestId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return fail("INTERNAL_ERROR", "Unexpected server error", 500);
  }
}

export async function parseJsonBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError("INVALID_JSON", 400, "Request body must be valid JSON");
  }
  return schema.parse(body);
}

export function parseQuery<S extends z.ZodType>(request: Request, schema: S): z.infer<S> {
  const params = new URL(request.url).searchParams;
  return schema.parse(Object.fromEntries(params.entries()));
}
