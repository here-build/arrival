// Spine ADOPTION — the transition that gives a sequence-chart value its list chart.
//
// Law: THE CONSUMER'S CONTRACT SELECTS THE CHART (APair.ts AJSArrayList header).
// A verb that declares z.listAlike is saying "I read my argument as a spine", and
// adoption honors that — borrowed AJSArray → AJSArrayList view over the SAME backing
// array, SAME provenance (no copy, O(1)); boxed AVector → shallow pair copy of
// already-boxed elements (empty → nil).
//
// NOT a plane crossing. z.decode is scheme → JS (right for symbol.rosetta, whose
// impl wants JS values). It is wrong here: symbol.define's bake runs
// `if (def.validate) z.decode(def.in, args)` and THROWS THE RESULT AWAY — a scheme
// body must never receive a JS-marshalled value; symbol.native doesn't decode at all.
// A z.codec on the list schema would compute an eager APair copy of every tool array
// on every call and discard it, while the raw array sailed through to the body and
// hung it. Adoption is a REPRESENTATION choice on the SCHEME plane (AValue in,
// AValue out) — never routed through a plane crossing.
//
// MUST HAPPEN BEFORE THE IMPL, NOT INSIDE IT. Several native impls FIELD-READ their
// list argument (findImpl does list.car / list.cdr directly — srfi-1.ts). A borrowed
// array has no such member, so it read undefined, boxed to AVoid, and handed the
// predicate a void: (find even? (some-tool …)) THREW on every tool array. Term-level
// tolerance never reaches that class of consumer — only handing the impl a real
// APair subclass can, which is what adopting at the argument boundary does.

import { isSpineAdopting } from "../common/spine-adoption.js";
import type { DecodedArgsWithRest, RestSpec, VectorSpec } from "../common/symbols/_bake.js";
import { CONSTANT_CTX } from "../run/RunContext.js";
import { AJSArray } from "./AJSArray.js";
import { AJSArrayList, APair } from "../values/primitives/APair.js";
import type { ANil } from "../values/primitives/ANil.js";
import { AVector } from "../values/primitives/AVector.js";
import type { AListAlike, SchemeValue } from "../values/types.js";

/**
 * Project one argument onto its spine chart, if it is a vector-chart value.
 * Everything else — a genuine pair, nil, or any non-list value the contract also
 * admits — passes through UNTOUCHED and by identity.
 *
 * Empty array adopts to nil, not to an empty view: null? is instanceof ANil
 * (hard-wired, not a term), so an empty container that stays a container can NEVER
 * terminate a scheme list walk. AJSArrayList.at decides this at mint.
 *
 * A boxed AVector also adopts: a spine slot means "I read this as a list", and
 * sugarcoat `[]` is `(vector …)` — rejecting the literal the author just wrote
 * is a seam. Conversion is a SHALLOW pair copy of already-boxed `__vector__`
 * elements (same as `vector->list`), empty → nil. Rejected alternative: project
 * AVector onto AJSArrayList. That view's owner protocol is the borrowed-JS
 * store (`elementAt` boxes raw source; `toJS` at offset 0 returns `source` by
 * identity). AVector.__vector__ is already boxed AValues — routing it through
 * that owner would trip boxElement's hygiene invariant and leak AValues on
 * egress. A pair copy never mixes the two worlds.
 */
export function adoptSpine(v: AJSArray): AJSArrayList | ANil;
export function adoptSpine(v: AVector): AListAlike;
export function adoptSpine<T>(v: T): T;
export function adoptSpine(v: unknown): unknown {
  if (v instanceof AJSArray) return AJSArrayList.at(v, 0);
  if (v instanceof AVector) return APair.fromArray(CONSTANT_CTX, v.__vector__, false);
  return v;
}

/**
 * Precompute the per-slot adopter for a contract at BAKE time — call path pays nothing
 * for a verb with no list slots (common case); a verb that does pays one instanceof
 * per marked slot.
 *
 * Returns undefined when no slot adopts — bake sites skip the wrapper entirely.
 *
 * restSchema covers the variadic tail (for-each's inputRest), where EVERY trailing
 * argument is a list and each adopts independently.
 *
 * Incoming args are raw SchemeValues (a `z.listAlike` slot may still hold AJSArray
 * or AVector). The result is the impl's scheme-face tuple — `z.listAlike` is
 * AListAlike after this runs. Whether any slot adopts is a runtime WeakSet check,
 * so the return stays `| undefined`; the type cannot see the mark.
 *
 * `AdoptedArgs` keeps a concrete tuple when it is already SchemeValues, and falls
 * back to `SchemeValue[]` when `I`/`Rest` are still the wide VectorSpec bounds
 * (define's erased factory body).
 */
export type AdoptedArgs<I extends VectorSpec, Rest extends RestSpec = undefined> =
  DecodedArgsWithRest<I, Rest, "scheme"> extends infer T
    ? T extends readonly SchemeValue[]
      ? T
      : SchemeValue[]
    : SchemeValue[];

export type SlotAdopter<I extends VectorSpec, Rest extends RestSpec = undefined> = (
  args: readonly SchemeValue[],
) => AdoptedArgs<I, Rest>;

export function buildSlotAdopter<const I extends VectorSpec, const Rest extends RestSpec = undefined>(
  input: I,
  inputRest?: Rest,
): SlotAdopter<I, Rest> | undefined {
  const slots: readonly unknown[] = Array.isArray(input) ? input : [];
  const adoptingSlots = slots.map(isSpineAdopting);
  const restAdopts = isSpineAdopting(inputRest);
  if (!adoptingSlots.some(Boolean) && !restAdopts) return undefined;

  return (args) =>
    args.map((arg, i) => {
      const adopts = i < adoptingSlots.length ? adoptingSlots[i] : restAdopts;
      return adopts ? adoptSpine(arg) : arg;
      // `.map` erases the per-slot tuple; the contract is SlotAdopter's return.
    }) as AdoptedArgs<I, Rest>;
}
