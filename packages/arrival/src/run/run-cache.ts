/**
 * run-cache — the first-class run cache, the membrane's record/replay interception. Sibling of
 * RunContext: a run's durable twin is `(program, cache)`, and a cache can outlive its program to
 * answer a full re-run of a NEW program over the SAME cache (content-keyed). It intercepts at the
 * baked rosetta `run` wrapper — the ONE chokepoint where args are decoded and the impl has not
 * fired (docs/RUN-MODEL.md §CHOKEPOINT), gating on the def's EXPLICIT cache class plus the `sink`
 * lineage role for the tombstone skip.
 *
 * The model in full — single-flight, the run-level / no-session-plumbing rule, the burst arm that
 * rides the same chokepoint, and the two meanings of "replay" — is docs/RUN-MODEL.md §MODE-LAW,
 * §BURST, §TWO-REPLAYS.
 *
 * THE MODE LAW (record vs replay, per class) — mirrored in docs/RUN-MODEL.md §MODE-LAW; keep the
 * two tables in step:
 *
 *   class      | record mode                          | replay mode
 *   -----------|--------------------------------------|-------------------------------
 *   view       | fire, write/OVERWRITE `{value}`      | hit → serve, never re-fire;
 *              | (a settled entry never suppresses    | miss → fire + write (a NEW
 *              | a live fire — fresh truth)           | program's novel call is fresh)
 *   sink       | fire, write `{effect}` tombstone     | tombstone hit → skip (void);
 *              | (two identical live sinks = TWO      | miss → fire (new intent, not
 *              | effects, always)                     | a repeat)
 *   pure       | fire                                 | fire — determinism from args is
 *              |                                      | the CONTRACT; recovery = re-call,
 *              |                                      | never stored
 *   undeclared | fire                                 | fire — regenerateable, the SAFE
 *              |                                      | default
 */

import type { EffectLog } from "./effect-log.js";
import type { ReadTracker } from "./read-guard.js";

export type RunCacheEntry =
  | { kind: "value"; value: unknown } // a `view` result — the decoded-face JS value,
  //   JSON-serializable by the view shape gate
  | { kind: "effect" }; // tombstone — the effect (sink) fired in a recorded run

export interface RunCache {
  /** mode governs the membrane, not storage: "record" = live run (impl fires, result
   *  written); "replay" = fold (hit answers without firing; effect tombstone skips). */
  readonly mode: "record" | "replay";
  get(key: string): Promise<RunCacheEntry | undefined>;
  set(key: string, entry: RunCacheEntry): Promise<void>;
}

/** The in-memory materialization — a `Map` with the async face (in-memory always while a run
 *  executes). `entries` is deliberately readable: the session layer serializes SETTLED entries
 *  from it, and a replay cache is constructed OVER a recorded one's entries. Mode is fixed at
 *  construction — a rehydration builds a NEW replay cache over the same entries, never flips a
 *  live one. */
export class MemoryRunCache implements RunCache {
  readonly entries: Map<string, RunCacheEntry>;

  constructor(
    readonly mode: "record" | "replay",
    entries?: Iterable<readonly [string, RunCacheEntry]>,
  ) {
    this.entries = new Map(entries);
  }

  get(key: string): Promise<RunCacheEntry | undefined> {
    return Promise.resolve(this.entries.get(key));
  }

  set(key: string, entry: RunCacheEntry): Promise<void> {
    this.entries.set(key, entry);
    return Promise.resolve();
  }
}

/**
 * NORMATIVE canonical JSON: object keys recursively SORTED; arrays order-preserving; input
 * is DECODED (post-zod) values only, so codec coercion is already normalized before keying.
 * `undefined` cannot occur (zod output) — one arriving anyway throws rather than silently
 * canonicalizing two different shapes to one text. Numbers serialize as plain JSON numbers
 * (non-finite throw). Anything JSON cannot represent (function, symbol, bigint, a non-plain
 * object — class instances, Map/Set) THROWS: a value that cannot canonicalize cannot be a
 * cache key, and the caller decides the fallback (a `pure` key failure falls back to an
 * unshared fire; a `view` key is total BY CONSTRUCTION — its shape gate admits data codecs
 * only).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: a non-finite number (${value}) is not JSON — it cannot key a cache entry`);
      }
      return JSON.stringify(value);
    case "undefined":
      throw new TypeError(
        "canonicalJson: `undefined` cannot occur in decoded (post-zod) values — refusing to canonicalize it away",
      );
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: a ${typeof value} is not JSON-representable — it cannot key a cache entry`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      "canonicalJson: a non-plain object (class instance / Map / Set / …) has no canonical JSON form — it cannot key a cache entry",
    );
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(",")}}`;
}

/** FNV-1a over a prefixed canonical string — the codebase's content-hash idiom (prefix tag +
 *  `|`-joined canonical parts, FNV-1a, zero-padded hex). A local copy, deliberately NOT
 *  imported from the sibling hash sites (`hashSteps`, wireframe hash): different domains (a
 *  sealed env chain, a wireframe graph, this one a membrane penetration) that must be free to
 *  drift independently. */
