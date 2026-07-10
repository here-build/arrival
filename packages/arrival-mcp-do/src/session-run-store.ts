/**
 * `AsyncSessionStore` over Durable Object storage — the serverless materialization of the
 * session's durable twin (arrival-mcp rework doc §2.4).
 *
 * The logical record (`SessionRunState`) DECOMPOSES over storage keys — a DO value caps at
 * 128KiB, so one-blob-per-session is structurally over the limit on any real session:
 *
 *   run:meta       → SessionRunState minus log/cache (identity, counters, timestamps)
 *   run:log:<n>    → LogStatement[] chunks (greedy, bounded well under the value cap)
 *   run:cache:<n>  → ONE cache entry per storage key, as {k, e} (the key rides the value —
 *                    a run-cache key is canonicalJson of the penetration and can exceed the
 *                    2KiB DO KEY cap, so it can never be the storage key itself)
 *
 * `set` re-decomposes the whole record and deletes stale chunk keys past the new counts;
 * `get` reassembles. Both speak the interface's string-blob contract (the encode/decode
 * round-trip is `arrival-mcp`'s own), so `DiscoveryTool`'s injected-store path is untouched.
 *
 * LIMIT (named in the doc): a SINGLE cache entry outgrowing a DO value is the residual
 * exposure — the `PayloadStore` tiering shapes are the graduation seam, designed not built.
 *
 * TTL: `set`'s `ttlMs` opt is IGNORED here — the session DO's alarm owns expiry (one reaper
 * for the whole session, not per-key bookkeeping).
 *
 * Written against a STRUCTURAL slice of `DurableObjectStorage` so plain-node tests can fake
 * it with a Map.
 *
 * ONE copy, shared by both products' session DOs through `ArrivalMcpRunnerDO` (this file
 * used to be deliberately mirrored across the two workers — that duplication collapsed
 * into this package).
 */
import {
  decodeSessionRunState,
  isSessionRunState,
  type LogStatement,
  type SessionRunState,
} from "@here.build/arrival-mcp";
import type { AsyncSessionStore } from "@here.build/mcp-substrate";

/** The storage surface this store touches — satisfied by `DurableObjectState.storage`. */
export interface StorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
}

const META_KEY = "run:meta";
const LOG_PREFIX = "run:log:";
const CACHE_PREFIX = "run:cache:";

/** Greedy chunk bound (JSON chars ≈ bytes for our ASCII-heavy payloads) — half the 128KiB
 *  DO value cap, headroom for structured-clone overhead. */
const CHUNK_BUDGET = 64 * 1024;

/** One serialized cache entry: the run-cache key rides the VALUE (see module header). */
interface StoredCacheEntry {
  k: string;
  e: unknown;
}

type StoredMeta = Omit<SessionRunState, "log" | "cache">;

/** Greedy statement chunking: consecutive statements share a chunk while the sum of their
 *  encoded sizes stays under budget; one oversized statement gets its own chunk (the value
 *  cap is then the honest failure, not silent truncation). */
function chunkLog(log: readonly LogStatement[]): LogStatement[][] {
  const chunks: LogStatement[][] = [];
  let current: LogStatement[] = [];
  let size = 0;
  for (const stmt of log) {
    const cost = stmt.src.length + (stmt.definedName?.length ?? 0) + 32;
    if (current.length > 0 && size + cost > CHUNK_BUDGET) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(stmt);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** DO `put(Record)` accepts max 128 pairs per call — batch accordingly. */
async function putAll(storage: StorageLike, entries: Record<string, unknown>): Promise<void> {
  const pairs = Object.entries(entries);
  for (let i = 0; i < pairs.length; i += 128) {
    await storage.put(Object.fromEntries(pairs.slice(i, i + 128)));
  }
}

export function createDoSessionRunStore(storage: StorageLike): AsyncSessionStore {
  return {
    /** Reassemble the decomposed record into the interface's one string blob. */
    async get(_sessionId: string): Promise<string | undefined> {
      const meta = await storage.get<StoredMeta>(META_KEY);
      if (meta === undefined) return undefined;
      const logChunks = await storage.list<LogStatement[]>({ prefix: LOG_PREFIX });
      const cacheEntries = await storage.list<StoredCacheEntry>({ prefix: CACHE_PREFIX });
      // Chunk keys are zero-padded (`n8` below) so lexicographic list order IS chunk order.
      const log = [...logChunks.entries()].toSorted(([a], [b]) => a.localeCompare(b)).flatMap(([, chunk]) => chunk);
      const cache = Object.fromEntries([...cacheEntries.values()].map(({ k, e }) => [k, e]));
      const state = { ...meta, log, cache };
      // Guard the reassembled shape the same way decode guards a blob — a mismatched layout
      // self-heals through decode's salvage path rather than crashing the session.
      const blob = JSON.stringify(state);
      return decodeSessionRunState(blob) === undefined ? undefined : blob;
    },

    /** Decompose and persist. AWAITED by the caller before the tool result is sent (the
     *  "durably confirmed" bar); inside a DO the output gate additionally holds the response
     *  until these writes commit. */
    async set(_sessionId: string, value: string): Promise<void> {
      const parsed: unknown = JSON.parse(value);
      if (!isSessionRunState(parsed)) {
        throw new Error("session-run-store: refusing to persist a non-SessionRunState blob");
      }
      const { log, cache, ...meta } = parsed;

      const entries: Record<string, unknown> = { [META_KEY]: meta };
      const logChunks = chunkLog(log);
      for (const [i, chunk] of logChunks.entries()) {
        entries[`${LOG_PREFIX}${n8(i)}`] = chunk;
      }
      const cacheKeys = Object.keys(cache);
      for (const [i, k] of cacheKeys.entries()) {
        entries[`${CACHE_PREFIX}${n8(i)}`] = { k, e: cache[k] } satisfies StoredCacheEntry;
      }
      await putAll(storage, entries);

      // Delete stale chunk keys past the new counts (a shrunk log / dropped cache).
      const stale: string[] = [];
      const staleLog = await storage.list({ prefix: LOG_PREFIX });
      for (const key of staleLog.keys()) {
        if (chunkIndex(key, LOG_PREFIX) >= logChunks.length) stale.push(key);
      }
      const staleCache = await storage.list({ prefix: CACHE_PREFIX });
      for (const key of staleCache.keys()) {
        if (chunkIndex(key, CACHE_PREFIX) >= cacheKeys.length) stale.push(key);
      }
      if (stale.length > 0) await storage.delete(stale);
    },

    async delete(_sessionId: string): Promise<void> {
      const logKeys = await storage.list({ prefix: LOG_PREFIX });
      const cacheKeys = await storage.list({ prefix: CACHE_PREFIX });
      await storage.delete([META_KEY, ...logKeys.keys(), ...cacheKeys.keys()]);
    },
  };
}

/** Zero-padded chunk ordinal — keeps `list` order = chunk order without a numeric sort. */
function n8(i: number): string {
  return String(i).padStart(8, "0");
}

function chunkIndex(key: string, prefix: string): number {
  return Number(key.slice(prefix.length));
}
