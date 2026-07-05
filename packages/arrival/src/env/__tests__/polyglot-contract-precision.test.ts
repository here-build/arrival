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
import type { SymbolDef } from "../../common/symbol.js";

// `symbols` is a builder (activation) => Record<string, SymbolDef> for this capability —
// call it with an empty (unused) activation shape; polyglot's symbols builder never reads
// `this.configuration`/`this.resources` (no config/resources declared on this capability).
const symbolsSpec = polyglot.spec.symbols;
const symbols = (
  typeof symbolsSpec === "function" ? symbolsSpec({ configuration: {}, resources: {} } as never) : (symbolsSpec ?? {})
) as Record<string, SymbolDef>;

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

  it("dict: output is now a plain string-keyed record schema — accepts an object, rejects a non-object", () => {
    const def = nativeDef("dict");
    // `.safeEncode` (JS-land → scheme), not `.safeParse` — the record's key schema is the
    // `z.string` CODEC (`AString` ↔ `string`), so a bare `.safeParse` validates keys against
    // the codec's SOURCE side (expects an `AString` instance) and would reject even a
    // genuinely-valid plain-JS-string-keyed object. `.out` is a JS-land value (dict's real
    // return type), so `.safeEncode` is the matching direction — same convention
    // `numeric-contract-precision.test.ts` documents for codec outputs, and the same
    // direction already used for `@?`/`@keys` above.
    expect(def.out.safeEncode([{ a: 1, b: "two" }]).success).toBe(true);
    expect(def.out.safeEncode([{}]).success).toBe(true);
    expect(def.out.safeEncode([["not", "a", "record"]]).success).toBe(false);
    expect(def.out.safeEncode(["just a string"]).success).toBe(false);
    expect(def.out.safeEncode([42]).success).toBe(false);
  });
});