function fnv1a(prefix: string, canonical: string): string {
  const tagged = `${prefix}|${canonical}`;
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < tagged.length; i++) {
    h ^= tagged.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The content key: `hash(symbolName ‖ canonicalJson(decodedArgs))` — keyed by PENETRATION
 *  CONTENT, not by position: a NEW program shares no positions with the recorded one; only
 *  (node, args) survives program edits. Throws whatever `canonicalJson` throws — the caller
 *  owns the fallback. */
export function runCacheKey(symbolName: string, decodedArgs: readonly unknown[]): string {
  return fnv1a("runcache-v0", `${symbolName}|${canonicalJson(decodedArgs)}`);
}

/** The stamped cache class, as this module needs it — structurally identical to `_bake.ts`'s
 *  `CacheClass` but declared locally: values/ is BELOW common/ in the import DAG, so this leaf
 *  must not reach up for the type. */
export type RunCacheClass = "view" | "pure";

/** Per-cache in-flight registry (single-flight). WeakMap keyed by the cache ENTITY: the pending
 *  map's lifetime IS the run cache's residency — no module-level state outlives it (hermetic),
 *  and two concurrent runs sharing one isolate never see each other's pendings unless they
 *  deliberately share one cache. */
const inFlight = new WeakMap<RunCache, Map<string, Promise<unknown>>>();

function pendingFor(cache: RunCache): Map<string, Promise<unknown>> {
  let map = inFlight.get(cache);
  if (map === undefined) {
    map = new Map();
    inFlight.set(cache, map);
  }
  return map;
}

/** Single-flight fire for the `view`/`pure` classes: register the in-flight promise BEFORE
 *  awaiting so concurrent identical penetrations share one impl call; settle removes the pending
 *  entry either way (rejection = eviction, retries allowed; `view` success = the settled
 *  `{value}` written to the cache). */
async function sharedFire(
  cache: RunCache,
  key: string,
  persist: boolean, // true = view (write the settled value), false = pure (never stored)
  fire: () => Promise<unknown>,
): Promise<unknown> {
  const pending = pendingFor(cache);
  const existing = pending.get(key);
  if (existing !== undefined) return existing;
  const p = fire();
  pending.set(key, p);
  try {
    const value = await p;
    if (persist) await cache.set(key, { kind: "value", value });
    return value;
  } finally {
    pending.delete(key);
  }
}

/**
 * THE INTERCEPTION — called by the baked rosetta `run` wrapper between arg decode and impl
 * fire, in place of the bare fire. Implements the mode law (file header) for the penetration
 * `(symbolName, decodedArgs)`; the arm each class takes is snapshotted at the branch below.
 *
 * `effects`, `reads`, and `penetration.rawArgs` are the sibling inputs the table does not
 * cover:
 *
 * `effects` is a sibling parameter, not a `cache` field: a burst run may gather effects with
 * no `RunCache` at all, or alongside a `view`/`pure` cache — independent lifecycles.
 *
 * `reads` is read-only here: when present, a gathered effect's `enqueuedAtReadClock` is stamped
 * from `reads.log.length` at enqueue time — the guard's comparison point. Absent ⇒ no clock
 * (the guard treats it as `0`, every read counts). This function never CHECKS the guard (that
 * is `checkReadWriteGuard`, run by the eval loop after each form) — it only stamps the clock at
 * the one point its value is known.
 *
 * `penetration.rawArgs` carries the boxed, pre-decode args onto a gathered `EffectEntry`
 * verbatim — never inspected here: a confirmation-manifest host needs the provenance-carrying
 * originals to compute per-argument lineage and reconstruct the effect's minimal re-runnable
 * invocation, neither of which `decodedArgs` (JS-plain, identity-stripped) can serve alone.
 */
export async function penetrateThroughCache(
  cache: RunCache | undefined,
  penetration: { symbolName: string; cacheClass: RunCacheClass | undefined; sink: boolean; rawArgs?: readonly unknown[] },
  decodedArgs: readonly unknown[],
  fire: () => Promise<unknown>,
  effects?: EffectLog,
  reads?: ReadTracker,
): Promise<unknown> {
  const { symbolName, cacheClass, sink, rawArgs } = penetration;

  // THE BURST ARM — a sink during a PRIME run (no cache, or cache.mode === "record")
  // gathers instead of firing. `cache?.mode === "replay"` excludes a fold: a fold re-runs
  // the recorded log and must hit the tombstone-skip path below, never gather twice. Sound
  // by the void-family bake gate (docs/RUN-MODEL.md §BURST): the program structurally cannot
  // read what a sink returns, so the deferral is unobservable.
  if (sink && effects !== undefined && cache?.mode !== "replay") {
    effects.enqueue({
      verbName: symbolName,
      decodedArgs,
      ...(reads === undefined ? {} : { enqueuedAtReadClock: reads.log.length }),
      ...(rawArgs === undefined ? {} : { rawArgs }),
    });
    return undefined;
  }

  if (cache === undefined) return fire();

  if (sink) {
    let key: string;
    try {
      key = runCacheKey(symbolName, decodedArgs);
    } catch {
      return fire(); // unkeyable sink args — honest plain fire, no tombstone
    }
    if (cache.mode === "replay") {
      const entry = await cache.get(key);
      if (entry?.kind === "effect") return undefined; // tombstone hit → skip
    }
    const result = await fire(); // record always fires; replay miss = new intent
    await cache.set(key, { kind: "effect" });
    return result;
  }

  if (cacheClass === "view") {
    const key = runCacheKey(symbolName, decodedArgs); // total by the shape gate — a throw here is a real bug
    if (cache.mode === "replay") {
      const pending = pendingFor(cache).get(key);
      if (pending !== undefined) return pending; // share the concurrent miss's fire
      const entry = await cache.get(key);
      if (entry?.kind === "value") return entry.value; // hit → serve, never re-fire
    }
    return sharedFire(cache, key, true, fire);
  }

  if (cacheClass === "pure") {
    let key: string;
    try {
      key = runCacheKey(symbolName, decodedArgs);
    } catch {
      return fire(); // unkeyable pure args — unshared fire (sharing is an optimization, not a contract)
    }
    return sharedFire(cache, key, false, fire);
  }

  return fire(); // unclassified — regenerateable, never touches the cache
}
