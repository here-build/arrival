// Attestation core-walk suite (design: second-foundation/arrival-manifold/docs/
// attestation-design.md §8 case 10). The registry (values/attestation.ts) is a
// WeakSet keyed by box identity; the bakeRosetta return walk deep-attests SOURCE
// rosetta returns (spine + leaves), the membrane wrappers inherit at the pluck
// site, and computation drops attestation for free (fresh boxes). The manifold's
// boundary/flow behavior is covered in arrival-manifold's attestation-flows suite;
// THIS suite pins the core mechanics those flows stand on.

import { describe, expect, it } from "vitest";

import * as z from "../common/scheme-zod.js";
import { symbol } from "../common/symbol.js";
import { attest, attestDeep, freshIfSingleton, isAttested } from "../values/attestation.js";
import { exec, execState } from "../eval/generator-exec.js";
import { schemeFalse, schemeTrue } from "../values/primitives/ABool.js";
import { AJSArray } from "../values/primitives/AJSArray.js";
import { AJSObject } from "../values/primitives/AJSObject.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import { APair } from "../values/primitives/APair.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AVector } from "../values/primitives/AVector.js";
import { theVoid } from "../values/primitives/AVoid.js";
import { tf } from "../values/tagless-final.js";
import { AListAlike } from "../values/types.js";
import { jsToScheme } from "../rosetta.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { testCallCtx } from "../common/symbol.js";

/** A SOURCE rosetta (default — not pure) returning a fixed JS value; its `run`
 *  called direct-JS (no evaluator ctx) exercises exactly the _bake step-4 walk.
 *  REBASELINE (v1→v2 scheme-zod swap, 4ebe73abbe, 2026-07-08): `z.value` used to be a UNION
 *  of auto-boxing codecs (v1's `value = z.union([number, string, boolean, …])`), so a raw JS
 *  return auto-boxed via whichever union member matched. v2's `value` is a bare
 *  `z.custom(isSchemeValue)` predicate — a real "no automatic transform" escape hatch (see its
 *  doc comment: "the impl receives/returns the raw scheme value and does its own
 *  schemeToJs/jsToScheme"). The impl must now box its own return, exactly like the one real
 *  production consumer of this pattern (env/overridable.ts's `overridable/resolve`, which ends
 *  `return jsToScheme(CONSTANT_CTX, outcome.data)`). */
const source = (impl: () => unknown) =>
  symbol.rosetta`t: test source`({ input: [], output: [z.value] }, () => jsToScheme(CONSTANT_CTX, impl()));

/** A SOURCE rosetta echoing its scheme argument — the identity fast path through
 *  jsToScheme returns the very same box, which the return walk then deep-attests. */
const echo = symbol.rosetta`echo: identity`({ input: [z.value], output: [z.value] }, (v) => v);

describe("attestation registry (attest / isAttested / freshIfSingleton)", () => {
  /** Exempt singletons (nil, void, interned symbols, #t/#f) are never marked attested;
   *  attest() is also a no-op on non-AValue inputs (raw strings, undefined) — never throws. */
  it("refuses the exempt singletons: nil, #void, interned symbols, #t/#f flyweights", async () => {
    expect(isAttested(attest(nil))).toBe(false);
    expect(isAttested(attest(theVoid))).toBe(false);
    expect(isAttested(attest(schemeTrue))).toBe(false);
    expect(isAttested(attest(schemeFalse))).toBe(false);
    // execState (COMPLEX tier): asserts box discipline directly (RULINGS.md R1).
    const [kw] = (await execState("(quote some-symbol)")).values;
    expect(kw).toBeInstanceOf(ASymbol);
    expect(isAttested(attest(kw))).toBe(false);
    // non-AValues are a no-op, never a throw
    expect(isAttested(attest("raw string"))).toBe(false);
    expect(isAttested(attest(undefined))).toBe(false);
  });

  /** freshIfSingleton clones only the #t/#f flyweights; the clone can be attested
   *  independently while the shared singleton itself never becomes attested. Non-singleton
   *  values (e.g. numbers) pass through unchanged (same reference, not cloned). */
  it("freshIfSingleton clones ONLY the #t/#f flyweights; the clone attests, the singleton never does", async () => {
    const fresh = freshIfSingleton(schemeTrue);
    expect(fresh).not.toBe(schemeTrue);
    expect(isAttested(attest(fresh))).toBe(true);
    expect(isAttested(schemeTrue)).toBe(false);
    const [num] = await exec("42");
    expect(freshIfSingleton(num!)).toBe(num);
  });
});

