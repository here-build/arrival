/**
 * read-guard — the read log + the read∩write deferral guard. Sibling of `EffectLog` on the
 * `RunContext`: where `EffectLog` remembers WHAT was gathered, this file remembers WHAT was
 * READ during the same run, and checks the one rule that makes gather-then-burst sound: a
 * program that enqueues a sink and THEN reads something that sink will write cannot run as a
 * deferred burst — the read would observe pre-write state where sequential execution observes
 * post-write state. That shape is detected and doored; everything else (query-then-mutate,
 * mutate-disjoint-then-read) runs untouched.
 *
 * SEAM, not a mobx integration. Arrival core has ZERO runtime dependency on mobx or plexus
 * (package.json — `zod`/`tslib`/workspace siblings only) and this file adds none: `ReadTracker`
 * is an INJECTABLE interface arrival core only calls through. The real read-tracking mechanism
 * is a mobx tracking context wrapped around accessor evaluation (plexus models are mobx-
 * observable already); that implementation lives with the plexus-facing HOST and is armed onto
 * `RunContext.reads` the same way a host arms `cache`/`effects`. A run with no tracker pays
 * nothing — no hook, no region, no guard.
 *
 * The write-set is PREDICTED at enqueue, not OBSERVED at burst: without a real plexus burst
 * region there is nothing to observe, so the guard works off a HOST-SUPPLIED `writeSetOf`
 * resolver answering "which opaque read-keys will this effect's write touch." A resolver that
 * cannot derive a footprint returns `undefined` (the entry is skipped, no false claim); a host
 * that cannot derive footprints at all does not arm `writeSetOf` (the guard becomes a no-op,
 * never a lie).
 *
 * The keys (`ReadEvent.key`, `WriteSetResolver`'s returns) are plain strings, host-
 * canonicalized — arrival core never interprets them, only compares by equality (`Set.has`).
 */

import type { EffectEntry } from "./effect-log.js";

/**
 * One observed read. `clock` is this read's 1-BASED position among all reads observed so far
 * THIS run (the read counts itself — the Nth read has `clock === N`), minted by the tracker at
 * observation time, never re-derived by a consumer. A host implementing `ReadTracker` MUST mint
 * `clock` as `previousLogLength + 1`, matching `MemoryReadTracker` below.
 *
 * The 1-based basis is load-bearing: `EffectEntry.enqueuedAtReadClock` is stamped 0-BASED —
 * "how many reads completed before this enqueue" (`reads.log.length` at enqueue time). Pairing
 * a 1-based read against a 0-based enqueue makes `read.clock > enqueuedAtReadClock` a tie-free
 * fencepost: if ZERO reads preceded an enqueue (`enqueuedAtReadClock === 0`) and the very next
 * read is the first observed (`clock === 1`), `1 > 0` correctly flags it as after. A same-basis
 * comparison would tie exactly this case and silently miss the canonical enqueue-then-read
 * violation — the one case the guard exists to catch.
 */
export interface ReadEvent {
  /** Opaque read-target identity — host-canonicalized, compared by string equality only. */
  readonly key: string;
  readonly clock: number;
}

/**
 * The injectable read-tracking seam. `region` wraps evaluation of ONE top-level form (the
 * eval loop's unit) so the host can install and remove its own hook for exactly that call's
 * duration; arrival core never inspects HOW a read is observed, only reads `log` afterward.
 *
 * Async-shaped (`Promise<T>`), not sync, because form evaluation is async (the generator
 * trampoline yields at budget/heap boundaries): a host tracking substrate must survive an
 * `await`. Mobx's own stack-based `Reaction` does NOT, by construction — a host arming this
 * seam owns that constraint (e.g. an `AsyncLocalStorage`-scoped or per-run ambient swapped at
 * region entry/exit).
 */
export interface ReadTracker {
  region<T>(fn: () => Promise<T>): Promise<T>;
  /** Every read observed so far this run, in observation order (`clock` order). */
  readonly log: readonly ReadEvent[];
}

/**
 * A minimal, host-swappable reference implementation, one instance per run. `region` is a
 * pure pass-through (no hook installed — a host with a real reactive substrate installs its
 * OWN `ReadTracker` instead); `record` is the one extra surface this impl exposes for a caller
 * that already knows its own read keys without a reactive substrate to wrap.
 */
export class MemoryReadTracker implements ReadTracker {
  private readonly _log: ReadEvent[] = [];

  get log(): readonly ReadEvent[] {
    return this._log;
  }

  /** Record one read. `clock` is minted post-increment (1-based) — see `ReadEvent`. */
  record(key: string): void {
    this._log.push({ key, clock: this._log.length + 1 });
  }

  async region<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

/** Host-supplied: given a gathered effect entry, the opaque read-keys its deferred write will
 *  touch — or `undefined` when the host cannot derive a footprint for THIS entry (skipped, not
 *  treated as "no writes" — an honest abstention, never a false negative dressed as fact). Any
 *  iterable is accepted, deduplicated internally. */
export type WriteSetResolver = (entry: EffectEntry) => Iterable<string> | undefined;

/** The seam `RunContext.reads` carries. `writeSetOf` is optional independently of `tracker`: a
 *  host may track reads without yet being able to predict write footprints — the guard then
 *  degrades to a no-op, never a crash on incomplete information. */
export interface ReadGuard {
  readonly tracker: ReadTracker;
  readonly writeSetOf?: WriteSetResolver;
}

/**
 * Raised by `checkReadWriteGuard` — the teaching door naming both halves of the violation:
 * which gathered effect was enqueued, and which later read observed a target it will write. A
 * typed field per fact plus a human message built from them, so a catcher can render either.
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
 * THE GUARD: for every gathered effect, in program order, check whether any read observed
 * AFTER its enqueue (`read.clock > effect.enqueuedAtReadClock`) hits a key in that effect's
 * predicted write-set. First violation throws `ReadYourDeferredWriteError`; a clean run
 * returns silently.
 *
 * `writeSetOf` absent ⇒ no-op; an entry `writeSetOf` abstains on (returns `undefined`) is
 * skipped the same way — honest incompleteness, not a claim of "no writes." Reads BEFORE an
 * effect's enqueue (`read.clock <= enqueuedAtReadClock`) are the motivating query that led to
 * the effect (read `component.style`, then `set-style`) — never a violation, by construction.
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
