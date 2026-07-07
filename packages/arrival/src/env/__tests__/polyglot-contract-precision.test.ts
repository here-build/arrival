// polyglot-contract-precision.test.ts — RUNTIME proof that the type-precision fixes to
// scheme/polyglot's native Contracts (env/polyglot.ts) actually tighten `def.out` for the
// REAL exported symbols (not a synthetic mirror — see the sibling `polyglot.test-d.ts` for
// the type-level mechanism proofs, which must stay synthetic because `NativeSymbolDef.in`/
// `.out` erase to plain `z.ZodTypeAny` on any real export — same reasoning as
// `numeric.test-d.ts` / `numeric-contract-precision.test.ts`, this pair's own precedent).
//
// `@?` (hasMember) / `@keys` (memberKeys) / `dict` all declared `output: [z.unknown()]`,
// silently accepting ANY encoded value. This file checks: does `def.out` now REJECT a
// wrongly-shaped value it used to silently ACCEPT? That rejection is the fix's entire
// externally visible effect — native ops never run this validation during evaluation (see
// `_bake.ts`'s `bakeNative` doc comment: "NO runtime validation, NO codec — the impl works
// on scheme values directly"), so this is a HARVEST/type-surface proof, not a behavior
// change. The behavioral byte-identical proof is the pre-existing `polyglot.test.ts` suite,
// run unmodified before/after.
//
// ★NOT COVERED HERE: `@` (readMember)'s fix (`z.unknown()` → `z.value`) has NO
// runtime-observable counterpart. `z.value` is `z.custom<SchemeValue>()` with NO refinement
// predicate (see scheme-zod.ts's own doc comment on `value`), so it accepts anything at
// runtime — byte-identical to `z.unknown()`. That fix is a pure static-inference
// improvement; it cannot RED/GREEN via `.safeParse`/`.safeEncode` no matter the schema
// choice, since both schemas validate identically. Its only proof surface is the
// type-level mechanism proof in `polyglot.test-d.ts` (which is itself unfalsifiable against
// THIS file's real export, for the erasure reason above) — see the audit report for the
// honest accounting of what is and isn't mechanically provable for that one symbol.

import { describe, expect, it } from "vitest";
import polyglot from "../polyglot.js";
import type { AEntity } from "../../common/symbol.js";
import { ADict } from "../../values/primitives/ADict.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";

// `symbols` is a builder (activation) => Record<string, AEntity> for this capability —
// call it with an empty (unused) activation shape; polyglot's symbols builder never reads
// `this.configuration`/`this.resources` (no config/resources declared on this capability).
const symbolsSpec = polyglot.spec.symbols;
const symbols = (
  typeof symbolsSpec === "function" ? symbolsSpec({ configuration: {}, resources: {} } as never) : (symbolsSpec ?? {})
) as Record<string, AEntity>;

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`polyglot pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`polyglot pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

describe("scheme/polyglot Contract precision — the real exported ops reject wrongly-typed output (were z.unknown(), now precise)", () => {
  it("@? (hasMember): output is now the z.boolean codec — accepts a real boolean, rejects a non-boolean", () => {
    const def = nativeDef("@?");
    expect(def.out.safeEncode([true]).success).toBe(true);
    expect(def.out.safeEncode([false]).success).toBe(true);
    expect(def.out.safeEncode(["not a boolean"]).success).toBe(false);
    expect(def.out.safeEncode([42]).success).toBe(false);
  });

  it("@keys (memberKeys): output is now z.array(z.string) — accepts a string array, rejects a non-string element", () => {
    const def = nativeDef("@keys");
    expect(def.out.safeEncode([["a", "b", "c"]]).success).toBe(true);
    expect(def.out.safeEncode([[]]).success).toBe(true);
    expect(def.out.safeEncode([[1, 2]]).success).toBe(false);
    expect(def.out.safeEncode([["a", 2]]).success).toBe(false);
  });

  it("dict: output is an ADict-instance schema (native-dict-provenance.md) — accepts an ADict, rejects a plain object", () => {
    const def = nativeDef("dict");
    // `z.dict` is `z.instanceof(ADict)` — a non-codec schema (both faces are ADict itself,
    // matching `pair = z.instanceof(APair)`), so `.safeParse`/`.safeEncode` behave
    // identically here; `.safeParse` is the simpler read.
    expect(def.out.safeParse([new ADict(CONSTANT_CTX, [])]).success).toBe(true);
    expect(def.out.safeParse([{ a: 1, b: "two" }]).success).toBe(false);
    expect(def.out.safeParse([{}]).success).toBe(false);
    expect(def.out.safeParse([["not", "a", "dict"]]).success).toBe(false);
    expect(def.out.safeParse(["just a string"]).success).toBe(false);
    expect(def.out.safeParse([42]).success).toBe(false);
  });
});
