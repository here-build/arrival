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
// `filter` was ALSO z.custom-degraded when this file was authored, and left un-overridden
// (carriers.ts's closed tagless-algebra type was meant to be the one source of truth for it).
// Since then, the uniform-vocabulary migration gave `z.lambda` a real printer image
// (schema-to-ts.ts's IMAGE_BY_NAME) — it no longer THROWS on print, so filter's own
// `[z.lambda, z.value] => [z.value]` contract now composes to a real (non-degraded)
// signature via the normal path, without needing a `type:` override at all.
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

  it("filter: no `type:` override needed anymore — z.lambda's printer image composes a real signature directly", () => {
    expect(signatureOf(def("filter"))).toBe("(a: (...args: unknown[]) => unknown, b: unknown) => unknown");
  });
});
