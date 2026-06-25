import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";

import { AValue } from "../values/primitives/AValue.js";
import { APair } from "../values/primitives/APair.js";
import { AVector } from "../values/primitives/AVector.js";
import { AString } from "../values/primitives/AString.js";
import { ABool } from "../values/primitives/ABool.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { ABytevector } from "../values/primitives/ABytevector.js";
import { AExact, AInexact } from "../values/numbers.js";
import { AHalfBaked } from "../values/primitives/AHalfBaked.js";
import { ALazySeq } from "../values/primitives/ALazySeq.js";
import { AJSObject, AJSFunction } from "../membrane.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import { ACharacter } from "../values/primitives/ACharacter.js";
import { eq, eqv, structuralEqual } from "../values/structural-equal.js";
import listsCap from "../env/lists.js";
import type { EnvCapability } from "../env/capability.js";

// ─────────────────────────────────────────────────────────────────────────────
// B2 — arrival/tagless-final/equals as a totalic, cycle-safe, tagless-final Setoid.
//
// The protocol moves per-type structural comparison ONTO the terms: AValue
// declares an abstract ["arrival/tagless-final/equals"](other, seen?) so EVERY subtype
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

const EQ = "arrival/tagless-final/equals";

// Source op fns FROM THE CAPABILITY's inlined `symbols` (the bare *_OPS map was
// inlined into the constructor; the capability default export is the single
// declaration site). These packs are all the record form of `spec.symbols`.
const opsOf = (cap: EnvCapability): Record<string, (...a: any[]) => any> =>
  Object.fromEntries(
    // Migrated packs expose `symbol.native` defs (`{ kind: "native", impl }`); the legacy
    // `{ value }` form is the fallback for any entry not yet on the symbol.* API.
    Object.entries(
      cap.spec.symbols as Record<string, { impl?: (...a: any[]) => any; value?: (...a: any[]) => any }>,
    ).map(([k, v]) => [k, v.impl ?? v.value]),
  );
const LIST_OPS = opsOf(listsCap);

// Build a proper list of Pairs terminated by nil.
function list(...xs: unknown[]): APair | ANil {
  let acc: APair | ANil = nil;
  for (let i = xs.length - 1; i >= 0; i--) acc = new APair(CONSTANT_CTX, xs[i], acc);
  return acc as APair;
}

// A value that defines EQ (typeof v[EQ] === "function"). Build a representative
// of every concrete AValue subtype; the abstract method forces totality.
function representativeValues(): { name: string; value: AValue }[] {
  const reps: { name: string; value: AValue }[] = [
    { name: "Nil", value: nil },
    { name: "Pair", value: new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), nil) },
    { name: "SchemeString", value: new AString(CONSTANT_CTX, "x") },
    { name: "SchemeExact", value: new AExact(CONSTANT_CTX, 1n) },
    { name: "SchemeInexact", value: new AInexact(CONSTANT_CTX, 1.5) },
    { name: "SchemeBool", value: new ABool(CONSTANT_CTX, true) },
    { name: "SchemeCharacter", value: new ACharacter(CONSTANT_CTX, "a") },
    { name: "SchemeSymbol", value: new ASymbol(CONSTANT_CTX, "sym") },
    { name: "SchemeVector", value: new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n)]) },
    { name: "SchemeBytevector", value: new ABytevector(CONSTANT_CTX, [1, 2, 3]) },
    { name: "HalfBaked", value: AHalfBaked.collection([Promise.resolve([])], () => [0, 1]) },
    { name: "LazySeq", value: new ALazySeq(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n)]) },
    { name: "SchemeJSObject", value: new AJSObject(CONSTANT_CTX, { a: 1 }) },
    { name: "SchemeJSFunction", value: new AJSFunction(CONSTANT_CTX, () => 1) },
  ];
  return reps;
}

