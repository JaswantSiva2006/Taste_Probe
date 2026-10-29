import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { createSession, decodeSessionState, encodeSessionState, type SessionState } from "@/lib/session/state";
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

  it("restores a signed session", () => {
    const s = state();
    const token = encodeSessionState(s, settings);
    expect(decodeSessionState(token, settings, "mock", s.session.createdAt + 1).session).toEqual(s.session);
  });

  it("rejects expired sessions", () => {
    const s = state();
    const token = encodeSessionState(s, settings);
    expect(() => decodeSessionState(token, settings, "mock", s.session.expiresAt)).toThrowError(
      expect.objectContaining({ code: "SESSION_EXPIRED" }),
    );
  });

  it("rejects a mock session presented to a live server", () => {
    const s = state();
    expect(() => decodeSessionState(encodeSessionState(s, settings), settings, "live", s.session.createdAt)).toThrowError(
      expect.objectContaining({ code: "SESSION_MODE_MISMATCH" }),
    );
  });

  it("rejects a validly signed payload that is not a session", () => {
    const token = signToken({ hello: "world" }, settings.signingSecret);
    expect(() => decodeSessionState(token, settings, "mock", 0)).toThrowError(
      expect.objectContaining({ code: "INVALID_SESSION_TOKEN" }),
    );
  });

  it("refuses to encode a session that exceeds the question limit", () => {
    const s = state();
    expect(() => encodeSessionState({ ...s, session: { ...s.session, maxQuestions: 4 } }, settings)).toThrow();
  });
});

describe("configuration", () => {
  it("does not require API keys in mock mode", () => {
    const config = loadConfig({ NODE_ENV: "test", QLOO_MODE: "mock", SESSION_SIGNING_SECRET: newTestSecret() });
    expect(config.mode).toBe("mock");
    expect(config.qloo.apiKey).toBeUndefined();
    expect(config.limits.maxQuestions).toBe(3);
    expect(config.limits.finalRecommendationCount).toBe(5);
  });

  it("defaults to mock mode", () => {
    expect(loadConfig({ NODE_ENV: "test", SESSION_SIGNING_SECRET: newTestSecret() }).mode).toBe("mock");
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
