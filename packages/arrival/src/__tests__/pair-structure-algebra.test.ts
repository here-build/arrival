// Algebras-in-entities cell (wave 2): Pair's structure-algebras — Functor,
// Filterable, Foldable, Traversable, Chain, Semigroup (list-append), Monoid
// (nil identity). Migrated from the fantasy-land-lips.ts monkey-patch INTO the
// Pair class body (plan-2026-06-10-algebras-in-entities.md).
//
// Pair has NO `arrival/tagless-final/equals` BY DESIGN — `structuralEqual` IS its Setoid
// (a self-recursive Pair instance would loop ∞; see the matrix in the plan). So
// the law harness's internal `equals` (which calls `a["arrival/tagless-final/equals"]`)
// can't be used for Pair directly; we feed `functorLaws` an explicit
// structuralEqual `eq`, and assert Semigroup/Monoid laws directly over
// structuralEqual.
import fc from "fast-check";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { describe, expect, it } from "vitest";
import { APair } from "../values/primitives/APair.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import { structuralEqual } from "../values/structural-equal.js";
import { functorLaws } from "./algebra-laws.js";
import { AExact } from "../values/primitives/AExact.js";
import { tf } from "../values/tagless-final.js";


type FL = Record<string, any>;

// Pairs over small integer arrays (deep=false to keep raw JS numbers, so the
// element-level transforms below are plain arithmetic). Includes the empty
// list (nil) and length up to 4 so associativity has something to bite on.
const intList = fc
  .array(fc.integer({ min: -5, max: 5 }), { maxLength: 4 })
  .map((arr) => APair.fromArray(CONSTANT_CTX, arr, false) as APair | ANil);

// Non-empty variant for tests that need a Pair head (Functor laws map over a
// Pair; nil has its own trivial behavior covered separately).
const nonEmptyIntList = fc
  .array(fc.integer({ min: -5, max: 5 }), { minLength: 1, maxLength: 4 })
  .map((arr) => APair.fromArray(CONSTANT_CTX, arr, false) as APair);

const eq = (a: unknown, b: unknown) => structuralEqual(a, b);

// ----------------------------------------------------------------------
// Functor — identity + composition, equality via structuralEqual.
// ----------------------------------------------------------------------
functorLaws<APair, number>("Pair", {
  arb: nonEmptyIntList,
  f: (x) => x + 1,
  g: (x) => x * 2,
  eq,
});

// ----------------------------------------------------------------------
// Semigroup (list append) — associativity over structuralEqual. (Cannot use
// the harness `semigroupLaws`: it needs `arrival/tagless-final/equals`, which Pair
// deliberately lacks.)
// ----------------------------------------------------------------------
describe("Pair — Semigroup (list-append)", () => {
  const concat = (a: FL, b: FL) => a[tf("concat")](b);
  it("associativity: (a⋄b)⋄c ≡ a⋄(b⋄c)", () => {
    fc.assert(
      fc.property(intList, intList, intList, (a, b, c) => {
        const lhs = concat(concat(a, b), c);
        const rhs = concat(a, concat(b, c));
        return eq(lhs, rhs);
      }),
    );
  });
  it("concat preserves element order and is pure (operands untouched)", () => {
    const a = APair.fromArray(CONSTANT_CTX, [1, 2], false) as APair;
    const b = APair.fromArray(CONSTANT_CTX, [3, 4], false) as APair;
    const r = (a)[tf("concat")](b);
    expect((r as APair).to_array()).toEqual([1, 2, 3, 4]);
    // purity: a and b unchanged
    expect((a as APair).to_array()).toEqual([1, 2]);
    expect((b as APair).to_array()).toEqual([3, 4]);
  });
});

