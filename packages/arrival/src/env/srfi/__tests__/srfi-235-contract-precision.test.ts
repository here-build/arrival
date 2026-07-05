// srfi-235-contract-precision.test.ts — HARVEST-signature precision for srfi-235's `curry` (the
// `Contract.type` author-assertion axis; see srfi-1-contract-precision.test.ts's header). `curry`'s
// contract is z.custom callable HEAD + `z.value` inputRest + z.custom callable OUTPUT — both z.custom
// callables are unrepresentable to zod-to-ts, so `signatureOf` collapses the whole thing to its
// total-harvest degrade path `(...args: unknown[]) => unknown`, hiding the two facts a caller most
// needs: the first arg is the function being curried, and the RESULT is itself a function of the
// remaining args. The author-asserted `type` restores both. Honest by eye: `curry(fn, ...leading)`
// returns a partially-applied function (utils/functional.ts).
import { describe, expect, it } from "vitest";
import srfi235 from "../srfi-235.js";
import type { AEntity } from "../../../common/symbol.js";
import { signatureOf } from "../../../type-layer/schema-to-ts.js";

const symbols = srfi235.spec.symbols as Record<string, AEntity>;
function def(name: string): AEntity {
  const d = symbols[name];
  if (d === undefined) throw new Error(`srfi-235 pack: no symbol named ${name}`);
  return d;
}

describe("scheme/srfi-235 Contract harvest precision — author-asserted `type:` replaces the z.custom degrade path", () => {
  it("curry: recovers the callable head, the variadic partial args, and the returns-a-function shape", () => {
    expect(signatureOf(def("curry"))).toBe(
      "(fn: (...args: unknown[]) => unknown, ...args: unknown[]) => (...args: unknown[]) => unknown",
    );
  });
});
