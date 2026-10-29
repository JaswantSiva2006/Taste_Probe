import "server-only";
import { randomUUID } from "node:crypto";
import type { ProviderMode } from "@/lib/contracts";
import { AppError } from "@/lib/validation/errors";
import {
  SessionStateSchema,
  issueSessionToken,
  verifySessionToken,
  type SessionSettings,
  type SessionState,
} from "./state";
import { storeUnavailable, type CasResult, type SessionStore, type StoredSession } from "./store";

/**
 * G2 session service: server-authoritative, replay-safe transitions.
 *
 * - The token only authenticates {sessionId, revision, expiry}.
 * - load() rejects any token whose revision is not the store's current one.
 * - Work that may call external services first takes a lease via CAS, so two
 *   requests for the same revision can never both proceed.
 * - commit() advances the revision by exactly one via CAS; release() frees the
 *   lease without advancing it but keeps consumed usage counters.
 */

/** Longer than a worst-case turn (2 Qloo attempts x timeout + agent); expired leases can be taken over. */
export const LEASE_TTL_MS = 60_000;

export type LoadedSession = { sessionId: string; revision: number; state: SessionState; expiresAt: number };
export type Lease = { sessionId: string; revision: number; lockId: string; expiresAt: number };
type Owner = { sessionId: string; revision: number; lockId: string | null; expiresAt: number };

export type SessionService = {
  create(state: SessionState): Promise<string>;
  load(token: string): Promise<LoadedSession>;
  acquire(loaded: LoadedSession): Promise<Lease>;
  /** Writes `next` as revision+1 and returns the new token. Pass a lease or the loaded session (lock-free). */
  commit(owner: Lease | LoadedSession, next: SessionState): Promise<string>;
  /** Frees a lease without a transition, persisting `state` (used to keep consumed usage counters). */
  release(lease: Lease, state: SessionState): Promise<void>;
  /** Token for the current revision (read-only responses). */
  tokenFor(loaded: LoadedSession): string;
};

export function createSessionService(opts: {
  store: SessionStore;
  settings: SessionSettings;
  mode: ProviderMode;
  now?: () => number;
  /** Lease lifetime; callers whose turn can outlast LEASE_TTL_MS pass a longer bound. */
  leaseTtlMs?: number;
}): SessionService {
  const { store, settings, mode } = opts;
  const now = opts.now ?? Date.now;
  const token = (sessionId: string, revision: number, expiresAt: number) =>
    issueSessionToken({ sid: sessionId, rev: revision, exp: expiresAt }, settings.signingSecret);

  const serialize = (state: SessionState, revision: number) =>
    JSON.stringify(SessionStateSchema.parse({ ...state, session: { ...state.session, revision } }));

  function rejectCas(result: CasResult): never {
    if (result === "missing") throw new AppError("SESSION_EXPIRED", 401, "Session has expired; start a new discovery");
    throw new AppError(
      "SESSION_REVISION_CONFLICT",
      409,
      result === "locked"
        ? "This session is being updated by another request"
        : "This session has changed since this token was issued",
    );
  }

  async function swap(owner: Owner, next: Omit<StoredSession, "expiresAt">): Promise<void> {
    const result = await store.compareAndSwap(
      owner.sessionId,
      { revision: owner.revision, lockId: owner.lockId },
      { ...next, expiresAt: owner.expiresAt },
      now(),
    );
    if (result !== "ok") rejectCas(result);
  }

  const ownerOf = (o: Lease | LoadedSession): Owner => ({
    sessionId: o.sessionId,
    revision: o.revision,
    lockId: "lockId" in o ? o.lockId : null,
    expiresAt: o.expiresAt,
  });

  return {
    async create(state) {
      const { sessionId, expiresAt } = state.session;
      const created = await store.create(sessionId, {
        revision: 0,
        lockId: null,
        lockUntil: 0,
        data: serialize(state, 0),
        expiresAt,
      });
      // A UUID collision is practically impossible; never overwrite an existing session.
      if (created !== "ok") throw storeUnavailable();
      return token(sessionId, 0, expiresAt);
    },

    async load(raw) {
      const at = now();
      const claims = verifySessionToken(raw, settings.signingSecret, at);
      const record = await store.read(claims.sid, at);
      if (!record || at >= record.expiresAt) {
        throw new AppError("SESSION_EXPIRED", 401, "Session has expired; start a new discovery");
      }
      if (record.revision !== claims.rev) {
        throw new AppError("SESSION_REVISION_CONFLICT", 409, "This session has changed since this token was issued");
      }
      let parsed;
      try {
        parsed = SessionStateSchema.safeParse(JSON.parse(record.data));
      } catch {
        parsed = null;
      }
      if (!parsed?.success || parsed.data.session.sessionId !== claims.sid) throw storeUnavailable();
      const state = parsed.data;
      if (state.session.mode !== mode) {
        throw new AppError("SESSION_MODE_MISMATCH", 409, "Session was created in a different provider mode");
      }
      return { sessionId: claims.sid, revision: record.revision, state, expiresAt: record.expiresAt };
    },

    async acquire(loaded) {
      const lockId = randomUUID();
      await swap(ownerOf(loaded), {
        revision: loaded.revision,
        lockId,
        lockUntil: now() + Math.max(LEASE_TTL_MS, opts.leaseTtlMs ?? 0),
        data: serialize(loaded.state, loaded.revision),
      });
      return { sessionId: loaded.sessionId, revision: loaded.revision, lockId, expiresAt: loaded.expiresAt };
    },

    async commit(owner, next) {
      const o = ownerOf(owner);
      const revision = o.revision + 1;
      await swap(o, { revision, lockId: null, lockUntil: 0, data: serialize(next, revision) });
      return token(o.sessionId, revision, o.expiresAt);
    },

    async release(lease, state) {
      await swap(ownerOf(lease), {
        revision: lease.revision,
        lockId: null,
        lockUntil: 0,
        data: serialize(state, lease.revision),
      });
    },

    tokenFor(loaded) {
      return token(loaded.sessionId, loaded.revision, loaded.expiresAt);
    },
  };
}
