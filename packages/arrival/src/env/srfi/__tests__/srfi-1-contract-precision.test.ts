// srfi-1-contract-precision.test.ts — HARVEST-signature precision for srfi-1's Contract-bearing
// ops, read off the REAL exported pack symbols (not a synthetic def). This is the `signatureOf`
// (`.d.ts` harvest STRING) axis — the `Contract.type` author-assertion override — NOT the runtime
// `.safeParse` axis the r7rs `*-contract-precision.test.ts` files prove. Mirrors the shape of
// schema-to-ts.test.ts's "honors an author-asserted `type` override" proof.
//
// `find` decodes its predicate arg off `z.custom<(...args)=>unknown>()`, which zod-to-ts cannot
// represent → `signatureOf` falls to its total-harvest degrade path `(...args: unknown[]) => unknown`,
// losing arity, the arg names, AND the honest `z.union([z.pair, z.nil])` = `List<unknown>` receiver
// type. The author-asserted `type` recovers all three. It is honest by eye: `findImpl` typechecks
// its receiver to `["pair","nil"]` (list-only — NOT representation-agnostic like map/filter/sort), so
// `List<unknown>` is the true input domain, and the matched car / nil result is any scheme value.
//
// `filter` (also z.custom-degraded) is DELIBERATELY left un-overridden: it is one of the closed
// tagless-algebra ops (map/filter/reduce/length) whose canonical generic List-AND-vector type is
// hand-declared in `type-layer/carriers.ts` ("the closed tagless algebra zod cannot express"). A
// flat single-line `type:` string would be a strictly-inferior competing source of truth for a name
// carriers.ts already owns — so filter's degrade path is expected and handled one layer up.
import { describe, expect, it } from "vitest";
import srfi1 from "../srfi-1.js";
import type { AEntity } from "../../../common/symbol.js";
import { signatureOf } from "../../../type-layer/schema-to-ts.js";

const symbols = srfi1.spec.symbols as Record<string, AEntity>;
function def(name: string): AEntity {
  const d = symbols[name];
  if (d === undefined) throw new Error(`srfi-1 pack: no symbol named ${name}`);
  return d;
}

describe("scheme/srfi-1 Contract harvest precision — author-asserted `type:` replaces the z.custom degrade path", () => {
  it("find: recovers arity + arg names + the List receiver the z.custom predicate arg collapsed to (...args: unknown[]) => unknown", () => {
    expect(signatureOf(def("find"))).toBe("(pred: (x: unknown) => unknown, list: List<unknown>) => unknown");
  });

  it("filter: left un-overridden BY DESIGN — carriers.ts owns the tagless-algebra type; signatureOf stays on its degrade path", () => {
    expect(signatureOf(def("filter"))).toBe("(...args: unknown[]) => unknown");
  });
});