// ----------------------------------------------------------------------
// Monoid — nil is the identity. (Direct, same reason as Semigroup.)
// ----------------------------------------------------------------------
describe("Pair — Monoid (nil identity)", () => {
  const concat = (a: FL, b: FL) => a[tf("concat")](b);
  const empty = () => (APair)[tf("empty")]() as ANil;
  it("Pair['arrival/tagless-final/empty']() is nil", () => {
    expect(empty()).toBe(nil);
  });
  it("right identity: a ⋄ empty ≡ a", () => {
    fc.assert(fc.property(intList, (a) => eq(concat(a, empty()), a)));
  });
  it("left identity: empty ⋄ a ≡ a (nil's own concat is the identity)", () => {
    // nil['arrival/tagless-final/concat'](a) === a — Nil is the list-monoid identity
    // (declared in types.ts alongside Pair's list-append).
    fc.assert(fc.property(intList, (a) => eq(concat(empty(), a), a)));
  });
});

// ----------------------------------------------------------------------
// Foldable — behavioral. reduce sums a list; empty folds to the seed.
// ----------------------------------------------------------------------
describe("Pair — Foldable (reduce)", () => {
  it("reduce sums elements left-to-right", async () => {
    const list = APair.fromArray(CONSTANT_CTX, [1, 2, 3, 4], false) as APair;
    // arrival/tagless-final/reduce is element-FIRST: fn(element, acc).
    const sum = await (list)[tf("reduce")]((x: number, acc: number) => acc + x, 0);
    expect(sum).toBe(10);
  });
  it("reduce collects in order", async () => {
    const list = APair.fromArray(CONSTANT_CTX, [1, 2, 3], false) as APair;
    // element-FIRST fn(element, acc): append the element onto the accumulator, in order.
    const collected = await (list)[tf("reduce")]((x: number, acc: number[]) => [...acc, x], [] as number[]);
    expect(collected).toEqual([1, 2, 3]);
  });
  it("reduce on empty-pair sentinel returns the seed (no phantom element)", async () => {
    let calls = 0;
    // element-FIRST fn(element, acc); the sentinel never calls fn, so the seed is returned.
    const r = await (new APair(CONSTANT_CTX, undefined, nil))[tf("reduce")]((_element: unknown, acc: string) => {
      calls++;
      return acc;
    }, "SEED");
    expect(calls).toBe(0);
    expect(r).toBe("SEED");
  });
});

// ----------------------------------------------------------------------
// Filterable — behavioral. keeps evens; sentinel short-circuits.
// ----------------------------------------------------------------------
describe("Pair — Filterable (filter)", () => {
  it("filter keeps evens", async () => {
    const list = APair.fromArray(CONSTANT_CTX, [1, 2, 3, 4, 5, 6], false) as APair;
    const evens = (await (list)[tf("filter")]((x: number) => x % 2 === 0)) as APair;
    expect(evens.to_array()).toEqual([2, 4, 6]);
  });
  it("filter all-false yields nil", async () => {
    const list = APair.fromArray(CONSTANT_CTX, [1, 3, 5], false) as APair;
    const r = await list[tf("filter")](() => false);
    expect(r).toBe(nil);
  });
  it("filter on empty-pair sentinel does not call the predicate", async () => {
    let calls = 0;
    await (new APair(CONSTANT_CTX, undefined, nil))[tf("filter")](() => {
      calls++;
      return true;
    });
    expect(calls).toBe(0);
  });
});

// ----------------------------------------------------------------------
// Traversable — behavioral. Over a leaf-mode `of` (no applicative ap), traverse
// wraps each element. We use an array-applicative-free `of = (x)=>x` so the
// structure is rebuilt as nested Pairs (matches the monkey-patch's of-leaf path).
// ----------------------------------------------------------------------
describe("Pair — Traversable (traverse)", () => {
  it("traverse with identity-of visits each element once, terminating at nil", () => {
    const ofCalls: unknown[] = [];
    const of = (v: unknown) => {
      ofCalls.push(v);
      return v;
    };
    const list = APair.fromArray(CONSTANT_CTX, [1, 2], false) as APair;
    (list)[tf("traverse")](of, (x: number) => x);
    // base case of(nil) + one of(new Pair(...)) per element (leaf path) = 1 + 2.
    expect(ofCalls.length).toBe(3);
    // last-built base case wrapped nil
    expect(ofCalls.some((v) => v instanceof ANil)).toBe(true);
  });
  it("traverse over an applicative (array) sequences effects", () => {
    // mappedCar carries arrival/tagless-final/ap → traverse uses ap to combine.
    // Use a minimal Identity-like applicative: { value, 'arrival/tagless-final/ap' }.
    const Id = (value: unknown) => ({
      value,
      [tf("ap")](other: any) {
        // this holds a function-or-value; for traverse, `this` wraps the head
        // and `other` wraps the rest — combine into a Pair.
        return Id(new APair(CONSTANT_CTX, (this as any).value, other.value));
      },
    });
    const list = APair.fromArray(CONSTANT_CTX, [1, 2, 3], false) as APair;
    const result = (list)[tf("traverse")]((v: unknown) => Id(v), (x: number) => Id(x)) as any;
    expect((result.value as APair).to_array()).toEqual([1, 2, 3]);
  });
});

