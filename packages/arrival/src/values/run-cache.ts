/**
 * run-cache — THE first-class run cache (R2, arrival-mcp-rework-over-phases.md §2.2,
 * Q1/Q2 + Rulings A/B/D1). Sibling of RunContext: a run's durable twin is
 * `(program, cache)`; rehydration is re-execution of the statement log with THIS
 * entity answering the membrane. One mechanism serves durability, replay, and (later)
 * reflection — "cache overload and full re-run, virtually running new program over
 * same cache" (Q2, verbatim).
 *
 * ── Where it intercepts ───────────────────────────────────────────────────────
 * The baked rosetta `run` wrapper (common/symbols/rosetta.ts) — the ONE chokepoint
 * where args are already decoded and the impl hasn't fired. The wrapper reads the
 * run's cache off `this.runCtx.cache` (the per-run hermetic handle, exactly where
 * `signal`/`heapMeter` already live — `exec(src, { cache })` → `makeRunContext`
 * carries it) and gates on the def's EXPLICIT cache class (`view`/`pure`, Ruling A)
 * plus the `sink` lineage role for the tombstone skip. An undeclared, non-sink def
 * never touches the serialized cache.
 *
 * ── The mode law (record vs replay — per class) ───────────────────────────────
 *   class      | record mode                          | replay mode
 *   -----------|--------------------------------------|-------------------------------
 *   view       | fire, write/OVERWRITE `{value}`      | hit → serve, never re-fire;
 *              | (a settled entry never suppresses    | miss → fire + write (a NEW
 *              | a live fire — fresh truth)           | program's novel call is fresh)
 *   sink       | fire, write `{effect}` tombstone     | tombstone hit → skip (void);
 *              | (two identical live sinks = TWO      | miss → fire (new intent, not
 *              | effects, always)                     | a repeat)
 *   pure       | fire                                 | fire — determinism from args is
 *              |                                      | the CONTRACT (Ruling B's infer);
 *              |                                      | recovery = re-call, never stored
 *   undeclared | fire                                 | fire — regenerateable, the SAFE
 *              |                                      | default
 *
 * ── Single-flight (D1's promise sharing) ──────────────────────────────────────
 * Each invocation lives in an immutable world (between invocations it may not), so
 * concurrent identical penetrations WITHIN one run share ONE rosetta call — the
 * in-flight promise is registered at call start, scoped to `view`/`pure` ONLY (never
 * `sink` — two live effects are two effects; never unclassified). Entry lifecycle:
 * pending promise → settled `{value}`; ONLY settled entries serialize. A REJECTED
 * promise is NEVER cached — rejection evicts the pending entry, so retries are
 * allowed and a transient failure never becomes a pinned error. In-flight promises
 * do not survive eviction: the single-flight benefit is residency-scoped, by design.
 *
 * ── What this file is NOT (R3's territory, deliberately absent) ───────────────
 * No session plumbing: no epoch/roster/configDigest identity, no storage decomposition,
 * no TTL. `RunCache` is the RUN-level entity only; the cache-validity identity
 * `{v, semanticsEpoch, roster, configDigest}` is checked by the session layer BEFORE
 * a cache is handed to a run (mismatch ⇒ drop the cache, keep the log).
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. The entity (§2.2's normative shapes, verbatim)
// ─────────────────────────────────────────────────────────────────────────────

export type RunCacheEntry =
  | { kind: "value"; value: unknown } // a `view` result — the decoded-face JS value,
  //   JSON-serializable by the view shape gate (assertCacheClassShape, _bake.ts)
  | { kind: "effect" }; // tombstone — the effect (sink) fired in a recorded run

export interface RunCache {
  /** mode governs the membrane, not storage: "record" = live run (impl fires, result
   *  written); "replay" = fold (hit answers without firing; effect tombstone skips). */
  readonly mode: "record" | "replay";
  get(key: string): Promise<RunCacheEntry | undefined>;
  set(key: string, entry: RunCacheEntry): Promise<void>;
}

/** The in-memory materialization — a `Map` with the async face (§2.2: "in-memory Map
 *  always while a run executes"). `entries` is deliberately readable: the session layer
 *  (R3) serializes SETTLED entries from it, and a replay cache is constructed OVER a
 *  recorded one's entries. Mode is fixed at construction — a rehydration builds a NEW
 *  replay cache over the same entries, it never flips a live one. */
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

