import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { createMemorySessionStore } from "@/lib/session/memory-store";
import { createSessionService } from "@/lib/session/service";
import { createSession, issueSessionToken, verifySessionToken, type SessionState } from "@/lib/session/state";
import { signToken, verifyToken } from "@/lib/session/token";
import { newTestSecret } from "../helpers";

const SEED = {
  entityId: "mock:movie:interstellar",
  name: "Interstellar",
  entityType: "movie" as const,
  provenance: "mock" as const,
};

function state(now = 1_000_000, ttlSeconds = 60): SessionState {
  return {
    session: createSession({
      anchorIds: [SEED.entityId],
      sourceType: "movie",
      targetType: "book",
      maxQuestions: 3,
      mode: "mock",
      now,
      ttlSeconds,
    }),
    seed: SEED,
    candidates: [],
    order: [],
    finishReason: null,
  };
}

describe("token signing", () => {
  const secret = newTestSecret();

  it("round-trips a payload", () => {
    expect(verifyToken(signToken({ a: 1 }, secret), secret)).toEqual({ a: 1 });
  });

  it("rejects tampered payloads, signatures, wrong secrets and garbage", () => {
    const token = signToken({ questionCount: 0 }, secret);
    const [v, body, sig] = token.split(".") as [string, string, string];
    const forgedBody = Buffer.from(JSON.stringify({ questionCount: 0, extra: true })).toString("base64url");
    for (const bad of [
      `${v}.${forgedBody}.${sig}`,
      `${v}.${body}.${sig.slice(0, -2)}AA`,
      `v2.${body}.${sig}`,
      "not-a-token",
      "",
    ]) {
      expect(() => verifyToken(bad, secret)).toThrowError(expect.objectContaining({ code: "INVALID_SESSION_TOKEN" }));
    }
    expect(() => verifyToken(token, newTestSecret())).toThrowError(expect.objectContaining({ code: "INVALID_SESSION_TOKEN" }));
  });
});

describe("session state", () => {
  const settings = { signingSecret: newTestSecret(), ttlSeconds: 60 };

  it("creates sessions with unique IDs, revision 0 and budget fields", () => {
    const a = state().session;
    const b = state().session;
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a).toMatchObject({ version: 1, revision: 0, questionCount: 0, maxQuestions: 3, qlooCallCount: 0, agentToolCallCount: 0, status: "active" });
    expect(a.expiresAt - a.createdAt).toBe(60_000);
  });

  // Sessions are stored server-side; the clock is injected and set to the session's creation time.
  const service = (s: SessionState, mode: "mock" | "live" = "mock", at = s.session.createdAt + 1, store = createMemorySessionStore()) =>
    createSessionService({ store, settings, mode, now: () => at });

  it("restores a stored session from its token", async () => {
    const s = state(Date.now());
    const store = createMemorySessionStore();
    const token = await service(s, "mock", Date.now(), store).create(s);
    const loaded = await service(s, "mock", Date.now(), store).load(token);
    expect(loaded.state.session).toEqual(s.session);
    expect(loaded.revision).toBe(0);
  });

  it("tokens carry only identity, revision and expiry", () => {
    const token = issueSessionToken({ sid: "abc", rev: 2, exp: 5_000 }, settings.signingSecret);
    const body = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    expect(Object.keys(body).sort()).toEqual(["exp", "rev", "sid", "v"]);
    expect(verifySessionToken(token, settings.signingSecret, 4_999)).toMatchObject({ sid: "abc", rev: 2 });
  });

  it("rejects expired tokens", () => {
    const token = issueSessionToken({ sid: "abc", rev: 0, exp: 5_000 }, settings.signingSecret);
    expect(() => verifySessionToken(token, settings.signingSecret, 5_000)).toThrowError(
      expect.objectContaining({ code: "SESSION_EXPIRED" }),
    );
  });

  it("rejects a mock session presented to a live server", async () => {
    const s = state(Date.now());
    const store = createMemorySessionStore();
    const token = await service(s, "mock", Date.now(), store).create(s);
    await expect(service(s, "live", Date.now(), store).load(token)).rejects.toMatchObject({ code: "SESSION_MODE_MISMATCH" });
  });

  it("rejects a validly signed payload that is not a session token", async () => {
    const token = signToken({ hello: "world" }, settings.signingSecret);
    await expect(service(state()).load(token)).rejects.toMatchObject({ code: "INVALID_SESSION_TOKEN" });
    // An S1-style token that embedded the whole state is no longer accepted.
    const legacy = signToken(state(), settings.signingSecret);
    await expect(service(state()).load(legacy)).rejects.toMatchObject({ code: "INVALID_SESSION_TOKEN" });
  });

  it("refuses to store a session that exceeds the question limit", async () => {
    const s = state();
    await expect(service(s).create({ ...s, session: { ...s.session, maxQuestions: 4 } })).rejects.toThrow();
  });
});

