/**
 * read-guard — the read log + the read∩write deferral guard (the plexus effect-burst
 * design §2.4). Sibling of `EffectLog` (effect-log.ts) on the
 * `RunContext`: where `EffectLog` remembers WHAT was gathered, this file remembers WHAT
 * was READ during the same run, and checks the one guard rule that makes gather-then-burst
 * sound (§2.1's theorem, dynamic half): a program that enqueues a sink and THEN reads
 * something that sink will write cannot be run as a deferred burst — the read would observe
 * pre-write state where sequential execution would have observed post-write state. That
 * program shape is detected and doored; everything else (query-then-mutate,
 * mutate-disjoint-then-read) runs untouched.
 *
 * ── Why this is a SEAM, not a mobx integration ────────────────────────────────
 * Per the Part V.4 ruling, the real read-tracking mechanism is a mobx tracking context
 * (autorun-style dependency capture) wrapped around accessor evaluation — plexus models are
 * mobx-observable already (`foundations/plexus/src/mobx/index.ts`). Arrival core has ZERO
 * runtime dependency on mobx or plexus (see package.json — `zod`/`tslib`/workspace siblings
 * only) and this file does not add one: `ReadTracker` is an INJECTABLE interface arrival
 * core only calls through, never implements against a real reactive substrate. The mobx-
 * backed implementation (fanning out plexus's single-slot `trackingHook`, tracking.ts:114)
 * lives with the plexus-facing HOST (arrival-mcp / the gateway layer) and is armed onto
 * `RunContext.reads` the same way a host arms `cache`/`effects`. A run with no tracker
 * (`reads` absent) pays nothing — no hook installed, no region wrapped, no guard checked.
 *
 * ── The write-set is PREDICTED at enqueue, not OBSERVED at burst ──────────────
 * The full design (§2.4) observes writes live via `trackModification` INSIDE a real plexus
 * burst region (not built yet). Without a burst executor there is nothing to observe,
 * so this guard works off a HOST-SUPPLIED `writeSetOf` resolver: given a gathered
 * effect entry (verb + decoded args, the same face `EffectLog` already carries), the host
 * answers "which opaque read-keys will this effect's write touch" — honest and minimal per
 * the task's own framing: a resolver that cannot derive a footprint returns `undefined` (the
 * entry is skipped, no false claim), and a host that doesn't know how to derive footprints at
 * all simply doesn't arm `writeSetOf` (the whole guard becomes a no-op — never a lie).
 *
 * ── The opaque key ─────────────────────────────────────────────────────────────
 * `ReadEvent.key`/`WriteSetResolver`'s returned keys are plain strings, host-canonicalized —
 * arrival core never interprets them, only compares by equality (`Set.has`). The natural
 * choice for a plexus-backed host is the tracking substrate's own `(entity, field-tracker)`
 * pair (tracking.ts's vocabulary), canonicalized the same way `runCacheKey` canonicalizes
 * decoded args (a string identity, not a structural comparison) — but arrival core does not
 * need to know that; it only needs `string`.
 */

import type { EffectEntry } from "./effect-log.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. The read log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One observed read. `clock` is this read's 1-BASED position among all reads observed so
 * far THIS run (the read counts itself — the Nth read observed has `clock === N`), minted
 * by the tracker at observation time — never re-derived by a consumer.
 *
 * The 1-based convention is deliberate, not cosmetic: `EffectEntry.enqueuedAtReadClock`
 * (effect-log.ts) is stamped 0-BASED — "how many reads had completed before this enqueue"
 * (`reads.log.length` at enqueue time, run-cache.ts). Pairing a 1-based read position
 * against a 0-based enqueue count makes `read.clock > enqueuedAtReadClock` a clean
 * fencepost with no tie case: if ZERO reads preceded an enqueue (`enqueuedAtReadClock ===
 * 0`) and the very NEXT read is the first one observed (`clock === 1`), `1 > 0` correctly
 * flags it as after. A same-basis (both 0-based, or both 1-based) comparison would tie
 * exactly this case and silently miss the canonical enqueue-then-read violation — the
 * one case the whole guard exists to catch. A host implementing `ReadTracker` MUST mint
 * `clock` as `previousLogLength + 1` (post-increment), matching `MemoryReadTracker`'s own
 * implementation below.
 */
export interface ReadEvent {
  /** Opaque read-target identity — host-canonicalized, compared by string equality only. */
  readonly key: string;
  readonly clock: number;
}

/**
 * The injectable read-tracking seam (Part V.4's mobx tracking context, from arrival core's
 * side). `region` wraps evaluation of ONE top-level form (the eval loop's own unit — see
 * generator-exec.ts) so the host can install/remove its own hook (fan out plexus's
 * `trackingHook`, or an `AsyncLocalStorage`-scoped equivalent that survives the trampoline's
 * internal `await`s) for exactly that call's duration; arrival core never inspects HOW the
 * host observes a read, only reads `log` afterward.
 *
 * Async-shaped (`Promise<T>`), not sync: form evaluation itself is async (the generator
 * trampoline yields at budget/heap boundaries), so a host tracking substrate that needs
 * to survive an `await` (mobx's own stack-based `Reaction` does NOT, by construction — a
 * host arming this seam owns that constraint, e.g. via `AsyncLocalStorage` or a per-run
 * ambient swapped at region entry/exit) gets a shape it can actually implement against.
 */