// ─────────────────────────────────────────────────────────────────────────────
// G1 — TOTALITY: every representative AValue defines arrival/tagless-final/equals.
// ─────────────────────────────────────────────────────────────────────────────
describe("G1 totality — every AValue subtype defines arrival/tagless-final/equals", () => {
  for (const { name, value } of representativeValues()) {
    it(name + " has a callable arrival/tagless-final/equals", () => {
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
  const pairEq = (p: APair, other: unknown, seen?: Map<object, Set<object>>): boolean =>
    (p as unknown as { ["arrival/tagless-final/equals"](o: unknown, s?: Map<object, Set<object>>): boolean })[EQ](other, seen);

  it("equal proper lists compare equal through the Pair Setoid", () => {
    const a = list(new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)) as APair;
    const b = list(new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)) as APair;
    expect(pairEq(a, b)).toBe(true);
  });

  it("unequal lists compare unequal", () => {
    const a = list(new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)) as APair;
    const b = list(new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 9n)) as APair;
    expect(pairEq(a, b)).toBe(false);
  });

  it("pair vs non-pair is false", () => {
    const a = list(new AExact(CONSTANT_CTX, 1n)) as APair;
    expect(pairEq(a, new AExact(CONSTANT_CTX, 1n))).toBe(false);
    expect(pairEq(a, nil)).toBe(false);
  });

  it("nested lists compare structurally", () => {
    const a = list(list(new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)), new AString(CONSTANT_CTX, "k")) as APair;
    const b = list(list(new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)), new AString(CONSTANT_CTX, "k")) as APair;
    const c = list(list(new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 7n)), new AString(CONSTANT_CTX, "k")) as APair;
    expect(pairEq(a, b)).toBe(true);
    expect(pairEq(a, c)).toBe(false);
  });

  it("self-cyclic pairs (a.cdr=a, b.cdr=b) compare equal AND terminate", () => {
    const a = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), nil);
    a.cdr = a;
    const b = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), nil);
    b.cdr = b;
    expect(pairEq(a, b)).toBe(true);
  });

  it("mutually-cyclic pairs (a↔b vs c↔d) compare equal AND terminate", () => {
    const a = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), nil);
    const b = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 2n), nil);
    a.cdr = b;
    b.cdr = a;
    const c = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), nil);
    const d = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 2n), nil);
    c.cdr = d;
    d.cdr = c;
    expect(pairEq(a, c)).toBe(true);
  });

  it("an explicit seen Map argument is honored", () => {
    const a = list(new AExact(CONSTANT_CTX, 1n)) as APair;
    const b = list(new AExact(CONSTANT_CTX, 1n)) as APair;
    expect(pairEq(a, b, new Map())).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G3 — VECTOR SETOID: mutually-cyclic vectors must terminate.
//
// INVESTIGATED SIGNAL (the prompt predicted this group RED-now; it is GREEN-now):
// the documented fresh-seen stack-blow is LATENT today, masked by the inline
// SchemeVector special-case in structuralEqual (structural-equal.ts:50-63) which
// threads a SHARED seen and intercepts vectors BEFORE the arrival/tagless-final/equals
// hook. A direct a[EQ](c) call recurses through structuralEqual's inline block
// (shared seen) — never through the vector method's own fresh-seen — so it
// terminates. The blow-up only manifests if the refactor removes that inline
// block and routes vectors through the method WITHOUT threading seen. So this
// group is a REGRESSION GUARD: green now, and it MUST STAY GREEN after the
// refactor — proving the new seen-threaded SchemeVector Setoid still terminates
// on mutual cycles once it owns the recursion.
// ─────────────────────────────────────────────────────────────────────────────
describe("G3 Vector Setoid — cyclic vectors terminate", () => {
  const vecEq = (v: AVector, other: unknown, seen?: Map<object, Set<object>>): boolean =>
    (v as unknown as { ["arrival/tagless-final/equals"](o: unknown, s?: Map<object, Set<object>>): boolean })[EQ](other, seen);

  it("mutually-cyclic vectors a↔b vs c↔d compare equal AND terminate", () => {
    const a = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n)]);
    const b = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 2n)]);
    a.__vector__.push(b);
    b.__vector__.push(a);
    const c = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n)]);
    const d = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 2n)]);
    c.__vector__.push(d);
    d.__vector__.push(c);
    expect(vecEq(a, c)).toBe(true);
  });

  it("equal acyclic vectors compare equal; unequal differ", () => {
    const a = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)]);
    const b = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)]);
    const c = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 3n)]);
    expect(vecEq(a, b)).toBe(true);
    expect(vecEq(a, c)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G4 — equal? REGRESSION: structuralEqual deep + cyclic, routing through Setoids.
// ─────────────────────────────────────────────────────────────────────────────
describe("G4 equal? regression — structuralEqual", () => {
  it("deep nested structures: true and false", () => {
    const a = list(list(new AExact(CONSTANT_CTX, 1n)), new AString(CONSTANT_CTX, "k"), new AVector(CONSTANT_CTX, [new ABool(CONSTANT_CTX, true)]));
    const b = list(list(new AExact(CONSTANT_CTX, 1n)), new AString(CONSTANT_CTX, "k"), new AVector(CONSTANT_CTX, [new ABool(CONSTANT_CTX, true)]));
    const c = list(list(new AExact(CONSTANT_CTX, 1n)), new AString(CONSTANT_CTX, "k"), new AVector(CONSTANT_CTX, [new ABool(CONSTANT_CTX, false)]));
    expect(structuralEqual(a, b)).toBe(true);
    expect(structuralEqual(a, c)).toBe(false);
  });

  it("cyclic list via structuralEqual terminates", () => {
    const a = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), nil);
    a.cdr = a;
    const b = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), nil);
    b.cdr = b;
    expect(structuralEqual(a, b)).toBe(true);
    // self-equality on a cyclic list must also terminate (the bridge.ts war story)
    expect(structuralEqual(a, a)).toBe(true);
  });

  it("cyclic vector via structuralEqual terminates", () => {
    const a = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n)]);
    a.__vector__.push(a);
    const b = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n)]);
    b.__vector__.push(b);
    expect(structuralEqual(a, b)).toBe(true);
  });

  it("Pair & Vector now route through their own Setoid (sanity)", () => {
    expect(typeof (new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), nil) as unknown as Record<string, unknown>)[EQ]).toBe("function");
    expect(typeof (new AVector(CONSTANT_CTX, []) as unknown as Record<string, unknown>)[EQ]).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G5 — eq?/eqv? LANDMINE: these stay identity/scalar. structuralEqual is structural.
