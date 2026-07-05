// binding-contract-precision.test.ts — HARVEST/type-surface proof for the `scheme/r7rs/binding`
// capability's `Contract.type` override on `call-with-values`. Mirrors the sibling contract-
// precision suites' established pattern, but for the SIGNATURE harvest (`signatureOf`) rather
// than runtime `safeParse`: `call-with-values` declares two `z.custom<SchemeFunction>()` params,
// which are UNREPRESENTABLE to the harvest printer (it throws `Schemas of type "custom" cannot be
// represented in TypeScript`), collapsing the whole signature to the catch-all degrade path
// `(...args: unknown[]) => unknown`. `Contract.type` author-asserts the real shape — same trust
// model + same this-session convention as the sibling srfi curry/find/sort overrides (a callable
// renders as `(...args: unknown[]) => unknown`).
import { describe, expect, it } from "vitest";
import bindingPack from "../binding.js";
import { signatureOf } from "../../../type-layer/schema-to-ts.js";
import type { AEntity } from "../../../common/symbol.js";

const symbols = bindingPack.spec.symbols as Record<string, AEntity>;

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`binding pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`binding pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

describe("scheme/r7rs/binding Contract.type override — the harvest signature for the two-procedure `call-with-values` (its z.custom<SchemeFunction> params are unrepresentable to the printer)", () => {
  it("call-with-values: producer + consumer procedures → whatever the consumer returns", () => {
    expect(signatureOf(nativeDef("call-with-values"))).toBe(
      "(producer: (...args: unknown[]) => unknown, consumer: (...args: unknown[]) => unknown) => unknown",
    );
  });

  it("values: genuinely variadic over any scheme value — left as the honest `(...args: unknown[]) => unknown` (NOT a catch-all degrade; z.array(z.value) renders faithfully), no override added", () => {
    // Regression guard for the LEAVE-ALONE decision: `values` packages 0+ arbitrary scheme values,
    // so its `(...args: unknown[]) => unknown` is honest, not the degrade path — no `type` override.
    const def = nativeDef("values");
    expect("type" in def && def.type !== undefined).toBe(false);
    expect(signatureOf(def)).toBe("(...args: unknown[]) => unknown");
  });
});
