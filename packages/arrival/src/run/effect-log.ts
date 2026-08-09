/**
 * effect-log — gathered-effect manifest for one run, ORDERED sibling of RunCache.
 * Model: docs/execution.md §BURST ("two effects, always"; poison rule; where entries gather).
 * Owns the log entity and drain (`burst`); not the read-clock guard or conflict re-exec.
 *
 * Entries store DECODED args (post-zod, same face RunCache keys on) — plain JS for later
 * consumers. This file carries them in program order, does not interpret.
 */

/** One gathered sink penetration. `index` is minted by `enqueue` — program order, never
 *  re-derived from a statement position (a burst replays in THIS order, not a recomputed one). */
export interface EffectEntry {
  readonly index: number;
  readonly verbName: string;
  readonly decodedArgs: readonly unknown[];
  /** The read-clock at enqueue (read-guard.ts), stamped by `penetrateThroughCache` when the
   *  run carries a `reads` tracker; absent when it doesn't (the guard treats a missing clock as
   *  `0`, i.e. every read counts). Reads at or below this clock are the query that motivated the
   *  effect; reads above it are post-enqueue. */
  readonly enqueuedAtReadClock?: number;
  /** The RAW pre-decode args — the interpreter's own boxed scheme values (AValue-tagged,
   *  provenance intact), exactly as the rosetta wrapper held them BEFORE `z.decode` stripped
   *  identity down to plain JS. Kept ALONGSIDE `decodedArgs`, never in place of it, so a
   *  confirmation-manifest host can re-derive each argument's lineage (a walk needs the boxed
   *  value, not its decoded shadow) and reconstruct THIS effect's minimal re-runnable invocation
   *  (`writeForm` over these nodes serializes back to re-parseable Scheme source). Absent when the
   *  penetration carries no raw-args source. */
  readonly rawArgs?: readonly unknown[];
}

/** An ordered, append-only manifest of gathered sink penetrations for ONE run. Never
 *  deduplicates (contrast `RunCache`'s content-keyed `Map`) and never drops an entry (the poison
 *  rule, docs/execution.md §BURST — a failed burst leaves the log as-is; the CALLER decides
 *  whether a poisoned log is drained again, this entity does not self-police). */
export interface EffectLog {
  readonly entries: readonly EffectEntry[];
  /** Append one entry; `index` is minted here (`entries.length` at call time) — the
   *  caller never supplies it, so two enqueues can never collide on index. */
  enqueue(entry: {
    verbName: string;
    decodedArgs: readonly unknown[];
    enqueuedAtReadClock?: number;
    rawArgs?: readonly unknown[];
  }): void;
}

/** The in-memory materialization — a plain array. One per run; it does not outlive the run
 *  that gathered it (the burst executor drains it and discards it). */
export class MemoryEffectLog implements EffectLog {
  private readonly _entries: EffectEntry[] = [];

  get entries(): readonly EffectEntry[] {
    return this._entries;
  }

  enqueue(entry: {
    verbName: string;
    decodedArgs: readonly unknown[];
    enqueuedAtReadClock?: number;
    rawArgs?: readonly unknown[];
  }): void {
    this._entries.push({
      index: this._entries.length,
      verbName: entry.verbName,
      decodedArgs: entry.decodedArgs,
      ...(entry.enqueuedAtReadClock === undefined ? {} : { enqueuedAtReadClock: entry.enqueuedAtReadClock }),
      ...(entry.rawArgs === undefined ? {} : { rawArgs: entry.rawArgs }) });
  }
}

// The drain — the bare sequential-execution primitive a real burst executor wraps: no
// plexus region, no sync bracket, no rollback of its own.

/** Where a drain stopped — the throwing entry's position plus the entries that never ran, so a
 *  caller can render "form N's effect threw; effects after it never fired" without re-deriving
 *  the cut point from a bare index. */
export interface BurstFailure {
  readonly entry: EffectEntry;
  readonly error: unknown;
  readonly remaining: readonly EffectEntry[];
}

/** Raised by `burst` on a mid-drain throw. Carries the failure so a caller can report
 *  position without parsing a message string. */
export class BurstDrainError extends Error {
  constructor(readonly failure: BurstFailure) {
    super(
      `burst: entry ${failure.entry.index} (${failure.entry.verbName}) threw — ` +
        `${failure.remaining.length} entr${failure.remaining.length === 1 ? "y" : "ies"} after it never fired`,
    );
  }
}

/**
 * Drain `log` in strict index order, firing each entry through the caller-supplied
 * `executor` (the host decides how a `{verbName, decodedArgs}` descriptor maps onto a real
 * effect). One pass, no reordering, no retry: a mid-entry throw stops the drain immediately
 * and rethrows `BurstDrainError` carrying the failing entry's position and the entries that
 * never ran. The caller owns rollback; this function has no side effects beyond `executor`.
 */
export async function burst(
  log: EffectLog,
  executor: (entry: EffectEntry) => unknown | Promise<unknown>,
): Promise<void> {
  const entries = log.entries;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      await executor(entry);
    } catch (error) {
      throw new BurstDrainError({ entry, error, remaining: entries.slice(i + 1) });
    }
  }
}
