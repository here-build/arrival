// lists-emit.test.ts — Contract.emit on cons/map/apply (the Phase-2 relocation drill,
// constitution §9 — docs/working-proposals/arrival-ts-transpiler-design.md): proves
// the rule logic relocated from the compiler-side phase1 table onto each symbol's own
// Contract builds the exact residual-lite shape the table rule used to build, by
// calling `emit.call` directly against a synthetic EmitCtx. No compiler package, no
// oracle session, no `typescript` import — matching this whole subpath's own
// typescript-free discipline (§4.5). Mirrors numeric-emit.test.ts's own harness
// exactly (same `testCtx`/`nativeDef`/`ref` shape) — see that file for the fuller
// rationale comment.
//
// Byte-parity with the PRE-relocation compiler-side rule is proven on the mercury
// side (inhuman/foundations/arrival-mercury): rules-phase1.test.ts's own
// "cons → [x, ...xs]" (Wave 2) and "map"/"apply" (Wave 3) goldens moved to this
// file's Contract-level proof once their table rows were deleted; the cross-pass/
// gate3 goldens and bug-cell corpus exercise cons/map/apply through the REAL harvest
// + walker + render pipeline, unchanged.
import { describe, expect, it } from "vitest";

import type { AEntity } from "../../../common/symbol.js";
import type { EmitCtx } from "../../../emit/emit-rule.js";
import { ArrayLit, Arrow, Bin, Binding, Call, Index, Lit, Method, Ref, Spread, type R } from "../../../emit/residual-lite.js";
import listsPack from "../lists.js";

const symbols = listsPack.spec.symbols as Record<string, AEntity>;

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`lists pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`lists pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

/** `map` is declared via `symbol.sequence` (not `symbol.native`) — its own def kind. */
function sequenceDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`lists pack: no symbol named ${name}`);
  if (def.kind !== "sequence") throw new Error(`lists pack: ${name} is not a sequence def (got ${def.kind})`);
  return def;
}

/** A synthetic EmitCtx — no namer, no runtime module, no register bias (`cons` never
 *  branches on register or facts). `door` throws — the SAME observable contract a
 *  real `ctx.door` has (a typed refusal, never a silent miss), so a mis-arity call is
 *  assertable via `toThrow`. `fresh` returns the hint AS the binding text (map/apply's
 *  own rules never inspect what `fresh` returns beyond wrapping it in `Ref`, so the
 *  test's own naming choice is the simplest one that makes assertions legible). */
function testCtx(over: Partial<EmitCtx<R>> = {}): EmitCtx<R> {
  return {
    argFacts: [],
    config: { register: "run" },
    fresh: (hint) => Binding(hint),
    runtime: (name) => {
      throw new Error(`testCtx: runtime(${name}) not expected — cons/map/apply never emit a RuntimeRef`);
    },
    door: (reason) => {
      throw new Error(reason);
    },
    ...over,
  };
}

const ref = (name: string): R => Ref(Binding(name));

/** apply's fold-recognition inspects an ALREADY-LOWERED argument's own `RuntimeRef`
 *  tag — residual-lite carries the ARM (see its own doc comment on the `R` union) but
 *  no constructor, since nothing in arrival core ever MINTS one (only the compiler's
 *  real walker does, when a shim-refPolicy symbol resolves in value position). This
 *  test-local helper builds the shape directly — the same "no constructor exists, so
 *  the test states the raw shape" convention residual-lite's own header documents. */
const runtimeRef = (symbol: string): R => ({ t: "RuntimeRef", symbol }) as R;

describe("lists Contract.emit — the Phase-2 relocation drill (cons)", () => {
  it("cons: the Contract carries the emit rule; call builds [x, ...xs] (the spread golden)", () => {
    const def = nativeDef("cons");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined(); // not a Law-N narrowing leaf
    const [x, xs] = [ref("x"), ref("xs")];
    const residual = def.emit!.call([x, xs], testCtx());
    expect(residual).toEqual(ArrayLit([x, Spread(xs)]));
  });

  it("cons: a mis-arity call doors (totality — never a silent miscompile)", () => {
    const def = nativeDef("cons");
    expect(() => def.emit!.call([ref("x")], testCtx())).toThrow(/wants exactly 2 arguments/);
    expect(() => def.emit!.call([ref("x"), ref("xs"), ref("extra")], testCtx())).toThrow(/wants exactly 2 arguments/);
  });
});

