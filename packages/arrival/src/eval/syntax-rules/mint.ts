// ----------------------------------------------------------------------
// The syntax-rules engine's mint door and span stamping — shared by the matcher and the
// transcriber.
//
// MINT DOOR: every cell the matcher/expander constructs goes through consCell/listFromArray
// via the explicitly threaded `ctx` PARAMETER — not a per-value stamp. A walk of the output
// cannot tell fresh cells from call-site fragments shared by reference, so minting goes
// through this door.
//
// SPAN PROPAGATION: expansion-built pairs carry the TEMPLATE's span (same template node →
// same span on every instantiation); pattern-variable substitutions are call-site pairs by
// reference and keep their own spans. carrySpan only stamps span-less pairs, never overwrites.
// ----------------------------------------------------------------------
import type { RunContext } from "../../run/RunContext.js";
import { APair } from "../../values/primitives/APair.js";
import type { AListAlike, SchemeValue } from "../../values/types.js";

/** A pair of arbitrary Scheme values (APair's own parameters have no defaults). */
export type Pair = APair<SchemeValue, SchemeValue>;

// Cells the door minted. restore_data_gensyms walks ONLY these: a pair it did not mint is a
// call-site fragment (a substituted pattern variable) and cannot contain this expansion's
// gensyms. Weak — the set never keeps an expansion alive.
const minted = new WeakSet<object>();

/** Whether the mint door built `x` (as opposed to a call-site fragment shared by reference). */
export function isMinted(x: unknown): x is Pair {
  return typeof x === "object" && x !== null && minted.has(x);
}

/** The MINT DOOR (see file preamble). */
export function consCell<Car extends SchemeValue, Cdr extends SchemeValue>(
  _ctx: RunContext,
  car: Car,
  cdr: Cdr,
): APair<Car, Cdr> {
  const cell = new APair(car, cdr);
  minted.add(cell);
  return cell;
}

/** `APair.fromArray` through the mint door — n elements ⇒ n fresh spine cells. */
export function listFromArray<T extends SchemeValue>(
  ctx: RunContext,
  array: readonly T[],
  deep = false,
): AListAlike<T> {
  const list = APair.fromArray(ctx, array, deep);
  for (let cur: unknown = list; cur instanceof APair; cur = cur.cdr) minted.add(cur);
  return list;
}

/** Stamp the template's span onto a single fresh, span-less Pair (preamble SPAN
 *  PROPAGATION). Location is IMMUTABLE — a stamp mints a clone via withLocation
 *  (the clone is registered with the door too).
 *  Every caller treats the return as the value of record (applied to a cell JUST minted
 *  inline). deferred: expansion-chain slot recording the call site per expansion, for a
 *  consumer that needs both template and call-site. */
export function carrySpan<T extends SchemeValue>(fresh: T, template: SchemeValue): T {
  if (fresh instanceof APair && fresh.location === undefined && template instanceof APair) {
    const loc = template.location;
    // withLocation on a narrowed-T intersection loses precise APair<Car,Cdr>
    // parametrization — cast is honest: same concrete class, only location differs.
    if (loc !== undefined) {
      const stamped = fresh.withLocation(loc);
      if (minted.has(fresh)) minted.add(stamped);
      return stamped as T;
    }
  }
  return fresh;
}