// ─────────────────────────────────────────────────────────────────────────────
// 2. canonicalJson + the content key (§2.2's normative algorithm + its law tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NORMATIVE canonical JSON (§2.2): object keys recursively SORTED; arrays
 * order-preserving; input is DECODED (post-zod) values only, so codec coercion is
 * already normalized before keying; `undefined` cannot occur (zod output) — one
 * arriving anyway throws rather than silently canonicalizing two different shapes to
 * one text; numbers serialize as plain JSON numbers (non-finite numbers are not JSON
 * — throw). Anything JSON cannot represent (function, symbol, bigint, a non-plain
 * object — class instances, Map/Set) THROWS: a value that cannot canonicalize cannot
 * be a cache key, and the caller decides the fallback (a `pure` key failure falls
 * back to an unshared fire; a `view` key is total BY CONSTRUCTION — its shape gate
 * admits data codecs only).
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

/** FNV-1a over a prefixed canonical string — the codebase's ONE content-hash idiom
 *  (crc-v0 precedent: prefix tag + `|`-joined canonical parts, FNV-1a, zero-padded
 *  hex — eval/CompiledResolutionChain.ts `hashSteps`, provenance/wireframe/hash.ts).
 *  A local copy, deliberately NOT imported from either (different domains: those hash
 *  a sealed env chain / a wireframe graph, this one a membrane penetration). */
function fnv1a(prefix: string, canonical: string): string {
  const tagged = `${prefix}|${canonical}`;
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < tagged.length; i++) {
    h ^= tagged.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The content key: `hash(symbolName ‖ canonicalJson(decodedArgs))` — keyed by
 *  PENETRATION CONTENT, not by position (statement index / penetration ordinal), which
 *  is FORCED by Q2: a NEW program has no positions in common with the recorded one;
 *  only (node, args) survives program edits. Throws whatever `canonicalJson` throws —
 *  the caller owns the fallback (see `canonicalJson`'s doc). */
export function runCacheKey(symbolName: string, decodedArgs: readonly unknown[]): string {
  return fnv1a("runcache-v0", `${symbolName}|${canonicalJson(decodedArgs)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The interception (the rosetta wrapper's one call) + single-flight
// ─────────────────────────────────────────────────────────────────────────────

/** The stamped cache class, as this module needs it — structurally identical to
 *  `_bake.ts`'s `CacheClass` but declared locally: values/ is BELOW common/ in the
 *  import DAG (RunContext ← _bake), so this leaf must not reach up for the type. */
export type RunCacheClass = "view" | "pure";

/** Per-cache in-flight registry (single-flight, D1). WeakMap keyed by the cache
 *  ENTITY: the pending map's lifetime IS the run cache's residency — no module-level
 *  state outlives it (hermetic), and two concurrent runs sharing one isolate never
 *  see each other's pendings unless they deliberately share one cache. */
const inFlight = new WeakMap<RunCache, Map<string, Promise<unknown>>>();

function pendingFor(cache: RunCache): Map<string, Promise<unknown>> {
  let map = inFlight.get(cache);
  if (map === undefined) {
    map = new Map();
    inFlight.set(cache, map);
  }
  return map;
}

/** Single-flight fire for the `view`/`pure` classes: register the in-flight promise
 *  BEFORE awaiting so concurrent identical penetrations share one impl call; settle
 *  removes the pending entry either way (rejection = eviction, retries allowed;
 *  success for a `view` = the settled `{value}` written to the cache — only settled
 *  entries serialize). */
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
 * THE INTERCEPTION — called by the baked rosetta `run` wrapper between arg decode and
 * impl fire, in place of the bare fire. Implements the mode law (file header) for the
 * penetration `(symbolName, decodedArgs)`:
 *
 *  - `cache === undefined` → plain fire (no run cache on this run).
 *  - `sink` (lineage role — survives Ruling A): record = fire + tombstone; replay =
 *    tombstone hit skips (returns `undefined` — the void the sink's shape-gated
 *    contract already promised), miss fires + writes. No promise sharing, ever. A
 *    sink's inputs are NOT shape-gated serializable, so a key failure downgrades the
 *    penetration to an honest plain fire (never a throw, never a fabricated key).
 *  - `view`: record = single-flight fire + overwrite; replay = hit serves the stored
 *    decoded-face value (the wrapper's encode/provenance steps then run over it
 *    exactly as over a fresh impl return), miss = single-flight fire + write. The
 *    key is total by the bake-time shape gate.
 *  - `pure`: single-flight fire in BOTH modes (contractual determinism, Ruling B) —
 *    never reads or writes serialized entries. A key failure (a `pure` contract may
 *    carry `z.value`/`z.lambda` — ungated by design) falls back to an unshared fire.
 *  - unclassified non-sink: plain fire — never touches the cache.
 */
export async function penetrateThroughCache(
  cache: RunCache | undefined,
  penetration: { symbolName: string; cacheClass: RunCacheClass | undefined; sink: boolean },
  decodedArgs: readonly unknown[],
  fire: () => Promise<unknown>,
): Promise<unknown> {
  if (cache === undefined) return fire();
  const { symbolName, cacheClass, sink } = penetration;

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
