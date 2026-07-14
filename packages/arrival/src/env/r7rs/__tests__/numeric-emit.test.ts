// numeric-emit.test.ts — Contract.emit on quotient/modulo/= and +/-/*// (the Phase-2
// relocation drill, constitution §9 —
// docs/working-proposals/arrival-ts-transpiler-design.md): proves the rule logic
// relocated from the compiler-side phase1 table onto these Contracts builds the exact
// residual-lite shapes the table rule used to build, by calling `emit.call` directly
// against a synthetic EmitCtx. No compiler package, no oracle session, no
// `typescript` import — matching this whole subpath's own typescript-free discipline
// (§4.5).
//
// Byte-parity with the PRE-relocation compiler-side rule is proven on the mercury
// side (inhuman/foundations/arrival-mercury): the differential oracle's bug-cell rows
// (quotient-neg, modulo-neg, exact-vs-inexact-eq — arithmetic has no dedicated row of
// its own; `+`/`-`/`*`/`/` are already exercised pervasively across the existing
// corpus) and the cross-pass/gate3 goldens exercise these through the REAL harvest +
// walker + render pipeline, unchanged. This file proves the narrower,
// arrival-core-owned claim: the Contract's own `emit` field is wired, and its `call`
// builds the expected tree in isolation from the compiler.
import { describe, expect, it } from "vitest";

import type { AEntity } from "../../../common/symbol.js";
import type { EmitCtx } from "../../../emit/emit-rule.js";
import { Bin, Binding, Lit, Method, Ref, Un, type R } from "../../../emit/residual-lite.js";
import numericPack from "../numeric.js";

const symbols = numericPack.spec.symbols as Record<string, AEntity>;

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`numeric pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`numeric pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

/** A synthetic EmitCtx — no namer, no runtime module, no register bias (`register`
 *  only matters to rules that branch on the read/run split; none of quotient/modulo/=
 *  do). `door` throws — the SAME observable contract a real `ctx.door` has (a typed
 *  refusal, never a silent miss), so a mis-arity call is assertable via `toThrow`. */
function testCtx(): EmitCtx<R> {
  return {
    argFacts: [],
    config: { register: "run" },
    fresh: () => {
      throw new Error("testCtx: fresh() not expected — quotient/modulo/= never mint a hygienic temp");
    },
    runtime: (name) => {
      throw new Error(`testCtx: runtime(${name}) not expected — quotient/modulo/= never emit a RuntimeRef`);
    },
    door: (reason) => {
      throw new Error(reason);
    },
  };
}

const ref = (name: string): R => Ref(Binding(name));

describe("numeric Contract.emit — the Phase-2 relocation drill (quotient/modulo/=)", () => {
  it("quotient: the Contract carries the emit rule; call builds Math.trunc(a / b)", () => {
    const def = nativeDef("quotient");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined(); // not a Law-N narrowing leaf
    const [a, b] = [ref("a"), ref("b")];
    const residual = def.emit!.call([a, b], testCtx());
    expect(residual).toEqual(Method(Ref(Binding("Math")), "trunc", [Bin("/", a, b)]));
  });

  it("quotient: a mis-arity call doors (totality — never a silent miscompile)", () => {
    const def = nativeDef("quotient");
    expect(() => def.emit!.call([ref("a")], testCtx())).toThrow(/wants exactly 2 arguments/);
    expect(() => def.emit!.call([ref("a"), ref("b"), ref("c")], testCtx())).toThrow(/wants exactly 2 arguments/);
  });

  it("modulo: the Contract carries the emit rule; call builds ((a % n) + n) % n", () => {
    const def = nativeDef("modulo");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined();
    const [a, n] = [ref("a"), ref("n")];
    const residual = def.emit!.call([a, n], testCtx());
    expect(residual).toEqual(Bin("%", Bin("+", Bin("%", a, n), n), n));
  });

  it("modulo: a mis-arity call doors", () => {
    const def = nativeDef("modulo");
    expect(() => def.emit!.call([ref("a")], testCtx())).toThrow(/wants exactly 2 arguments/);
  });

  it("= : the Contract carries the emit rule; 2-ary builds one Bin(===)", () => {
    const def = nativeDef("=");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined(); // a value comparison narrows no type — not Law-N flagged
    const [a, b] = [ref("a"), ref("b")];
    expect(def.emit!.call([a, b], testCtx())).toEqual(Bin("===", a, b));
  });

  it("= : n-ary chains && over pairwise ===, natively correct under §7's one-number law", () => {
    const def = nativeDef("=");
    const [a, b, c] = [ref("a"), ref("b"), ref("c")];
    expect(def.emit!.call([a, b, c], testCtx())).toEqual(Bin("&&", Bin("===", a, b), Bin("===", b, c)));
  });

  it("= : a 0/1-ary call is vacuously true (R7RS degenerate case), never a door", () => {
    const def = nativeDef("=");
    expect(def.emit!.call([], testCtx())).toEqual(Lit(true));
    expect(def.emit!.call([ref("a")], testCtx())).toEqual(Lit(true));
  });
});

describe("numeric Contract.emit — the Phase-2 relocation drill (+ - * /)", () => {
  it("+ : (+) → 0, (+ a) → a bare (no operator node), (+ a b c) → flat left fold", () => {
    const def = nativeDef("+");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined();
    const [a, b, c] = [ref("a"), ref("b"), ref("c")];
    expect(def.emit!.call([], testCtx())).toEqual(Lit(0));
    expect(def.emit!.call([a], testCtx())).toEqual(a);
    expect(def.emit!.call([a, b, c], testCtx())).toEqual(Bin("+", Bin("+", a, b), c));
  });

  it("* : (*) → 1, (* a) → a bare, (* a b) → Bin(*)", () => {
    const def = nativeDef("*");
    expect(def.emit).toBeDefined();
    const [a, b] = [ref("a"), ref("b")];
    expect(def.emit!.call([], testCtx())).toEqual(Lit(1));
    expect(def.emit!.call([a], testCtx())).toEqual(a);
    expect(def.emit!.call([a, b], testCtx())).toEqual(Bin("*", a, b));
  });

  it("- : unary negates (Un), n-ary left-folds, nullary doors", () => {
    const def = nativeDef("-");
    expect(def.emit).toBeDefined();
    const [a, b, c] = [ref("a"), ref("b"), ref("c")];
    expect(def.emit!.call([a], testCtx())).toEqual(Un("-", a));
    expect(def.emit!.call([a, b, c], testCtx())).toEqual(Bin("-", Bin("-", a, b), c));
    expect(() => def.emit!.call([], testCtx())).toThrow(/wants at least 1 argument/);
  });

  it("/ : unary is the R7RS reciprocal (1 / x), n-ary left-folds, nullary doors", () => {
    const def = nativeDef("/");
    expect(def.emit).toBeDefined();
    const [a, b] = [ref("a"), ref("b")];
    expect(def.emit!.call([a], testCtx())).toEqual(Bin("/", Lit(1), a));
    expect(def.emit!.call([a, b], testCtx())).toEqual(Bin("/", a, b));
    expect(() => def.emit!.call([], testCtx())).toThrow(/wants at least 1 argument/);
  });
});
