// kwargs-runtime.test.ts — RED-then-GREEN spec for wiring `z.kwargs` runtime execution
// into arrival core (V's directive: reverse G8 — `z.kwargs` stops being TYPE-LAYER-only
// and works IN SCHEME at runtime, wired directly into `_bake.ts`'s shared machinery).
//
// THE READER/RESOLVER FINDING (established before writing this spec, so the runtime
// representation is honest, not guessed):
//   • the READER does NOT special-case `:` at all — `:a` lexes as a plain SYMBOL atom via
//     Lexer.ts's generic `_symbol_rules` (no keyword token class exists).
//   • a `:`-prefixed symbol is SELF-EVALUATING (keyword-tagless-apply.md): `Resolver.resolve`/
//     `env_get` (eval/Resolver.ts) return the `ASymbol` itself, no synthesized accessor.
//   • so by the time a call's ARGS reach a rosetta `run` wrapper, `(tool :a "x" :b 5)` has
//     ALREADY evaluated to `[:a, AString("x"), :b, AExact(5)]` (real `ASymbol`s) — the EXACT
//     interleaved shape the existing `dict` native op already folds into `{a:…, b:…}`
//     (env/polyglot.ts). A kwargs rosetta reuses that SAME fold, just landing on a
//     validated+decoded object instead of a raw dict.
//
// Two planes, mirroring symbol.test.ts / capability-rosetta-symbol.test.ts's convention:
//   • UNIT (direct `def.run(...)`) — proves the decode membrane in isolation, manually
//     constructing the keyword symbols (no evaluator needed).
//   • INTEGRATION (`exec` over a real capability-assembled env) — proves the SCHEME-LEVEL
//     call `(tool :a v :b v2)` reaches the impl as one decoded object, end to end.

import { describe, expect, it, beforeAll } from "vitest";
import type { ResolvingEnvironment } from "../../Environment.js";
import { exec, execState } from "../../eval/generator-exec.js";
import { freshEnv } from "../../__tests__/_fresh-env.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { symbol, testCallCtx } from "../symbol.js";
import * as z from "../scheme-zod.js";
import { EnvCapability } from "../capability.js";

/** Build a keyword `ASymbol` exactly as evaluating `:key` now does (self-evaluating —
 *  keyword-tagless-apply.md), for the UNIT plane (no evaluator round trip). */
function pluck(key: string): unknown {
  return new ASymbol(CONSTANT_CTX, `:${key}`);
}

describe("z.kwargs runtime — UNIT (direct def.run, manually-built pluck pairs)", () => {
  // INVARIANT: interleaved :key/value pairs decode into one constructed object argument.
  it("decodes interleaved :key/value pairs into ONE constructed object arg", async () => {
    const def = symbol.rosetta`greet: kwargs greeting`(
      { input: [], inputRest: { a: z.string, b: z.number.optional() }, output: [z.string] },
      (args) => `${args.a}:${args.b}`,
    );
    const out = await def.run.call(
      testCallCtx(),
      pluck("a"),
      new AString(CONSTANT_CTX, "Ada"),
      pluck("b"),
      new AExact(CONSTANT_CTX, 5n),
    );
    expect((out as AString)["arrival/toJS"]()).toBe("Ada:5");
  });

  // INVARIANT: keyword pair order at the call site is independent of the shape's declared field
  // order.
  it("keyword ORDER is independent of the shape's declared order", async () => {
    const def = symbol.rosetta`greet: kwargs greeting`(
      { input: [], inputRest: { a: z.string, b: z.number.optional() }, output: [z.string] },
      (args) => `${args.a}:${args.b}`,
    );
    const out = await def.run.call(
      testCallCtx(),
      pluck("b"),
      new AExact(CONSTANT_CTX, 5n),
      pluck("a"),
      new AString(CONSTANT_CTX, "Ada"),
    );
    // NOTE: pairs must stay `:key value` (key first) — this call shows the TWO PAIRS in
    // swapped ORDER (the `:b` pair before the `:a` pair), not a swapped key/value.
    expect((out as AString)["arrival/toJS"]()).toBe("Ada:5");
  });
});

describe("z.kwargs runtime — INTEGRATION ((tool :k v …) through a real env + exec)", () => {
  let env: ResolvingEnvironment;
  beforeAll(async () => {
    env = await freshEnv();
    const greet = symbol.rosetta`greet: kwargs greeting`(
      { input: [], inputRest: { a: z.string, b: z.number.optional() }, output: [z.string] },
      (args) => `${args.a}:${args.b}`,
    );
    // Wired through the REAL EnvCapability binder (post-B2 binder cut: the "rosetta" kind
    // binds an ARosettaProcedure, not a bare fn) rather than a raw `env.set(name, def.run)`
    // bare-fn bypass — the ledger's "bare-fn env.set harness wiring" row (replacedBy:
    // "EnvCapability-wired fixtures") retires with this fixture.
    await new EnvCapability("test/kwargs-runtime", { symbols: { "kw-greet": greet } }).lower({}).apply(
      env,
      undefined as never,
    );
  });

  // INVARIANT: a real scheme `(tool :a v :b v2)` call invokes the impl with the constructed
  // {a,b} object.
  it("(tool :a v :b v2) invokes the impl with the constructed {a,b} object", async () => {
    // execState (COMPLEX tier): calls the `arrival/toJS` protocol method directly —
    // a boxed-state concern (RULINGS.md R1).
    const [out] = (await execState(`(kw-greet :a "Ada" :b 5)`, { env })).values;
    expect((out as AString)["arrival/toJS"]()).toBe("Ada:5");
  });

  // INVARIANT: keyword order at the call site is independent of declared order, through real
  // exec.
  it("keyword ORDER at the call site is independent of the shape's declared order", async () => {
    const [out] = (await execState(`(kw-greet :b 5 :a "Ada")`, { env })).values;
    expect((out as AString)["arrival/toJS"]()).toBe("Ada:5");
  });

  // INVARIANT: an optional kwarg omitted leaves it undefined with no decode failure.
  it("an optional kwarg omitted leaves it undefined, no decode failure", async () => {
    const [out] = (await execState(`(kw-greet :a "Ada")`, { env })).values;
    expect((out as AString)["arrival/toJS"]()).toBe("Ada:undefined");
  });

  it("a required kwarg missing DOORS cleanly — a per-FIELD validation error (path incl. \"a\"), not the " +
    "pre-fix cryptic \"expected object, received array\" mismatch", async () => {
    // Verified pre-fix (RED): the thrown ZodError's message was `"expected object, received array"`
    // (the WHOLE args array failing the object schema, no field-level detail — decoding an array
    // against an object schema). Post-fix it's a real per-field issue naming the missing key.
    await expect(exec(`(kw-greet)`, { env })).rejects.toThrow(/"a"/);
  });
});
