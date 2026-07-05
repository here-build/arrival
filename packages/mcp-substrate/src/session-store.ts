/** "Map but async" (V, 2026-07-05) — generalizes manifold's `exportSession`/`restoreSession` for
 *  future TTL-offload storage of long-running sessions. The runner serializes its FULL
 *  teaching-state bundle (history, cache, competence window, futility rings, DoorSession dedup,
 *  context-ring — all plain-data-serializable) into ONE JSON blob per session, round-tripped
 *  through `get`/`set`. Fixes a real gap found in the original `exportSession`: it only exported
 *  `{history, cache}`, silently dropping competence/futility/dedup/context-ring state on
 *  rehydration. */
export interface AsyncSessionStore {
  get(sessionId: string): Promise<string | undefined>;
  set(sessionId: string, value: string, opts?: { ttlMs?: number }): Promise<void>;
  delete?(sessionId: string): Promise<void>;
}

/** Zero-config default — a `Map` wrapped in resolved promises. No TTL enforcement (single
 *  process, no eviction); a real TTL-offload store is a later, separate concern. */
export function createInMemorySessionStore(): AsyncSessionStore {
  const store = new Map<string, string>();
  return {
    get: async (sessionId) => store.get(sessionId),
    set: async (sessionId, value) => {
      store.set(sessionId, value);
    },
    delete: async (sessionId) => {
      store.delete(sessionId);
    },
  };
}