export interface ReadTracker {
  region<T>(fn: () => Promise<T>): Promise<T>;
  /** Every read observed so far this run, in observation order (`clock` order). */
  readonly log: readonly ReadEvent[];
}

/**
 * A minimal, host-swappable reference implementation — mirrors `MemoryRunCache`/
 * `MemoryEffectLog`'s "one instance per run" posture (values/run-cache.ts,
 * values/effect-log.ts). `region` is a pure pass-through (no hook installed — a host
 * with a real reactive substrate to fan out, e.g. plexus's `trackingHook`, installs its
 * OWN `ReadTracker` instead); `record` is the one extra surface this reference impl
 * exposes for a caller that already knows its own read keys without a reactive
 * substrate to wrap (law tests; a host with a non-mobx read-observation channel).
 */
export class MemoryReadTracker implements ReadTracker {
  private readonly _log: ReadEvent[] = [];

  get log(): readonly ReadEvent[] {
    return this._log;
  }

  /** Record one read. `clock` is minted post-increment — 1-based, per `ReadEvent`'s doc
   *  (the fencepost that makes `read.clock > enqueuedAtReadClock` tie-free). */
  record(key: string): void {
    this._log.push({ key, clock: this._log.length + 1 });
  }

  async region<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

/** Host-supplied: given a gathered effect entry, the opaque read-keys its (eventual, deferred)
 *  write will touch — or `undefined` when the host cannot derive a footprint for THIS entry
 *  (skipped, not treated as "no writes" — an honest abstention, never a false negative dressed
 *  as a fact). Not required to be a `Set` — any iterable is accepted, deduplicated internally. */
export type WriteSetResolver = (entry: EffectEntry) => Iterable<string> | undefined;

/** The seam `RunContext.reads` carries — sibling injection point to `cache`/`effects`, per
 *  the task's framing ("same injection point as the tracker"). `writeSetOf` is optional
 *  independently of `tracker`: a host may track reads (for future use, e.g. a lineage/
 *  verdict gate) without yet being able to predict write footprints — in which case the
 *  guard degrades to a no-op (§ below), never a crash on incomplete information. */
export interface ReadGuard {
  readonly tracker: ReadTracker;
  readonly writeSetOf?: WriteSetResolver;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raised by `checkReadWriteGuard` — the teaching door naming both halves of the violation:
 * which gathered effect was enqueued, and which later read observed a target it will write.
 * Mirrors `BurstDrainError`'s style (effect-log.ts): a typed field per fact, a human message
 * built from them, so a catcher can render either.
 */
export class ReadYourDeferredWriteError extends Error {
  constructor(
    readonly effect: EffectEntry,
    readonly readKey: string,
    readonly readClock: number,
  ) {
    const enqueuedAt = effect.enqueuedAtReadClock ?? 0;
    super(
      `read-your-write on a deferred effect: effect ${effect.index} (${effect.verbName}) was gathered at ` +
        `read-clock ${enqueuedAt}, then a read of "${readKey}" (read-clock ${readClock}) observed a target ` +
        `this effect will write — a burst run cannot read its own writes (the deferral would become ` +
        `observable). Put the read in a follow-up call (the effect will be committed by then and the read ` +
        `will see the post-write state), or drop the read.`,
    );
  }
}

/**
 * THE GUARD (§2.4, this wave's buildable slice): for every gathered effect, in program
 * order, check whether any read observed AFTER its enqueue (`read.clock > effect.
 * enqueuedAtReadClock`) hits a key in that effect's predicted write-set. First violation
 * throws `ReadYourDeferredWriteError`; a clean run returns silently.
 *
 * `writeSetOf` absent ⇒ no-op (a host that tracks reads but cannot predict write footprints
 * gets no crashes, not false ones — see this file's header). An entry `writeSetOf` itself
 * abstains on (returns `undefined`) is skipped the same way — honest incompleteness, not a
 * claim of "no writes."
 *
 * Reads BEFORE an effect's enqueue (`read.clock <= enqueuedAtReadClock`) are the motivating
 * query that led to the effect (`read component.style`, then `set-style`) — never a
 * violation, by construction of the comparison.
 */
export function checkReadWriteGuard(
  entries: readonly EffectEntry[],
  reads: readonly ReadEvent[],
  writeSetOf: WriteSetResolver | undefined,
): void {
  if (writeSetOf === undefined) return;
  for (const entry of entries) {
    const writeKeys = writeSetOf(entry);
    if (writeKeys === undefined) continue;
    const keySet = writeKeys instanceof Set ? writeKeys : new Set(writeKeys);
    if (keySet.size === 0) continue;
    const enqueuedAt = entry.enqueuedAtReadClock ?? 0;
    for (const read of reads) {
      if (read.clock > enqueuedAt && keySet.has(read.key)) {
        throw new ReadYourDeferredWriteError(entry, read.key, read.clock);
      }
    }
  }
}