describe("lists Contract.emit — the Phase-2 relocation drill (map — Wave 3)", () => {
  it("map: the Contract carries the emit rule; single-list → xs.map(f) bare", () => {
    const def = sequenceDef("map");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined();
    const [f, xs] = [ref("f"), ref("xs")];
    expect(def.emit!.call([f, xs], testCtx())).toEqual(Method(xs, "map", [f]));
  });

  it("map: multi-list → the index-zip arrow (drives off lists[0])", () => {
    const def = sequenceDef("map");
    const [f, xs, ys] = [ref("f"), ref("xs"), ref("ys")];
    const residual = def.emit!.call([f, xs, ys], testCtx());
    const el = Binding("item");
    const idx = Binding("i");
    expect(residual).toEqual(Method(xs, "map", [Arrow([el, idx], Call(f, [Ref(el), Index(ys, Ref(idx))]))]));
  });

  it("map: three lists zip the same way", () => {
    const def = sequenceDef("map");
    const [f, xs, ys, zs] = [ref("f"), ref("xs"), ref("ys"), ref("zs")];
    const residual = def.emit!.call([f, xs, ys, zs], testCtx());
    const el = Binding("item");
    const idx = Binding("i");
    expect(residual).toEqual(
      Method(xs, "map", [Arrow([el, idx], Call(f, [Ref(el), Index(ys, Ref(idx)), Index(zs, Ref(idx))]))]),
    );
  });

  it("map: a sub-2-argument call doors (totality — never a silent miscompile)", () => {
    const def = sequenceDef("map");
    expect(() => def.emit!.call([ref("f")], testCtx())).toThrow(/wants a function and at least one list/);
  });
});

describe("lists Contract.emit — the Phase-2 relocation drill (apply — Wave 3)", () => {
  it("apply: (apply + xs) → xs.reduce((acc, item) => acc + item, 0) — the fold-recognition bridge", () => {
    const def = nativeDef("apply");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined();
    const xs = ref("xs");
    const residual = def.emit!.call([runtimeRef("+"), xs], testCtx());
    const acc = Binding("acc");
    const item = Binding("item");
    expect(residual).toEqual(Method(xs, "reduce", [Arrow([acc, item], Bin("+", Ref(acc), Ref(item))), Lit(0)]));
  });

  it("apply: (apply * xs) → identity 1", () => {
    const def = nativeDef("apply");
    const xs = ref("xs");
    const residual = def.emit!.call([runtimeRef("*"), xs], testCtx());
    const acc = Binding("acc");
    const item = Binding("item");
    expect(residual).toEqual(Method(xs, "reduce", [Arrow([acc, item], Bin("*", Ref(acc), Ref(item))), Lit(1)]));
  });

  it("apply: (apply f xs) generic → spread f(...xs) (not f.apply(null, xs))", () => {
    const def = nativeDef("apply");
    const [f, xs] = [ref("f"), ref("xs")];
    expect(def.emit!.call([f, xs], testCtx())).toEqual(Call(f, [Spread(xs)]));
  });

  it("apply: leading fixed args compose: (apply f a xs) → f(a, ...xs)", () => {
    const def = nativeDef("apply");
    const [f, a, xs] = [ref("f"), ref("a"), ref("xs")];
    expect(def.emit!.call([f, a, xs], testCtx())).toEqual(Call(f, [a, Spread(xs)]));
  });

  it("apply: a same-shaped but non-RuntimeRef 2-ary call never fires the fold (Law A: keys on the residual's own tag, not a guess)", () => {
    const def = nativeDef("apply");
    const [f, xs] = [ref("f"), ref("xs")];
    expect(def.emit!.call([f, xs], testCtx())).toEqual(Call(f, [Spread(xs)]));
  });

  it("apply: a sub-2-argument call doors (totality — never a silent miscompile)", () => {
    const def = nativeDef("apply");
    expect(() => def.emit!.call([ref("f")], testCtx())).toThrow(/wants a function and a trailing argument list/);
  });
});