describe("configuration", () => {
  it("does not require API keys in mock mode", () => {
    const config = loadConfig({ NODE_ENV: "test", QLOO_MODE: "mock", SESSION_SIGNING_SECRET: newTestSecret() });
    expect(config.mode).toBe("mock");
    expect(config.qloo.apiKey).toBeUndefined();
    expect(config.limits.maxQuestions).toBe(3);
    expect(config.limits.finalRecommendationCount).toBe(5);
    expect(config.limits.maxRecommendationCandidates).toBe(50); // S9.16R verified single-request breadth
    expect(config.features.questionGenerationMode).toBe("deterministic");
  });

  it("validates the opt-in LLM-grounded question-generation mode", () => {
    expect(loadConfig({ NODE_ENV: "test", QLOO_MODE: "mock", SESSION_SIGNING_SECRET: newTestSecret(), QUESTION_GENERATION_MODE: "llm_grounded" }).features.questionGenerationMode).toBe("llm_grounded");
    expect(() => loadConfig({ NODE_ENV: "test", QLOO_MODE: "mock", SESSION_SIGNING_SECRET: newTestSecret(), QUESTION_GENERATION_MODE: "freeform" })).toThrowError(/QUESTION_GENERATION_MODE/);
  });

  it("defaults to mock mode", () => {
    expect(loadConfig({ NODE_ENV: "test", SESSION_SIGNING_SECRET: newTestSecret() }).mode).toBe("mock");
  });

  it("enables distributed rate limiting by default only in production", () => {
    const secret = newTestSecret();
    expect(loadConfig({ NODE_ENV: "test", QLOO_MODE: "mock", SESSION_SIGNING_SECRET: secret }).rateLimit.enabled).toBe(false);
    const prod = loadConfig({
      NODE_ENV: "production", QLOO_MODE: "mock", SESSION_SIGNING_SECRET: secret,
      UPSTASH_REDIS_REST_URL: "https://example-redis.upstash.io", UPSTASH_REDIS_REST_TOKEN: "token",
    });
    expect(prod.rateLimit).toMatchObject({ enabled: true, searchMax: 30, startMax: 10, answerMax: 30, windowSeconds: 600 });
  });

  it("fails production-live readiness when paid-provider configuration is incomplete", () => {
    const base = {
      NODE_ENV: "production", QLOO_MODE: "live", SESSION_SIGNING_SECRET: newTestSecret(),
      UPSTASH_REDIS_REST_URL: "https://example-redis.upstash.io", UPSTASH_REDIS_REST_TOKEN: "token",
    };
    expect(() => loadConfig(base)).toThrowError(/QLOO_API_KEY.*LLM_MODEL.*GOOGLE_API_KEY/);
    expect(loadConfig({ ...base, QLOO_API_KEY: "qloo", LLM_MODEL: "gemini-3.5-flash-lite", GOOGLE_API_KEY: "google" }).sessionStore.kind).toBe("redis");
  });

  it("requires a signing secret in live mode and in production", () => {
    expect(() => loadConfig({ NODE_ENV: "development", QLOO_MODE: "live" })).toThrowError(
      expect.objectContaining({ code: "CONFIG_ERROR" }),
    );
    expect(() => loadConfig({ NODE_ENV: "production", QLOO_MODE: "mock" })).toThrowError(
      expect.objectContaining({ code: "CONFIG_ERROR" }),
    );
  });

  it("uses an ephemeral random secret only for non-production mock mode", () => {
    const config = loadConfig({ NODE_ENV: "development", QLOO_MODE: "mock" });
    expect(config.session.secretIsEphemeral).toBe(true);
    expect(config.session.signingSecret.length).toBeGreaterThanOrEqual(32);
  });

  describe("session store selection (fail closed in production)", () => {
    const prod = { NODE_ENV: "production", QLOO_MODE: "mock", SESSION_SIGNING_SECRET: newTestSecret() };
    const redisEnv = { UPSTASH_REDIS_REST_URL: "https://example-redis.upstash.io", UPSTASH_REDIS_REST_TOKEN: "test-token-not-real" };

    it("uses memory outside production by default", () => {
      expect(loadConfig({ NODE_ENV: "test", SESSION_SIGNING_SECRET: newTestSecret() }).sessionStore).toEqual({ kind: "memory" });
      expect(loadConfig({ NODE_ENV: "development", QLOO_MODE: "mock" }).sessionStore.kind).toBe("memory");
    });

    it("refuses production without Redis credentials, naming only the variables", () => {
      for (const env of [prod, { ...prod, UPSTASH_REDIS_REST_URL: redisEnv.UPSTASH_REDIS_REST_URL }, { ...prod, UPSTASH_REDIS_REST_TOKEN: "x".repeat(20) }]) {
        expect(() => loadConfig(env)).toThrowError(
          expect.objectContaining({ code: "CONFIG_ERROR", message: expect.stringContaining("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN") }),
        );
      }
      try {
        loadConfig({ ...prod, UPSTASH_REDIS_REST_TOKEN: "secret-token-value" });
      } catch (e) {
        expect((e as Error).message).not.toContain("secret-token-value");
      }
    });

    it("never allows the memory store in production, even when requested", () => {
      expect(() => loadConfig({ ...prod, ...redisEnv, SESSION_STORE: "memory" })).toThrowError(
        expect.objectContaining({ code: "CONFIG_ERROR", message: expect.stringContaining("not allowed in production") }),
      );
    });

    it("selects Redis in production when configured, and requires HTTPS", () => {
      expect(loadConfig({ ...prod, ...redisEnv }).sessionStore).toEqual({ kind: "redis", url: redisEnv.UPSTASH_REDIS_REST_URL, token: redisEnv.UPSTASH_REDIS_REST_TOKEN });
      expect(() => loadConfig({ ...prod, ...redisEnv, UPSTASH_REDIS_REST_URL: "http://plain.example" })).toThrowError(/HTTPS/);
    });

    it("lets development opt into Redis but still requires credentials", () => {
      expect(() => loadConfig({ NODE_ENV: "development", QLOO_MODE: "mock", SESSION_STORE: "redis" })).toThrowError(
        expect.objectContaining({ code: "CONFIG_ERROR" }),
      );
      expect(loadConfig({ NODE_ENV: "development", QLOO_MODE: "mock", SESSION_STORE: "redis", ...redisEnv }).sessionStore.kind).toBe("redis");
    });
  });

  it("rejects short secrets, out-of-range limits and bad modes without echoing values", () => {
    expect(() => loadConfig({ QLOO_MODE: "mock", SESSION_SIGNING_SECRET: "short" })).toThrowError(/at least 32/);
    let message = "";
    try {
      loadConfig({ QLOO_MODE: "prod", MAX_QUESTIONS: "9", SESSION_SIGNING_SECRET: newTestSecret() });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("QLOO_MODE");
    expect(message).toContain("MAX_QUESTIONS");
    expect(message).not.toContain("prod");
  });
});
