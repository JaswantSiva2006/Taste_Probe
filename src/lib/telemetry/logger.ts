/** L1 — minimal structured logging. Never pass secrets or session tokens here. */
export type LogLevel = "info" | "warn" | "error";

const SECRET_KEY = /(?:api.?key|authorization|cookie|password|secret|session.?token|redis.*token|credential)/i;
const TOKEN_VALUE = /\bv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

export function redactTelemetry(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(TOKEN_VALUE, "[REDACTED]").slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactTelemetry(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, redactTelemetry(item, name)]));
  }
  return value;
}

export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === "test") return;
  const line = JSON.stringify(redactTelemetry({ ts: new Date().toISOString(), level, event, ...fields }));
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