describe("bakeRosetta return walk (stamp site 1)", () => {
  it("attests a scalar return; a boolean return is a fresh attested clone, never the flyweight", async () => {
    expect(isAttested(await source(() => 42).run.call(testCallCtx()))).toBe(true);
    expect(isAttested(await source(() => "hi").run.call(testCallCtx()))).toBe(true);
    const bool = await source(() => true).run.call(testCallCtx());
    expect(isAttested(bool)).toBe(true);
    expect(bool).not.toBe(schemeTrue);
    expect(isAttested(schemeTrue)).toBe(false); // no program-wide leak
  });

  it("a PURE rosetta's return is NOT machine-attested (a transform, not a source)", async () => {
    const pureDef = symbol.rosetta`p: pure transform`(
      { input: [], output: [z.number], provenance: "pipe" },
      () => 42,
    );
    expect(isAttested(await pureDef.run.call(testCallCtx()))).toBe(false);
  });

  it("attests a dict return's wrapper; entries inherit through get, cache-stable", async () => {
    const def = source(() => ({ a: 1, nested: { x: 2 }, tags: [7, 8] }));
    const out = (await def.run.call(testCallCtx())) as AJSObject;
    expect(out).toBeInstanceOf(AJSObject);
    expect(isAttested(out)).toBe(true);

    const a = out.get("a");
    expect(isAttested(a)).toBe(true);
    // cache stability: the same (wrapper, key) pluck is the same box, attested twice over
    expect(out.get("a")).toBe(a);
    expect(isAttested(out.get("a"))).toBe(true);

    const nested = out.get("nested");
    expect(nested).toBeInstanceOf(AJSObject);
    expect(isAttested(nested)).toBe(true);
    expect(isAttested((nested as AJSObject).get("x"))).toBe(true);

    const tags = out.get("tags");
    expect(tags).toBeInstanceOf(AJSArray);
    expect(isAttested(tags)).toBe(true);
    expect(isAttested((tags as AJSArray)[tf("vector-ref")](0))).toBe(true);
  });

  it("a missing key plucks the SHARED nil — never attested", async () => {
    const def = source(() => ({ a: 1 }));
    const out = (await def.run.call(testCallCtx())) as AJSObject;
    const missing = out.get("missing");
    expect(missing).toBeInstanceOf(ANil);
    expect(isAttested(missing)).toBe(false);
  });

  it("AJSArray materialization inherits: every materialized element box is attested", async () => {
    const def = source(() => [1, 2, 3]);
    const out = (await def.run.call(testCallCtx())) as AJSArray;
    expect(out).toBeInstanceOf(AJSArray);
    expect(isAttested(out)).toBe(true);
    for (const el of out.__vector__) expect(isAttested(el)).toBe(true);
  });

  it("attests a pair spine + leaves (car/cdr on a source return are attested STORED boxes)", async () => {
    // execState (COMPLEX tier): `echo.run` is a rosetta expecting a real boxed
    // AValue input (RULINGS.md R1) — `exec`'s plain-JS exit would fail its decode.
    const [pair] = (await execState("'(1 2 3)")).values;
    const out = (await echo.run.call(testCallCtx(), pair)) as APair<any, any>;
    expect(out).toBeInstanceOf(APair);
    expect(isAttested(out)).toBe(true);
    expect(isAttested(out.car)).toBe(true);
    expect(isAttested(out.cdr)).toBe(true);
    expect(isAttested(out.cdr.car)).toBe(true);
  });

  it("attests a vector's stored elements", async () => {
    const [vec] = (await execState("#(1 2)")).values;
    const out = (await echo.run.call(testCallCtx(), vec)) as AVector;
    expect(out).toBeInstanceOf(AVector);
    expect(isAttested(out)).toBe(true);
    for (const el of out.__vector__) expect(isAttested(el)).toBe(true);
  });

  it("an unrelated freshly-evaluated value is NOT attested (computation/literals stay bare)", async () => {
    const [computed] = await exec("(+ 1 2)");
    expect(isAttested(computed)).toBe(false);
    const [literal] = await exec("41");
    expect(isAttested(literal)).toBe(false);
  });
});

describe("attestDeep", () => {
  it("walks a mixed spine and skips the exempt singletons", async () => {
    const [pair] = (await execState("'(1 #(2 3))")).values;
    attestDeep(pair);
    const p = pair as APair<any, APair<AVector, any>>;
    expect(isAttested(p)).toBe(true);
    expect(isAttested(p.car)).toBe(true);
    const inner = p.cdr.car as AVector;
    expect(isAttested(inner)).toBe(true);
    for (const el of inner.__vector__) expect(isAttested(el)).toBe(true);
    // the shared nil list-terminator never enters the registry
    expect(isAttested(nil)).toBe(false);
  });
});
