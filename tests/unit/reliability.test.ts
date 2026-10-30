import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { createMemoryRateLimitStore, createRedisRateLimitStore, enforceRateLimit } from "@/lib/reliability/rate-limit";
import { redactTelemetry } from "@/lib/telemetry/logger";
import { newTestSecret } from "../helpers";

const config = (overrides: Record<string, string> = {}) => loadConfig({
  NODE_ENV: "test", QLOO_MODE: "mock", SESSION_SIGNING_SECRET: newTestSecret(),
  RATE_LIMIT_ENABLED: "true", RATE_LIMIT_SEARCH_MAX: "2", RATE_LIMIT_START_MAX: "2",
  RATE_LIMIT_ANSWER_MAX: "2", RATE_LIMIT_WINDOW_SECONDS: "10", ...overrides,
});
const request = (headers: Record<string, string> = {}) => new Request("http://localhost/api/entities/search", { headers });

describe("anonymous production rate limiting", () => {
  it("allows the configured limit and returns 429 metadata before the next operation", async () => {
    const store = createMemoryRateLimitStore();
    const cfg = config();
    await enforceRateLimit(request(), cfg, "search", { store, now: 1_000 });
    await enforceRateLimit(request(), cfg, "search", { store, now: 1_001 });
    await expect(enforceRateLimit(request(), cfg, "search", { store, now: 1_002 })).rejects.toMatchObject({
      code: "RATE_LIMITED", status: 429, retryAfterSeconds: 10,
    });
  });

  it("listening feedback has its own, larger bucket that does not consume the listen/resolve allowance", async () => {
    const store = createMemoryRateLimitStore();
    const cfg = config({ RATE_LIMIT_RESOLVE_MAX: "2", RATE_LIMIT_FEEDBACK_MAX: "5" });
    expect(config().rateLimit.feedbackMax).toBe(240);
    for (let i = 0; i < 5; i++) await enforceRateLimit(request(), cfg, "feedback", { store, now: 3_000 + i });
    await expect(enforceRateLimit(request(), cfg, "feedback", { store, now: 3_010 })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await enforceRateLimit(request(), cfg, "listen", { store, now: 3_011 });
    await enforceRateLimit(request(), cfg, "listen", { store, now: 3_012 });
    await expect(enforceRateLimit(request(), cfg, "listen", { store, now: 3_013 })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("atomically limits concurrent requests", async () => {
    const store = createMemoryRateLimitStore();
    const cfg = config({ RATE_LIMIT_START_MAX: "3" });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => enforceRateLimit(request(), cfg, "start", { store, now: 2_000 })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(5);
  });

  it("opens a fresh window after expiry", async () => {
    const store = createMemoryRateLimitStore();
    const cfg = config({ RATE_LIMIT_SEARCH_MAX: "1" });
    await enforceRateLimit(request(), cfg, "search", { store, now: 10_000 });
    await expect(enforceRateLimit(request(), cfg, "search", { store, now: 10_001 })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(enforceRateLimit(request(), cfg, "search", { store, now: 20_000 })).resolves.toBeUndefined();
  });

  it("fails closed when the Redis counter is unavailable", async () => {
    const store = createRedisRateLimitStore({ eval: async () => { throw new Error("url with secret"); } } as never);
    await expect(enforceRateLimit(request(), config(), "answer", { store })).rejects.toMatchObject({ code: "SESSION_STORE_UNAVAILABLE", status: 503 });
  });

  it("does not trust forwarded IP headers unless the deployment config explicitly does", async () => {
    const store = createMemoryRateLimitStore();
    const cfg = config({ RATE_LIMIT_SEARCH_MAX: "1" });
    await enforceRateLimit(request({ "x-forwarded-for": "1.1.1.1" }), cfg, "search", { store, now: 1 });
    await expect(enforceRateLimit(request({ "x-forwarded-for": "2.2.2.2" }), cfg, "search", { store, now: 2 })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("telemetry redaction", () => {
  it("redacts secret fields and signed session tokens recursively", () => {
    const token = "v1.eyJzaWQiOiJhYmMifQ.signature";
    const redacted = redactTelemetry({ apiKey: "secret", nested: { sessionToken: token }, message: `failed ${token}` });
    expect(JSON.stringify(redacted)).not.toContain("secret");
    expect(JSON.stringify(redacted)).not.toContain("eyJzaWQi");
    expect(redacted).toMatchObject({ apiKey: "[REDACTED]", nested: { sessionToken: "[REDACTED]" } });
  });
});