// ─────────────────────────────────────────────────────────────────────────────
describe("G5 eq?/eqv? landmine — must stay identity/scalar", () => {
  it("eq?/eqv? on distinct equal lists is #f; equal? is #t", () => {
    expect(eq(list(new AExact(CONSTANT_CTX, 1n)), list(new AExact(CONSTANT_CTX, 1n)))).toBe(false);
    expect(eqv(list(new AExact(CONSTANT_CTX, 1n)), list(new AExact(CONSTANT_CTX, 1n)))).toBe(false);
    expect(structuralEqual(list(new AExact(CONSTANT_CTX, 1n)), list(new AExact(CONSTANT_CTX, 1n)))).toBe(true);
  });

  it("eqv? exact vs inexact #f; exact vs exact #t", () => {
    expect(eqv(new AExact(CONSTANT_CTX, 1n), new AInexact(CONSTANT_CTX, 1))).toBe(false);
    expect(eqv(new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 1n))).toBe(true);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// G6 — EQUALITY-SUITE CLEANUP (tagless-final wave). Two changes under test:
//   (1) the duplicate op-helpers `eqv` is collapsed onto the canonical
//       structural-equal `eqv` (= `eq`); env/lists' memv/assv now use the
//       canonical semantics, fixing the latent symbol/nil divergence.
//   (2) eq()'s scalar cases route THROUGH each term's arrival/tagless-final/equals Setoid
//       (de-dup of the per-scalar compare) — with the SchemeBool boundary pinned.
//
// Interning note (verified): SchemeSymbol interns by default, so two bare
// `new SchemeSymbol("a")` calls are `===` (same heap instance). The op-helpers
// vs canonical divergence is therefore LATENT for interned symbols (the `===`
// fast-path masks it). It MANIFESTS only for distinct-instance symbols of the
// same name — which is exactly what a provenance clone is
// (`sym.withProvenance(p)` mints an UNINTERNED copy). The memv/assv tests below
// build that distinct instance to make the divergence real.
// ─────────────────────────────────────────────────────────────────────────────
describe("G6 equality-suite cleanup", () => {
  // A distinct-instance symbol of the same name (uninterned provenance clone).
  const distinctSym = (name: string): ASymbol =>
    new ASymbol(CONSTANT_CTX, name).withProvenance(new Set([1]));

  describe("eqv? over scalars (canonical structural-equal)", () => {
    it("exact ≡ exact (same value) → true", () => {
      expect(eqv(new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 1n))).toBe(true);
    });
    it("exact vs inexact → false (exactness distinguishes)", () => {
      expect(eqv(new AExact(CONSTANT_CTX, 1n), new AInexact(CONSTANT_CTX, 1))).toBe(false);
    });
    it("char same/diff", () => {
      expect(eqv(new ACharacter(CONSTANT_CTX, "a"), new ACharacter(CONSTANT_CTX, "a"))).toBe(true);
      expect(eqv(new ACharacter(CONSTANT_CTX, "a"), new ACharacter(CONSTANT_CTX, "b"))).toBe(false);
    });
    it("bool same/diff", () => {
      expect(eqv(new ABool(CONSTANT_CTX, true), new ABool(CONSTANT_CTX, true))).toBe(true);
      expect(eqv(new ABool(CONSTANT_CTX, true), new ABool(CONSTANT_CTX, false))).toBe(false);
    });
    it("two DISTINCT-instance symbols of the same name → true", () => {
      const a = distinctSym("a");
      const b = distinctSym("a");
      expect(a).not.toBe(b); // genuinely distinct heap instances
      expect(eqv(a, b)).toBe(true);
    });
    it("two Nil → true", () => {
      expect(eqv(nil, nil)).toBe(true);
      // a provenance clone of nil is still eqv?
      expect(eqv(nil, nil.withProvenance(new Set([1])))).toBe(true);
    });
  });

  describe("eq()/eqv() scalar result == the term's own Setoid", () => {
    const EQM = (x: AValue, y: unknown): boolean =>
      (x as unknown as { ["arrival/tagless-final/equals"](o: unknown): boolean })[EQ](y);
    const pairs: { name: string; x: AValue; y: AValue }[] = [
      { name: "exact==exact", x: new AExact(CONSTANT_CTX, 1n), y: new AExact(CONSTANT_CTX, 1n) },
      { name: "exact!=exact", x: new AExact(CONSTANT_CTX, 1n), y: new AExact(CONSTANT_CTX, 2n) },
      { name: "inexact==inexact", x: new AInexact(CONSTANT_CTX, 1.5), y: new AInexact(CONSTANT_CTX, 1.5) },
      { name: "char==char", x: new ACharacter(CONSTANT_CTX, "a"), y: new ACharacter(CONSTANT_CTX, "a") },
      { name: "char!=char", x: new ACharacter(CONSTANT_CTX, "a"), y: new ACharacter(CONSTANT_CTX, "b") },
      { name: "bool==bool", x: new ABool(CONSTANT_CTX, true), y: new ABool(CONSTANT_CTX, true) },
      { name: "bool!=bool", x: new ABool(CONSTANT_CTX, true), y: new ABool(CONSTANT_CTX, false) },
      { name: "sym==sym(distinct)", x: distinctSym("a"), y: distinctSym("a") },
      { name: "nil==nil", x: nil, y: nil.withProvenance(new Set([1])) },
    ];
    for (const { name, x, y } of pairs) {
      it(name + ": eq() routes identically to the Setoid", () => {
        expect(eq(x, y)).toBe(EQM(x, y));
        expect(eqv(x, y)).toBe(EQM(x, y));
      });
    }
  });

  describe("memv/assv consistency with eqv? on distinct-instance symbols/nil", () => {
    // memv('a, (b a c)) finds the 'a — matches eqv?. With the op-helpers eqv this
    // is RED for a distinct-instance 'a (no SchemeSymbol case → #f).
    it("memv finds a distinct-instance symbol of the same name", () => {
      const needle = distinctSym("a");
      const lst = list(new ASymbol(CONSTANT_CTX, "b"), new ASymbol(CONSTANT_CTX, "a"), new ASymbol(CONSTANT_CTX, "c"));
      const found = LIST_OPS.memv(needle, lst);
      expect(found).not.toBe(false);
      expect((found as APair).car).toBeInstanceOf(ASymbol);
      expect(((found as APair).car as ASymbol).__name__).toBe("a");
    });

    it("memv finds a distinct-instance nil", () => {
      const needle = nil.withProvenance(new Set([1]));
      const lst = list(new ASymbol(CONSTANT_CTX, "x"), nil);
      const found = LIST_OPS.memv(needle, lst);
      expect(found).not.toBe(false);
      expect((found as APair).car).toBeInstanceOf(ANil);
    });

    it("assv finds a distinct-instance symbol key of the same name", () => {
      const needle = distinctSym("k");
      const alist = list(
        new APair(CONSTANT_CTX, new ASymbol(CONSTANT_CTX, "j"), new AExact(CONSTANT_CTX, 1n)),
        new APair(CONSTANT_CTX, new ASymbol(CONSTANT_CTX, "k"), new AExact(CONSTANT_CTX, 2n)),
      );
      const found = LIST_OPS.assv(needle, alist);
      expect(found).not.toBe(false);
      expect(((found as APair).car as ASymbol).__name__).toBe("k");
      expect(((found as APair).cdr as AExact).valueOf()).toBe(2);
    });

    // Numeric eqv? path (interned-symbol-independent): assv still matches numbers.
    it("memv matches distinct-instance exact numbers (eqv? numeric path)", () => {
      const needle = new AExact(CONSTANT_CTX, 2n);
      const lst = list(new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n));
      const found = LIST_OPS.memv(needle, lst);
      expect(found).not.toBe(false);
      expect(((found as APair).car as AExact).valueOf()).toBe(2);
    });
  });

  describe("G5 reaffirm — eq/eqv stay pointer-grade on Pairs (NOT deep)", () => {
    it("distinct equal Pairs: eq/eqv #f, equal? #t", () => {
      const a = list(new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)) as APair;
      const b = list(new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)) as APair;
      expect(eq(a, b)).toBe(false);
      expect(eqv(a, b)).toBe(false);
      expect(structuralEqual(a, b)).toBe(true);
    });
  });

  describe("LANDMINE pin — eq?/eqv? scalar boundary must NOT widen", () => {
    // SchemeBool's Setoid is representation-BLIND: it also matches a RAW JS boolean
    // (`this.value === other`). eq?/eqv? must NOT inherit that — a raw JS boolean
    // is not eq? to a boxed SchemeBool. raw booleans DO flow as scheme values
    // (membrane.fromJS(true) === true), so this boundary is reachable. This test
    // pins eq()'s SchemeBool case so a naive route-through-Setoid (which would
    // flip #f→#t here) is caught.
    it("eq?/eqv? of a boxed SchemeBool vs a raw JS boolean is #f", () => {
      expect(eq(new ABool(CONSTANT_CTX, true), true as unknown as never)).toBe(false);
      expect(eqv(new ABool(CONSTANT_CTX, true), true as unknown as never)).toBe(false);
      // but the Setoid itself IS representation-blind (documents the divergence):
      expect(
        (new ABool(CONSTANT_CTX, true) as unknown as { ["arrival/tagless-final/equals"](o: unknown): boolean })[EQ](true),
      ).toBe(true);
    });
  });
});
