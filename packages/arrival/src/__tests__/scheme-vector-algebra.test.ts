// Algebras-in-entities cell: Setoid + Semigroup + Functor on SchemeVector.
// Elements are boxed exact numbers (AExact) from a small domain so collisions
// make the Setoid laws (symmetry/transitivity) bite — a vector's payload is
// SchemeValue[], so `(vector 1 2 3)` stores AExact, not raw JS numbers. The
// Functor transforms are number→number over the elements' numeric value
// (AExact coerces via valueOf); AVector.map crosses OUT to a foreign Functor and
// STRIPS element boxes (the DR4 box-strip), so the mapped structure holds raw
// numbers — the law-equality is therefore value-based (numeq below), not the
// boxed Setoid. equalClone forges a fresh distinct-but-equal payload.
// (Boxing track S5 — docs/plan-2026-06-10-boxing-track.md.)
import fc from "fast-check";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { describe, expect, it } from "vitest";
import { AVector } from "../values/primitives/AVector.js";
import { AExact } from "../values/primitives/AExact.js";
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

// Numeric value of one (possibly post-strip) element: AVector.map STRIPS boxes,
// so a mapped vector holds raw numbers while a constructed one holds AExact —
// both answer the same JS number via valueOf.
const numOf = (x: SchemeValue): number => Number(x.valueOf());
// Value-based vector equality for the Functor laws: AVector's map crosses out to
// a foreign Functor (strips element boxes), so structures are compared by their
// elements' numeric values, length-wise.
const numeq = (a: AVector, b: AVector): boolean =>
  a.__vector__.length === b.__vector__.length &&
  a.__vector__.every((x, i) => numOf(x) === numOf(b.__vector__[i]));

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
  f: (x: number) => x + 1,
  g: (x: number) => x * 2,
  eq: numeq,
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

  it("map produces a fresh vector, leaves the source untouched", async () => {
    const a = vec([1, 2, 3]);
    // The transform returns a boxed element (vector slots are SchemeValue); map
    // then STRIPS the box on the way out (DR4), so `mapped` holds raw numbers.
    const mapped = await a[MAP]((x: SchemeValue) => box(numOf(x) * 10));
    expect(mapped.__vector__.map(numOf)).toEqual([10, 20, 30]);
    expect(a.__vector__.map(numOf)).toEqual([1, 2, 3]);
  });

  it("toJs / TO_JS unwrap to the raw array", () => {
    const a = vec([1, 2, 3]);
    expect(a.toJs().map(numOf)).toEqual([1, 2, 3]);
    expect(Array.isArray(a.toJs())).toBe(true);
  });
});
