import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/validation/errors";

/**
 * Stateless HMAC-SHA256 signed tokens: `v1.<base64url(json)>.<base64url(sig)>`.
 * Provides integrity only (payload is readable, not encrypted) and no replay
 * protection: an older valid token can be resubmitted until it expires (S4).
 */

const VERSION = "v1";

const sign = (data: string, secret: string) => createHmac("sha256", secret).update(data).digest();

export function signToken(payload: unknown, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const data = `${VERSION}.${body}`;
  return `${data}.${sign(data, secret).toString("base64url")}`;
}

const invalid = () => new AppError("INVALID_SESSION_TOKEN", 401, "Session token is invalid");

export function verifyToken(token: string, secret: string): unknown {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) throw invalid();
  const [version, body, signature] = parts as [string, string, string];
  const expected = sign(`${version}.${body}`, secret);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
}
