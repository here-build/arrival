// Algebras-in-entities cell: Setoid + Semigroup + Functor on SchemeVector.
// Elements are boxed exact numbers (AExact) from a small domain so collisions
// make the Setoid laws (symmetry/transitivity) bite — a vector's payload is
// SchemeValue[], so `(vector 1 2 3)` stores AExact, not raw JS numbers. The
// Functor transforms are number→number over the elements' numeric value
// (AExact coerces via valueOf).
//
// AVector.map crosses OUT to a foreign Functor — it STRIPS each element to its raw
// JS value, but re-presents the stripped array as the AUTO-WRAPPING AJSArray (raw
// inside `.source`, each element boxed BACK via jsToScheme ON ACCESS). So the mapped
// structure exposes a boxed `__vector__` again, and the Functor identity law
// `map(id) ≡ id` holds under the BOXED Setoid: `boxedEq` compares the two structures'
// materialized boxes element-wise via `structuralEqual` (which dispatches each
// element's AExact Setoid). The value-based `numeq` escape hatch the old box-strip
// forced is GONE — the impersonator's box-on-access is what makes the law natural.
// (Boxing track S5 — docs/plan-2026-06-10-boxing-track.md.)
import fc from "fast-check";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { describe, expect, it } from "vitest";
import { AVector } from "../values/primitives/AVector.js";
import { AJSArray } from "../values/primitives/AJSArray.js";
import { AExact } from "../values/primitives/AExact.js";
import { structuralEqual } from "../values/structural-equal.js";
import type { SchemeValue } from "../values/types.js";
import { functorLaws, semigroupLaws, setoidLaws } from "./algebra-laws.js";

const FL = "arrival/tagless-final/equals";
const CONCAT = "arrival/tagless-final/concat";
const MAP = "arrival/tagless-final/map";

// A vector element is a boxed exact integer (the interpreter is monadic-boxed:
// `(vector 1 2 3)` mints AExact slots). The reader domain is small ints, so an
// exact box is the faithful element.
const box = (n: number): AExact => new AExact(CONSTANT_CTX, BigInt(n));
const vec = (ns: number[]): AVector => new AVector(CONSTANT_CTX, ns.map(box));

// Numeric value of one element — AExact coerces via valueOf. A mapped structure
// re-boxes its raw `.source` to AExact on access, so a materialized element is an
// AExact just like a constructed one.
const numOf = (x: SchemeValue): number => Number(x.valueOf());

// The BOXED Setoid equality for the Functor laws: AVector.map crosses out to the
// auto-wrapping AJSArray, whose Scheme-level `__vector__` boxes each element back —
// so both the mapped structure and the source materialize to a vector of boxes. We
// compare those boxes element-wise via `structuralEqual`, which routes each element
// through its own Setoid (AExact ≡ AExact). Reads `__vector__`, which AVector and the
// mapped AJSArray both expose, so the same `eq` serves an unmapped source and a mapped
// result. (This REPLACES the old value-based `numeq` escape hatch the box-strip forced.)
const boxedEq = (a: { __vector__: SchemeValue[] }, b: { __vector__: SchemeValue[] }): boolean =>
  a.__vector__.length === b.__vector__.length && a.__vector__.every((x, i) => structuralEqual(x, b.__vector__[i]));

// Small element domain + edge cases: empty, singletons, collisions.
const arb = fc
  .oneof(
    fc.constantFrom<number[]>([], [0], [1], [1, 2], [1, 2, 3], [2, 1]),
    fc.array(fc.integer({ min: 0, max: 4 }), { maxLength: 4 }),
  )
  .map(vec);

const equalClone = (v: AVector) => new AVector(CONSTANT_CTX, v.__vector__.slice());

setoidLaws("SchemeVector", { arb, equalClone });
semigroupLaws("SchemeVector", arb);
functorLaws<AVector, number>("SchemeVector", {
  arb,
  // Natural element transforms — a box arrives, coerces via valueOf, returns a number;
  // the mapped structure re-boxes it on access, so no manual re-boxing is needed here.
  f: (x: number) => x + 1,
  g: (x: number) => x * 2,
  eq: boxedEq,
});

describe("SchemeVector Setoid/Semigroup/Functor — boundaries", () => {
  it("structural value equality over distinct heap payloads", () => {
    const a = vec([1, 2, 3]);
    const b = vec([1, 2, 3]);
    expect(a[FL](b)).toBe(true);
  });

  it("nested-vector equality recurses through structuralEqual", () => {
    const a = new AVector(CONSTANT_CTX, [vec([1, 2]), box(3)]);
    const b = new AVector(CONSTANT_CTX, [vec([1, 2]), box(3)]);
    expect(a[FL](b)).toBe(true);
    const c = new AVector(CONSTANT_CTX, [vec([1, 9]), box(3)]);
    expect(a[FL](c)).toBe(false);
  });

  it("non-SchemeVector other → false (a raw array is NOT a SchemeVector)", () => {
    const a = vec([1, 2]);
    expect(a[FL]([1, 2])).toBe(false);
    expect(a[FL](42)).toBe(false);
  });

  it("concat appends elements, length-additive", () => {
    const a = vec([1, 2]);
    const b = vec([3]);
    const c = a[CONCAT](b);
    expect(c.__vector__.map(numOf)).toEqual([1, 2, 3]);
  });

  it("map crosses out to the auto-wrapping AJSArray, leaves the source untouched", async () => {
    const a = vec([1, 2, 3]);
    // The transform returns a boxed element — `map`'s `fn` is honestly typed `SchemeValue →
    // SchemeValue` (a Scheme transform yields a Scheme value). `map` then crosses that box OUT to
    // the impersonator AJSArray (raw `.source`), and Scheme-level access boxes each element back.
    const mapped = (await a[MAP]((x: SchemeValue) => box(numOf(x) * 10))) as AJSArray;
    expect(mapped).toBeInstanceOf(AJSArray);
    // DR4 cross-out: the raw source holds bare numbers, reachable for a foreign Functor.
    expect(mapped.source).toEqual([10, 20, 30]);
    expect(mapped.toJs()).toEqual([10, 20, 30]);
    // Functor half: Scheme-level access re-boxes each element to an AExact.
    expect(mapped.__vector__.every((e) => e instanceof AExact)).toBe(true);
    expect(mapped.__vector__.map(numOf)).toEqual([10, 20, 30]);
    // The source vector is untouched (a fresh structure was produced).
    expect(a.__vector__.map(numOf)).toEqual([1, 2, 3]);
  });

  it("toJs / TO_JS unwrap to the raw array", () => {
    const a = vec([1, 2, 3]);
    expect(a.toJs().map(numOf)).toEqual([1, 2, 3]);
    expect(Array.isArray(a.toJs())).toBe(true);
  });
});
