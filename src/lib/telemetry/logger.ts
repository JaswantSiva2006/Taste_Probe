/** L1 — minimal structured logging. Never pass secrets or session tokens here. */
export type LogLevel = "info" | "warn" | "error";

export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === "test") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
