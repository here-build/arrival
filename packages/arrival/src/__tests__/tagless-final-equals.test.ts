import { describe, expect, it } from "vitest";

import { AValue } from "../values/AValue.js";
import { Pair } from "../values/Pair.js";
import { SchemeVector } from "../values/SchemeVector.js";
import { SchemeString } from "../values/SchemeString.js";
import { SchemeBool } from "../values/SchemeBool.js";
import { SchemeSymbol } from "../values/SchemeSymbol.js";
import { SchemeBytevector } from "../values/SchemeBytevector.js";
import { SchemeExact, SchemeInexact } from "../values/numbers.js";
import { HalfBaked } from "../values/HalfBaked.js";
import { LazySeq } from "../values/LazySeq.js";
import { SchemeJSObject, SchemeJSFunction } from "../membrane.js";
import { Nil, nil, SchemeCharacter } from "../values/types.js";
import { eq, eqv, structuralEqual } from "../values/structural-equal.js";

// ─────────────────────────────────────────────────────────────────────────────
// B2 — fantasy-land/equals as a totalic, cycle-safe, tagless-final Setoid.
//
// The protocol moves per-type structural comparison ONTO the terms: AValue
// declares an abstract ["fantasy-land/equals"](other, seen?) so EVERY subtype
// owns its equality; structuralEqual becomes a thin co-induction HARNESS that
// records the (a, b) partner pair BEFORE descending (generically, not just for
// Vector) and threads a shared seen map through the per-type comparisons so
// mutually-cyclic structures terminate.
//
// RED-FIRST expectation BEFORE the impl:
//   G1 — partial: Pair / HalfBaked / LazySeq / membrane wrappers lack EQ.
//   G2 — red: Pair has no EQ at all; the seen-threaded direct call is absent.
//   G3 — GREEN-now (investigated): the fresh-seen stack-blow is LATENT, masked
//        by structuralEqual's inline Vector block; G3 is the regression guard
//        that the refactor's seen-threading keeps mutual cycles terminating. See
//        the G3 describe-block comment.
//   G4 — mostly green: structuralEqual already handles deep + cyclic Pairs and
//        the inline Vector special-case.
//   G5 — green: eq/eqv stay identity/scalar; this group is the landmine guard.
// ─────────────────────────────────────────────────────────────────────────────

const EQ = "fantasy-land/equals";

// Build a proper list of Pairs terminated by nil.
function list(...xs: unknown[]): Pair | Nil {
  let acc: Pair | Nil = nil;
  for (let i = xs.length - 1; i >= 0; i--) acc = new Pair(xs[i], acc);
  return acc as Pair;
}

// A value that defines EQ (typeof v[EQ] === "function"). Build a representative
// of every concrete AValue subtype; the abstract method forces totality.
function representativeValues(): { name: string; value: AValue }[] {
  const reps: { name: string; value: AValue }[] = [
    { name: "Nil", value: nil },
    { name: "Pair", value: new Pair(new SchemeExact(1n), nil) },
    { name: "SchemeString", value: new SchemeString("x") },
    { name: "SchemeExact", value: new SchemeExact(1n) },
    { name: "SchemeInexact", value: new SchemeInexact(1.5) },
    { name: "SchemeBool", value: new SchemeBool(true) },
    { name: "SchemeCharacter", value: new SchemeCharacter("a") },
    { name: "SchemeSymbol", value: new SchemeSymbol("sym") },
    { name: "SchemeVector", value: new SchemeVector([new SchemeExact(1n)]) },
    { name: "SchemeBytevector", value: new SchemeBytevector([1, 2, 3]) },
    { name: "HalfBaked", value: HalfBaked.collection([Promise.resolve([])], () => [0, 1]) },
    { name: "LazySeq", value: new LazySeq([new SchemeExact(1n)]) },
    { name: "SchemeJSObject", value: new SchemeJSObject({ a: 1 }) },
    { name: "SchemeJSFunction", value: new SchemeJSFunction(() => 1) },
  ];
  return reps;
}

