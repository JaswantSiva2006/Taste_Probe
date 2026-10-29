import "server-only";

/**
 * Minimal Gemini REST transport (the protocol verified in S2):
 * POST {base}/models/{model}:generateContent with header x-goog-api-key.
 * Injected into the agent so tests never make paid calls.
 */

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiHttpResponse = { status: number; body: unknown };
export type GeminiTransport = (request: { model: string; body: unknown; timeoutMs: number }) => Promise<GeminiHttpResponse>;

/** Transport-level failure with no provider details (they can echo request data). */
export class GeminiTransportError extends Error {
  constructor(public readonly kind: "timeout" | "network") {
    super(kind === "timeout" ? "Gemini request timed out" : "Gemini request failed");
    this.name = "GeminiTransportError";
  }
}

export function createFetchGeminiTransport(apiKey: string, fetcher: typeof fetch = fetch): GeminiTransport {
  return async ({ model, body, timeoutMs }) => {
    let response: Response;
    try {
      response = await fetcher(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new GeminiTransportError(timedOut ? "timeout" : "network");
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  };
}
