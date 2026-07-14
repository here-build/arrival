// lists-emit.test.ts — Contract.emit on cons (the Phase-2 relocation drill,
// constitution §9 — docs/working-proposals/arrival-ts-transpiler-design.md): proves
// the rule logic relocated from the compiler-side phase1 table onto cons's own
// Contract builds the exact residual-lite shape the table rule used to build, by
// calling `emit.call` directly against a synthetic EmitCtx. No compiler package, no
// oracle session, no `typescript` import — matching this whole subpath's own
// typescript-free discipline (§4.5). Mirrors numeric-emit.test.ts's own harness
// exactly (same `testCtx`/`nativeDef`/`ref` shape) — see that file for the fuller
// rationale comment.
//
// Byte-parity with the PRE-relocation compiler-side rule is proven on the mercury
// side (inhuman/foundations/arrival-mercury): rules-phase1.test.ts's own
// "cons → [x, ...xs]" golden moved to this file's Contract-level proof once the table
// row was deleted; the cross-pass/gate3 goldens and bug-cell corpus exercise `cons`
// through the REAL harvest + walker + render pipeline, unchanged.
import { describe, expect, it } from "vitest";

import type { AEntity } from "../../../common/symbol.js";
import type { EmitCtx } from "../../../emit/emit-rule.js";
import { ArrayLit, Binding, Ref, Spread, type R } from "../../../emit/residual-lite.js";
import listsPack from "../lists.js";

const symbols = listsPack.spec.symbols as Record<string, AEntity>;

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`lists pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`lists pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

/** A synthetic EmitCtx — no namer, no runtime module, no register bias (`cons` never
 *  branches on register or facts). `door` throws — the SAME observable contract a
 *  real `ctx.door` has (a typed refusal, never a silent miss), so a mis-arity call is
 *  assertable via `toThrow`. */
function testCtx(): EmitCtx<R> {
  return {
    argFacts: [],
    config: { register: "run" },
    fresh: () => {
      throw new Error("testCtx: fresh() not expected — cons never mints a hygienic temp");
    },
    runtime: (name) => {
      throw new Error(`testCtx: runtime(${name}) not expected — cons never emits a RuntimeRef`);
    },
    door: (reason) => {
      throw new Error(reason);
    },
  };
}

const ref = (name: string): R => Ref(Binding(name));

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