// ─────────────────────────────────────────────────────────────────────────────
// G1 — TOTALITY: every representative AValue defines fantasy-land/equals.
// ─────────────────────────────────────────────────────────────────────────────
describe("G1 totality — every AValue subtype defines fantasy-land/equals", () => {
  for (const { name, value } of representativeValues()) {
    it(name + " has a callable fantasy-land/equals", () => {
      expect(typeof (value as unknown as Record<string, unknown>)[EQ]).toBe("function");
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// G2 — PAIR SETOID: equal/unequal/pair-vs-nonpair/nested + cycles via the term.
// ─────────────────────────────────────────────────────────────────────────────
describe("G2 Pair Setoid", () => {
  // Invoke EQ as a METHOD on the receiver so `this` is bound (the protocol is a
  // method on the term). Pre-impl, Pair has no EQ → "not a function" (a clean RED).
  const pairEq = (p: Pair, other: unknown, seen?: Map<object, Set<object>>): boolean =>
    (p as unknown as { ["fantasy-land/equals"](o: unknown, s?: Map<object, Set<object>>): boolean })[EQ](other, seen);

  it("equal proper lists compare equal through the Pair Setoid", () => {
    const a = list(new SchemeExact(1n), new SchemeExact(2n), new SchemeExact(3n)) as Pair;
    const b = list(new SchemeExact(1n), new SchemeExact(2n), new SchemeExact(3n)) as Pair;
    expect(pairEq(a, b)).toBe(true);
  });

  it("unequal lists compare unequal", () => {
    const a = list(new SchemeExact(1n), new SchemeExact(2n)) as Pair;
    const b = list(new SchemeExact(1n), new SchemeExact(9n)) as Pair;
    expect(pairEq(a, b)).toBe(false);
  });

  it("pair vs non-pair is false", () => {
    const a = list(new SchemeExact(1n)) as Pair;
    expect(pairEq(a, new SchemeExact(1n))).toBe(false);
    expect(pairEq(a, nil)).toBe(false);
  });

  it("nested lists compare structurally", () => {
    const a = list(list(new SchemeExact(1n), new SchemeExact(2n)), new SchemeString("k")) as Pair;
    const b = list(list(new SchemeExact(1n), new SchemeExact(2n)), new SchemeString("k")) as Pair;
    const c = list(list(new SchemeExact(1n), new SchemeExact(7n)), new SchemeString("k")) as Pair;
    expect(pairEq(a, b)).toBe(true);
    expect(pairEq(a, c)).toBe(false);
  });

  it("self-cyclic pairs (a.cdr=a, b.cdr=b) compare equal AND terminate", () => {
    const a = new Pair(new SchemeExact(1n), nil);
    a.cdr = a;
    const b = new Pair(new SchemeExact(1n), nil);
    b.cdr = b;
    expect(pairEq(a, b)).toBe(true);
  });

  it("mutually-cyclic pairs (a↔b vs c↔d) compare equal AND terminate", () => {
    const a = new Pair(new SchemeExact(1n), nil);
    const b = new Pair(new SchemeExact(2n), nil);
    a.cdr = b;
    b.cdr = a;
    const c = new Pair(new SchemeExact(1n), nil);
    const d = new Pair(new SchemeExact(2n), nil);
    c.cdr = d;
    d.cdr = c;
    expect(pairEq(a, c)).toBe(true);
  });

  it("an explicit seen Map argument is honored", () => {
    const a = list(new SchemeExact(1n)) as Pair;
    const b = list(new SchemeExact(1n)) as Pair;
    expect(pairEq(a, b, new Map())).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G3 — VECTOR SETOID: mutually-cyclic vectors must terminate.
//
// INVESTIGATED SIGNAL (the prompt predicted this group RED-now; it is GREEN-now):
// the documented fresh-seen stack-blow is LATENT today, masked by the inline
// SchemeVector special-case in structuralEqual (structural-equal.ts:50-63) which
// threads a SHARED seen and intercepts vectors BEFORE the fantasy-land/equals
// hook. A direct a[EQ](c) call recurses through structuralEqual's inline block
// (shared seen) — never through the vector method's own fresh-seen — so it
// terminates. The blow-up only manifests if the refactor removes that inline
// block and routes vectors through the method WITHOUT threading seen. So this
// group is a REGRESSION GUARD: green now, and it MUST STAY GREEN after the
// refactor — proving the new seen-threaded SchemeVector Setoid still terminates
// on mutual cycles once it owns the recursion.
// ─────────────────────────────────────────────────────────────────────────────
describe("G3 Vector Setoid — cyclic vectors terminate", () => {
  const vecEq = (v: SchemeVector, other: unknown, seen?: Map<object, Set<object>>): boolean =>
    (v as unknown as { ["fantasy-land/equals"](o: unknown, s?: Map<object, Set<object>>): boolean })[EQ](other, seen);

  it("mutually-cyclic vectors a↔b vs c↔d compare equal AND terminate", () => {
    const a = new SchemeVector([new SchemeExact(1n)]);
    const b = new SchemeVector([new SchemeExact(2n)]);
    a.__vector__.push(b);
    b.__vector__.push(a);
    const c = new SchemeVector([new SchemeExact(1n)]);
    const d = new SchemeVector([new SchemeExact(2n)]);
    c.__vector__.push(d);
    d.__vector__.push(c);
    expect(vecEq(a, c)).toBe(true);
  });

  it("equal acyclic vectors compare equal; unequal differ", () => {
    const a = new SchemeVector([new SchemeExact(1n), new SchemeExact(2n)]);
    const b = new SchemeVector([new SchemeExact(1n), new SchemeExact(2n)]);
    const c = new SchemeVector([new SchemeExact(1n), new SchemeExact(3n)]);
    expect(vecEq(a, b)).toBe(true);
    expect(vecEq(a, c)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G4 — equal? REGRESSION: structuralEqual deep + cyclic, routing through Setoids.
// ─────────────────────────────────────────────────────────────────────────────
describe("G4 equal? regression — structuralEqual", () => {
  it("deep nested structures: true and false", () => {
    const a = list(list(new SchemeExact(1n)), new SchemeString("k"), new SchemeVector([new SchemeBool(true)]));
    const b = list(list(new SchemeExact(1n)), new SchemeString("k"), new SchemeVector([new SchemeBool(true)]));
    const c = list(list(new SchemeExact(1n)), new SchemeString("k"), new SchemeVector([new SchemeBool(false)]));
    expect(structuralEqual(a, b)).toBe(true);
    expect(structuralEqual(a, c)).toBe(false);
  });

  it("cyclic list via structuralEqual terminates", () => {
    const a = new Pair(new SchemeExact(1n), nil);
    a.cdr = a;
    const b = new Pair(new SchemeExact(1n), nil);
    b.cdr = b;
    expect(structuralEqual(a, b)).toBe(true);
    // self-equality on a cyclic list must also terminate (the bridge.ts war story)
    expect(structuralEqual(a, a)).toBe(true);
  });

  it("cyclic vector via structuralEqual terminates", () => {
    const a = new SchemeVector([new SchemeExact(1n)]);
    a.__vector__.push(a);
    const b = new SchemeVector([new SchemeExact(1n)]);
    b.__vector__.push(b);
    expect(structuralEqual(a, b)).toBe(true);
  });

  it("Pair & Vector now route through their own Setoid (sanity)", () => {
    expect(typeof (new Pair(new SchemeExact(1n), nil) as unknown as Record<string, unknown>)[EQ]).toBe("function");
    expect(typeof (new SchemeVector([]) as unknown as Record<string, unknown>)[EQ]).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G5 — eq?/eqv? LANDMINE: these stay identity/scalar. structuralEqual is structural.
// ─────────────────────────────────────────────────────────────────────────────
describe("G5 eq?/eqv? landmine — must stay identity/scalar", () => {
  it("eq?/eqv? on distinct equal lists is #f; equal? is #t", () => {
    expect(eq(list(new SchemeExact(1n)), list(new SchemeExact(1n)))).toBe(false);
    expect(eqv(list(new SchemeExact(1n)), list(new SchemeExact(1n)))).toBe(false);
    expect(structuralEqual(list(new SchemeExact(1n)), list(new SchemeExact(1n)))).toBe(true);
  });

  it("eqv? exact vs inexact #f; exact vs exact #t", () => {
    expect(eqv(new SchemeExact(1n), new SchemeInexact(1))).toBe(false);
    expect(eqv(new SchemeExact(1n), new SchemeExact(1n))).toBe(true);
  });
});
