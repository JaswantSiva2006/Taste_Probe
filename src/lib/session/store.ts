import { AppError } from "@/lib/validation/errors";

/**
 * Authoritative session storage. A record holds the serialized session state
 * plus the fields every transition is checked against atomically: the
 * revision and an optional short-lived lease (lock) owned by one request.
 */
export type StoredSession = {
  revision: number;
  /** Lease owner while a request performs work for this revision; null when free. */
  lockId: string | null;
  /** Epoch ms after which the lease may be taken over. */
  lockUntil: number;
  /** Serialized SessionState JSON. */
  data: string;
  /** Epoch ms; the record is gone (or treated as gone) from this instant. */
  expiresAt: number;
};

export type CasExpectation = { revision: number; lockId: string | null };

/**
 * ok: written. conflict: revision (or lease ownership) changed.
 * locked: another request holds an unexpired lease. missing: no live record.
 */
export type CasResult = "ok" | "conflict" | "locked" | "missing";

export interface SessionStore {
  readonly kind: "memory" | "redis";
  /** Creates a new record; fails if the ID already exists. */
  create(sessionId: string, record: StoredSession): Promise<"ok" | "exists">;
  read(sessionId: string, now: number): Promise<StoredSession | null>;
  /**
   * Single atomic step: if the stored revision equals `expect.revision` and the
   * lease is free, expired or owned by `expect.lockId`, replace the record.
   */
  compareAndSwap(sessionId: string, expect: CasExpectation, next: StoredSession, now: number): Promise<CasResult>;
  expire(sessionId: string): Promise<void>;
}

/** Store failures never leak raw driver errors to clients. */
export const storeUnavailable = (): AppError =>
  new AppError("SESSION_STORE_UNAVAILABLE", 503, "Session storage is temporarily unavailable");

export function sessionKey(sessionId: string): string {
  return `tasteprobe:session:${sessionId}`;
}
