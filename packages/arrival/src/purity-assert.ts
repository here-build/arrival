// Purity RUNTIME ASSERTION — the confluence guard (G5 of the static-lineage
// finalization; design §3 "must be guarded at assertion level, not by comment").
//
// arrival's whole lineage layer rests on ONE invariant: evaluation is pure, so
// reduction order is arbitrary (Church–Rosser) and a value's provenance roots at
// its single construction site. Two ways that invariant can silently fail:
//
//   (1) a PURITY DOOR is reopened — `set-car!` / `vector-set!` / `call/cc` /
//       `dynamic-wind` (env/core.ts) are macro-expanded to a `%purity-door` throw
//       and source-deleted; if one is ever re-bound to a working mutator, mutation
//       returns and lineage unsounds with no error.
//   (2) a Rosetta declared `pure: true` (rosetta.ts) SECRETLY MUTATES its inputs.
//       The classifier reads `pure` to treat the call as a PIPE (propagates input
//       provenance, mints nothing) — sound only if the fn truly transforms and does
//       not write through to an input it shares. JS purity is undecidable, so the
//       marker is an author assertion; this is the cheap, SOUND runtime check on it.
//
// This module owns the typed throw (PurityViolation) + the (2) mutation check. The
// (1) door-closure PROBE — test-only, never on a runtime path — lives inline in the
// test (`__tests__/purity-assert.test.ts`) and imports PurityViolation from here. The
// mutation check is dev-flagged (PURITY_ASSERT_ENABLED) so production pays nothing.
// Sibling to purity.ts, which owns the DOOR throw itself.

import { CLASS } from "./well-known-symbols.js";
import { ArrivalError } from "./ArrivalError.js";
import { AValue } from "./values/primitives/AValue.js";
import { APair } from "./values/primitives/APair.js";
import { AVector } from "./values/primitives/AVector.js";

/**
 * A fn that CLAIMED purity broke its contract — distinct from {@link PurityError}.
 * `PurityError` is the teaching DOOR: "you reached for an omitted feature." This is
 * the ASSERTION fired by the confluence guard: "a `pure`-marked Rosetta mutated its
 * input (or a door was reopened) — the lineage model just silently unsounded." It
 * carries the offending `verb` as a routing/telemetry key (errors-as-doors Rule 3),
 * mirroring PurityError.feature.
 */
export class PurityViolation extends ArrivalError {
  static [CLASS] = "purity-violation";
  readonly owner = "owned-by/purity-invariant";
  public readonly name = "PurityViolation";

  constructor(
    message: string,
    /** The verb whose purity contract was violated, e.g. a re-opened "set-car!" or a mutating pure rosetta name. */
    public readonly verb: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// (2) Pure-Rosetta mutation check — a `pure`-marked fn must not write its inputs.
// ---------------------------------------------------------------------------

/**
 * Dev-mode toggle. The mutation fingerprint is a *correctness* assertion, not a
 * runtime feature — on the hottest path (every pure-rosetta crossing). Off unless
 * `ARRIVAL_PURITY_ASSERT=1`, so production pays a single boolean read and nothing
 * more. (Same `process.env` opt-in idiom as ASSEMBLE_PACK_TIMEOUT_MS / is_node.)
 * Read once at module load — flip the env var before importing in a test that
 * needs it on, or call the check functions directly (they take no flag).
 */
export const PURITY_ASSERT_ENABLED: boolean =
  typeof process === "object" && !!process.env && process.env.ARRIVAL_PURITY_ASSERT === "1";

/**
 * A SHALLOW structural fingerprint of one scheme value's mutable slots — the
 * minimal sound surface to detect in-place mutation by a fn that claims purity.
 *
 * Sound, not complete: we snapshot the slots that arrival's (doored-away) mutators
 * would write — `Pair.car`/`Pair.cdr` (mutable fields) and `SchemeVector.__vector__`
 * (mutable array: length + element identities). A truly pure fn touches NONE of
 * these on its inputs, so a changed fingerprint is always a real violation (no
 * false positive). DEPTH-1 by design: it does not recurse into car/cdr children —
 * deep nested mutation is the documented residual (see the module/test notes), the
 * cheap subset the ticket calls for. Everything immutable (numbers, SchemeString's
 * frozen __string__, booleans) has a stable fingerprint and never trips.
 *
 * The fingerprint is an array of opaque cells compared pairwise by `===`; we keep
 * references (identity), never deep-copy — so the check is O(arity · top-level-width)
 * and allocation-light.
 */
export type Fingerprint = readonly unknown[];

export function fingerprint(value: unknown): Fingerprint {
  if (value instanceof APair) {
    // car/cdr are reassignable fields (set-car!/set-cdr! would write them).
    return ["pair", value.car, value.cdr];
  }
  if (value instanceof AVector) {
    // __vector__ is a live array: vector-set!/fill!/copy! mutate it in place.
    // Snapshot length + a shallow copy of element identities (the slice is the
    // only allocation; elements are kept by reference).
    return ["vector", value.__vector__.length, ...value.__vector__];
  }
  // Immutable carriers (SchemeString, numbers, bool, symbol, nil) — identity is a
  // sufficient fingerprint; they cannot be mutated in place.
  return ["value", value];
}

/** Two fingerprints differ iff any slot changed by reference-identity. */
export function fingerprintChanged(before: Fingerprint, after: Fingerprint): boolean {
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) return true;
  }
  return false;
}

/**
 * Snapshot the fingerprints of a pure-rosetta's scheme inputs BEFORE the call.
 * Only AValue inputs are fingerprinted (raw-JS args aren't part of the lineage
 * contract). Returns the parallel snapshot the post-call check consumes.
 */
export function snapshotInputs(schemeArgs: readonly unknown[]): Fingerprint[] {
  return schemeArgs.map((a) => (a instanceof AValue ? fingerprint(a) : EMPTY_FINGERPRINT));
}

const EMPTY_FINGERPRINT: Fingerprint = [];

/**
 * The post-call assertion: re-fingerprint the same inputs and throw a
 * {@link PurityViolation} naming `verb` if any input's mutable slots changed. A
 * pure-marked fn that mutated an input just falsified the provenance the pipe
 * propagated — catch it loudly at the crossing rather than let lineage drift.
 */
export function assertInputsUnmutated(
  verb: string,
  schemeArgs: readonly unknown[],
  before: readonly Fingerprint[],
): void {
  for (let i = 0; i < schemeArgs.length; i++) {
    const arg = schemeArgs[i];
    if (!(arg instanceof AValue)) continue;
    if (fingerprintChanged(before[i], fingerprint(arg))) {
      throw new PurityViolation(
        `rosetta "${verb}" is declared pure: true but MUTATED input #${i} in place — ` +
          `a pure (pipe) rosetta must only transform its arguments, never write through to one. ` +
          `In-place mutation falsifies the provenance lineage the pipe propagated (design §3). ` +
          `Either construct a fresh value, or drop the pure marker (the fn becomes a source).`,
        verb,
      );
    }
  }
}