// ----------------------------------------------------------------------
// Chain (Monad) — map-then-flatten via the PURE concat. NO global_env append.
// ----------------------------------------------------------------------
describe("Pair — Chain (flatten via pure concat)", () => {
  it("chain duplicates each element (x → (x x))", () => {
    const list = APair.fromArray(CONSTANT_CTX, [1, 2, 3], false) as APair;
    const r = (list)[tf("chain")]((x: number) => APair.fromArray(CONSTANT_CTX, [x, x], false)) as APair;
    expect(r.to_array()).toEqual([1, 1, 2, 2, 3, 3]);
  });
  it("chain with single-element results equals map", () => {
    const list = APair.fromArray(CONSTANT_CTX, [1, 2, 3], false) as APair;
    const r = (list)[tf("chain")]((x: number) => APair.fromArray(CONSTANT_CTX, [x + 10], false)) as APair;
    expect(r.to_array()).toEqual([11, 12, 13]);
  });
  it("chain flattening empties drops them (nil result)", () => {
    const list = APair.fromArray(CONSTANT_CTX, [1, 2], false) as APair;
    const r = (list)[tf("chain")](() => nil);
    expect(r).toBe(nil);
  });
});

// ----------------------------------------------------------------------
// Applicative `of` — single-element list.
// ----------------------------------------------------------------------
describe("Pair — Applicative (static of)", () => {
  it("of(x) is a one-element list (x)", () => {
    const p = (APair)[tf("of")](42) as APair;
    expect(p).toBeInstanceOf(APair);
    expect(p.car).toBe(42);
    expect(p.cdr).toBe(nil);
  });
});

// ----------------------------------------------------------------------
// Provenance-clone termination — the recursors stop on `instanceof Nil`, not
// `=== nil`, so a provenance-bearing Nil clone in tail position terminates
// cleanly (no phantom element). Guards the wave-2 invariant.
// ----------------------------------------------------------------------
describe("Pair — recursors terminate on Nil clones (provenance)", () => {
  const cloneNil = () => nil.withProvenance(new Set<number>([42]));
  it("map(Pair(1, nil-clone)) → (1), fn called once", async () => {
    // fn receives the pair's actual boxed element (map never auto-unboxes) — the identity
    // fn hands back the SAME AExact instance, so the result pair's car is that instance.
    const calls: unknown[] = [];
    const one = new AExact(CONSTANT_CTX, 1n);
    const r = (await new APair(CONSTANT_CTX, one, cloneNil())[tf("map")]((x: unknown) => {
      calls.push(x);
      return x;
    })) as APair;
    expect(calls).toEqual([one]);
    expect(r.car).toBe(one);
    expect(r.cdr).toBeInstanceOf(ANil);
  });
  it("reduce(Pair(1, nil-clone)) folds one element", async () => {
    // `x` is the boxed AExact — unwrap via valueOf() (a JS number) before folding, never mix
    // it directly with a bigint accumulator (AExact.valueOf() returns number, not bigint).
    const r = await new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), cloneNil())[tf("reduce")](
      (x: AExact, acc: number) => acc + x.valueOf(),
      0,
    );
    expect(r).toBe(1);
  });
});
