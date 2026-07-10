/**
 * effect-log — the ORDERED sibling of `RunCache` (W1, docs/working-proposals/
 * arrival-plexus-effect-burst.md §2.3/§2.5). Where `RunCache` is a content-keyed,
 * deduplicating `Map` (two identical penetrations share one slot), `EffectLog` is a
 * plain append-only sequence: two identical sink calls are two entries, always — the
 * mode law's "two effects, always" (run-cache.ts's header) holds for the burst arm
 * exactly as it holds for the tombstone arm. This file owns the log entity and the
 * drain (`burst`); it does NOT own the read-clock guard ITSELF (W2, values/
 * read-guard.ts) or the conflict re-execution comparator (W4) — this log only
 * remembers WHAT was gathered, in WHAT order, and (as of W2) the read-clock each entry
 * was gathered at, nothing about whether it is safe to replay against a moved world.
 *
 * ── Where it intercepts ───────────────────────────────────────────────────────
 * Same chokepoint as `RunCache`: `penetrateThroughCache`, between arg decode and
 * impl fire. When the run's ctx carries an `effects` log (`this.runCtx.effects`) and
 * the penetration is `sink`-classed and the run is NOT replaying a cache (§2.3: burst
 * is a PRIME-run-only phenomenon), the sink enqueues `{verbName, decodedArgs}` and
 * returns `undefined` immediately — sound because a sink's contract already proved a
 * void-family output (`assertProvenanceRoleShape`'s bake gate, _bake.ts): a program
 * that cannot read an effect's result cannot observe that firing it was deferred.
 *
 * ── Decoded args, kept faithfully ─────────────────────────────────────────────
 * Entries store the DECODED args (post-zod, the same face `RunCache` keys on), not
 * re-encoded scheme values — later consumers (a confirmation manifest, per-effect
 * arg invariants) read plain JS. This file does not interpret them; it only carries
 * them through in program order.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. The entity
// ─────────────────────────────────────────────────────────────────────────────

/** One gathered sink penetration. `index` is minted by `enqueue` — program order,
 *  never re-derived from a statement position (a burst replays in THIS order, not in
 *  a recomputed one). */
export interface EffectEntry {
  readonly index: number;
  readonly verbName: string;
  readonly decodedArgs: readonly unknown[];
  /** The read-clock at enqueue (W2, values/read-guard.ts, §2.3's normative field) —
   *  stamped by `penetrateThroughCache` when the run carries a `reads` tracker; absent
   *  when it doesn't (no tracker ⇒ nothing to stamp, and the guard treats a missing
   *  clock as `0`, i.e. every read counts — see read-guard.ts). Reads at or below this
   *  clock are the query that motivated this effect; reads above it are post-enqueue. */
  readonly enqueuedAtReadClock?: number;
  /** The RAW pre-decode args (arrival-provenance-confirmation.md §5) — the interpreter's
   *  own boxed scheme values (AValue-tagged, provenance intact), exactly as the rosetta
   *  wrapper held them BEFORE `z.decode` stripped their identity down to plain JS. Kept
   *  ALONGSIDE `decodedArgs` (never in place of it — `decodedArgs` stays the JS-plain
   *  face every existing consumer reads) so a confirmation-manifest host can (a) re-derive
   *  each argument's lineage (a `groundingVerdict`-style walk needs the boxed value, not
   *  its decoded shadow) and (b) reconstruct THIS effect's own minimal re-runnable
   *  invocation (`writeForm` over these nodes serializes back to re-parseable Scheme
   *  source) without touching the interpreter's internals. Absent when the penetration
   *  carries no `EffectEntry`-shaped raw-args source (never the case for the burst arm
   *  itself, which always has them in scope — see run-cache.ts's `penetration.rawArgs`). */
  readonly rawArgs?: readonly unknown[];
}

/** An ordered, append-only manifest of gathered sink penetrations for ONE run. Never
 *  deduplicates (contrast `RunCache`'s content-keyed `Map`) and never drops an entry
 *  (a failed burst leaves the log as-is — the poison rule, §2.3 — the CALLER decides
 *  whether a poisoned log is ever drained again; this entity doesn't self-police). */
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

/** The in-memory materialization — a plain array, mirroring `MemoryRunCache`'s
 *  "one Map while a run executes" posture. One `MemoryEffectLog` per run; it does not
 *  outlive the run that gathered it (the burst executor drains it and discards it). */
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
      ...(entry.rawArgs === undefined ? {} : { rawArgs: entry.rawArgs }),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The drain (§2.5's burst, ordering/atomicity language — minus everything W3+
//    owns: no plexus region, no sync bracket, no rollback. This is the bare
//    sequential-execution primitive those waves wrap.)
// ─────────────────────────────────────────────────────────────────────────────

/** Where a drain stopped — the throwing entry's position plus the entries that never
 *  ran, so a caller can render "form N's effect threw; effects after it never fired"
 *  without re-deriving the cut point from a bare index. */
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
 * `executor` (the burst host decides how a `{verbName, decodedArgs}` descriptor maps
 * back onto a real effect — this file has no opinion). One pass, no reordering, no
 * retry: a mid-entry throw stops the drain immediately and rethrows `BurstDrainError`
 * carrying the failing entry's position and the entries that never ran — the caller
 * (a real burst executor, W3+) owns rollback; this function performs no side effects
 * of its own beyond calling `executor`.
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
