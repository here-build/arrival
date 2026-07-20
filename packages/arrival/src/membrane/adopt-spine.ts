// Spine ADOPTION — the transition map that gives a borrowed array its list chart.
//
// This is the mechanism behind law #2 (`AJSArrayList.ts`'s header): THE CONSUMER'S CONTRACT
// SELECTS THE CHART. A verb that declares `z.listAlike` is saying "I read my argument as a spine",
// and adoption is what honors that — it hands the body an `AJSArrayList` view over the SAME backing
// array, with the SAME provenance. No copy, no codec, O(1).
//
// ─── WHY NOT `decode` (the thing three attempts died on) ────────────────────────────────────
//
// `z.decode` is the PLANE crossing: scheme → JS. It is right for `symbol.rosetta`, whose impl wants
// JS values. It is exactly wrong here, and the code says so out loud: `symbol.define`'s bake runs
// `if (def.validate) z.decode(def.in, args)` and THROWS THE RESULT AWAY — by design, because a
// scheme body must never receive a JS-marshalled value. `symbol.native` doesn't decode at all.
//
// So a `z.codec` on the list schema (the first attempt) was dead code in both bake paths: it
// computed an eager APair copy of every tool array, on every call, and discarded it — while the raw
// array sailed through to the body and hung it. Adoption is a REPRESENTATION choice on the SCHEME
// plane (AValue in, AValue out); it is not, and must never be routed through, a plane crossing.
//
// ─── WHY IT MUST HAPPEN BEFORE THE IMPL, NOT INSIDE IT ──────────────────────────────────────
//
// Several native impls FIELD-READ their list argument — `findImpl` does `list.car` / `list.cdr`
// directly (srfi-1.ts). A borrowed array has no such member, so it read `undefined`, boxed it to
// AVoid, and handed the predicate a void: `(find even? (some-tool …))` THREW on every tool array in
// the medium. Term-level tolerance can never reach that class of consumer — only handing the impl a
// real APair subclass can, which is what adopting at the argument boundary does.

import { isSpineAdopting } from "../common/spine-adoption.js";
import { AJSArray } from "./AJSArray.js";
import { AJSArrayList } from "../values/primitives/APair.js";

/**
 * Project one argument onto its spine chart, if it is a vector-chart value. Everything else —
 * a genuine pair, `nil`, or any non-list value the contract also admits — passes through
 * UNTOUCHED and by identity.
 *
 * The empty array adopts to `nil`, not to an empty view. That is not an edge case, it is the
 * point: `null?` is `instanceof ANil` (hard-wired, not a term), so an empty container that stays a
 * container can NEVER terminate a scheme list walk, no matter how tolerant its terms are.
 * `AJSArrayList.at` decides this at mint, so nothing downstream needs an emptiness guard.
 */
export function adoptSpine(v: unknown): unknown {
  // ONLY the borrowed array adopts. Not `AVector`.
  //
  // An earlier cut also adopted a genuine scheme `AVector` (projecting a view over its
  // `__vector__`), which looked like harmless tolerance and was two violations at once:
  //
  //   1. HYGIENE (V's law) — `AVector.__vector__` holds ALREADY-BOXED AValues, so feeding it to a
  //      view whose backing store is raw JS put both worlds through one slot. The crossing became
  //      unobservable, and `jsToScheme` silently re-stamped every element with the container's
  //      provenance, destroying per-element lineage. `boxElement`'s invariant (APair.ts) now makes
  //      that impossible to reintroduce quietly.
  //   2. FAITHFULNESS — it widened `(delete-duplicates #(1 2 1))` from an honest contract rejection
  //      into a silent success. A vector is not a list (R7RS), no tool can produce one, and nothing
  //      asked for the tolerance. `(vector->list v)` is the explicit, tracked way across.
  //
  // The two failures share a shape: both came from letting ONE mechanism serve two kinds of value.
  if (v instanceof AJSArray) return AJSArrayList.at(v, 0);
  return v;
}

/**
 * Precompute the per-slot adopter for a contract, at BAKE time — so the call path pays nothing
 * for a verb that has no list slots (the common case), and a verb that does pays one `instanceof`
 * per marked slot.
 *
 * Returns `undefined` when no slot adopts, which the bake sites use to skip the wrapper entirely.
 *
 * `restSchema` covers the variadic tail (`for-each`'s `inputRest`), where EVERY trailing argument
 * is a list and each adopts independently.
 */
export function buildSlotAdopter(
  input: readonly unknown[] | unknown,
  inputRest: unknown,
): ((args: readonly unknown[]) => unknown[]) | undefined {
  const slots: readonly unknown[] = Array.isArray(input) ? input : [];
  const adoptingSlots = slots.map(isSpineAdopting);
  const restAdopts = isSpineAdopting(inputRest);
  if (!adoptingSlots.some(Boolean) && !restAdopts) return undefined;

  return (args: readonly unknown[]): unknown[] =>
    args.map((arg, i) => {
      const adopts = i < adoptingSlots.length ? adoptingSlots[i] : restAdopts;
      return adopts ? adoptSpine(arg) : arg;
    });
}
