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
// `filter` has since received the author-asserted treatment too: a generic overload set
// (guard/non-guard × List/array receivers) declared via `type:` (srfi-1.ts), which the
// harvest prefers over any schema-derived composition — so the pin is the declared
// overload set verbatim.
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
  // INVARIANT: find's harvested signature recovers arity, arg names, and the List<unknown>
  // receiver via Contract.type override (pins implementation, not behavior)
  it("find: recovers arity + arg names + the List receiver the z.custom predicate arg collapsed to (...args: unknown[]) => unknown", () => {
    expect(signatureOf(def("find"))).toBe(`{
  <T, S extends T>(p: (x: T) => x is S, xs: List<T>): S | null;
  <T>(p: (x: T) => unknown, xs: List<T>): T | null;
}`);
  });

  // INVARIANT: filter's author-asserted generic overload set (guard/non-guard ×
  // List/array receivers) harvests verbatim (pins implementation, not behavior)
  it("filter: author-asserted generic overload set harvests verbatim (guard × receiver pairs)", () => {
    expect(signatureOf(def("filter"))).toBe(`{
  <T, S extends T>(p: (x: T) => x is S, xs: List<T>): List<S>;
  <T>(p: (x: T) => unknown, xs: List<T>): List<T>;
  <T, S extends T>(p: (x: T) => x is S, xs: readonly T[]): readonly S[];
  <T>(p: (x: T) => unknown, xs: readonly T[]): readonly T[];
}`);
  });
});
