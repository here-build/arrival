// tagless-final.ts — the GLOBAL declaration of arrival's tagless-final algebra.
//
// "Primitives introduce the algebra ('I know how to handle it'); an EnvCapability introduces
// the symbol that hands off to it." This file is the single source of WHAT the algebra is:
// the CLOSED, declared set of operations a primitive MAY implement, each with a FIXED
// signature. A value that knows how to map/sort/compare declares the matching
// `arrival/tagless-final/<op>` method — and because the op is declared HERE, that impl is
// type-checked against this contract. Not full freedom: an entity implements a SUBSET of a
// declared algebra, never an ad-hoc method.
//
// THE DISPATCH CONVENTION (symbol.tagless): a call `(op ...args tail)` lowers to
// `tail["arrival/tagless-final/op"](...args, runCtx)` — the LAST operand is the receiver
// (it carries the algebra), the leading operands are the args, the run's RunContext threads
// last. Option A: the materializing ops take runCtx so the TERM charges its OWN heap — the
// primitive owns its algebra AND its cost.

import type { AValue } from "./primitives/AValue.js";
import type { RunContext } from "./primitives/RunContext.js";
import type { SeenMap } from "./structural-equal.js";

/** The ONE spelling of the tagless-final method-name prefix. Every consumer imports THIS
 *  (199 occurrences across 39 files previously inlined the literal). */
export const TAGLESS_PREFIX = "arrival/tagless-final/";
export type TaglessPrefix = typeof TAGLESS_PREFIX;

/** A result that MAY be sync — the empty case (ANil) returns immediately; APair/AVector await. */
type MaybePromise<T> = T | Promise<T>;

/** Prefix every key of T with P — maps an algebra interface to the method-name dict a value
 *  actually carries: `{ map: … }` → `{ "arrival/tagless-final/map": … }`. */
export type PrefixDict<P extends string, T> = { [K in keyof T as `${P}${string & K}`]: T[K] };

/**
 * arrival's tagless-final algebra — the CLOSED, declared set of operations a primitive MAY
 * implement. Signatures are SCHEME-VALUE-level (the impl works on terms, like `symbol.native`),
 * faithful to the live entity methods. The materializing ops (map/filter/reduce/sort) take the
 * run's RunContext LAST so the term charges its own heap (Option A).
 *
 * Currently declared: the Setoid (equals, universal), the Order (lte), and the sequence algebra
 * (length/map/filter/reduce/sort). The remaining per-entity methods (car/cdr, and the
 * fantasy-land remnants concat/empty/of/traverse/chain/ap) fold in as they are needed/dissolved.
 */
export interface ArrivalTaglessFinal {
  /** Setoid — structural equality. Universal (declared `abstract` on AValue: every value has it). */
  equals(other: unknown, seen?: SeenMap): boolean;
  /** Order — the ≤ of an Ord type (numbers, strings, chars, symbols, bytevectors). */
  lte(other: unknown): boolean;
  /** Element count — the per-primitive divergence (elements' provenance) lives on the term. */
  length(runCtx?: RunContext): AValue | number;
  /** Functor — map a fn over the elements (box-preserving or box-stripping per the term). */
  map(fn: (x: unknown) => unknown | Promise<unknown>, runCtx?: RunContext): MaybePromise<AValue>;
  /** Filterable — keep elements matching a pred (or RegExp). */
  filter(pred: ((x: unknown) => unknown | Promise<unknown>) | RegExp, runCtx?: RunContext): MaybePromise<AValue>;
  /** Foldable left-fold — scheme convention `fn(element, acc)`, seed last. */
  reduce<Acc>(fn: (element: unknown, acc: Acc) => Acc | Promise<Acc>, initial: Acc, runCtx?: RunContext): MaybePromise<Acc>;
  /** Ordering — a sorted sequence (container-preserving); default order is the elements' own `lte`. */
  sort(comparator?: (a: unknown, b: unknown) => unknown, runCtx?: RunContext): AValue;
}

/** The declared op names — the type-wired range of `symbol.tagless` keys. */
export type TaglessOp = keyof ArrivalTaglessFinal;

/** The method-name dict a value MAY carry: each `arrival/tagless-final/<op>`, all optional.
 *  AValue merges this in (declaration merging) so every entity's override is checked against
 *  the global signature, and an entity simply omits the ops it does not implement.
 *
 *  Declared METHOD-style (not the `Partial<PrefixDict<…>>` mapped type) on purpose: a mapped
 *  type yields function-typed PROPERTIES, and TS forbids a subclass overriding a base property
 *  with a method (TS2425). The `_PrefixDictMatches` assertion below pins this hand-written form
 *  in lock-step with `PrefixDict<TaglessPrefix, ArrivalTaglessFinal>` — they are mutually
 *  assignable (the property-vs-method split is an inheritance rule, not an assignability one). */
export interface TaglessMethods {
  ["arrival/tagless-final/equals"]?(other: unknown, seen?: SeenMap): boolean;
  ["arrival/tagless-final/lte"]?(other: unknown): boolean;
  ["arrival/tagless-final/length"]?(runCtx?: RunContext): AValue | number;
  ["arrival/tagless-final/map"]?(fn: (x: unknown) => unknown | Promise<unknown>, runCtx?: RunContext): MaybePromise<AValue>;
  ["arrival/tagless-final/filter"]?(pred: ((x: unknown) => unknown | Promise<unknown>) | RegExp, runCtx?: RunContext): MaybePromise<AValue>;
  ["arrival/tagless-final/reduce"]?<Acc>(fn: (element: unknown, acc: Acc) => Acc | Promise<Acc>, initial: Acc, runCtx?: RunContext): MaybePromise<Acc>;
  ["arrival/tagless-final/sort"]?(comparator?: (a: unknown, b: unknown) => unknown, runCtx?: RunContext): AValue;
}

/** Both-ways assignability between the hand-written method-style `TaglessMethods` and the
 *  conceptual `Partial<PrefixDict<…>>` — drift in either (op added/removed/retyped) breaks it. */
type _Mutually<A, B> = A extends B ? (B extends A ? true : ["TaglessMethods drifted from PrefixDict"]) : ["TaglessMethods drifted from PrefixDict"];
export type _PrefixDictMatches = _Mutually<TaglessMethods, Partial<PrefixDict<TaglessPrefix, ArrivalTaglessFinal>>>;

/** Runtime list of the declared ops (keyof is type-only). The two type-level proofs below pin
 *  it in lock-step with `ArrivalTaglessFinal` — adding an op to one without the other won't compile. */
export const TAGLESS_OP_NAMES = ["equals", "lte", "length", "map", "filter", "reduce", "sort"] as const;
type _ListCoversAlgebra = TaglessOp extends (typeof TAGLESS_OP_NAMES)[number] ? true : ["MISSING op in TAGLESS_OP_NAMES"];
type _AlgebraCoversList = (typeof TAGLESS_OP_NAMES)[number] extends TaglessOp ? true : ["STALE op in TAGLESS_OP_NAMES"];
export type _TaglessSync = [_ListCoversAlgebra, _AlgebraCoversList];

/** Build a prefixed tagless method-name from an op name, type-safe:
 *  `tf("map")` → `"arrival/tagless-final/map"`. The one place callers form the key. */
export function tf<K extends TaglessOp>(name: K): `${TaglessPrefix}${K}` {
  return `${TAGLESS_PREFIX}${name}`;
}
