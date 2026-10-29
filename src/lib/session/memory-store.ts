import type { CasExpectation, CasResult, SessionStore, StoredSession } from "./store";

/**
 * Single-process store for development, mock mode and tests. Each operation
 * runs synchronously between awaits, so transitions are atomic within one
 * Node.js process. It gives NO cross-instance guarantees.
 */
export function createMemorySessionStore(): SessionStore {
  const records = new Map<string, StoredSession>();

  const live = (id: string, now: number): StoredSession | null => {
    const record = records.get(id);
    if (!record) return null;
    if (now >= record.expiresAt) {
      records.delete(id);
      return null;
    }
    return record;
  };

  return {
    kind: "memory",

    async create(id, record) {
      if (live(id, Date.now())) return "exists";
      records.set(id, { ...record });
      return "ok";
    },

    async read(id, now) {
      const record = live(id, now);
      return record ? { ...record } : null;
    },

    async compareAndSwap(id: string, expect: CasExpectation, next: StoredSession, now: number): Promise<CasResult> {
      const current = live(id, now);
      if (!current) return "missing";
      if (current.revision !== expect.revision) return "conflict";
      const leaseActive = current.lockId !== null && current.lockUntil > now;
      if (leaseActive && current.lockId !== expect.lockId) return "locked";
      if (expect.lockId !== null && current.lockId !== expect.lockId) return "conflict";
      records.set(id, { ...next });
      return "ok";
    },

    async expire(id) {
      records.delete(id);
    },
  };
}
