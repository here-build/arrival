// srfi-95-contract-precision.test.ts — HARVEST-signature precision for srfi-95's `sort` (the
// `Contract.type` author-assertion axis; see srfi-1-contract-precision.test.ts's header). `sort`'s
// optional comparator is `z.custom<(a,b)=>unknown>().optional()`, unrepresentable to zod-to-ts, so
// `signatureOf` collapses the whole op to the degrade path `(...args: unknown[]) => unknown` — hiding
// the arity and the comparator's binary-callable shape. The author-asserted `type` recovers them.
//
// It deliberately keeps `seq` and the return as `unknown`: `sort` is representation-agnostic
// (list→list, vector→vector via the receiver's own `arrival/tagless-final/sort`), so committing the
// receiver/return to `List` would be a false narrowing (unlike find, whose input schema IS list-only).
// The comparator type mirrors AValue.ts's own declared `(a: unknown, b: unknown) => unknown` for the
// sort protocol — the override states that documented shape, not an invention.
import { describe, expect, it } from "vitest";
import srfi95 from "../srfi-95.js";
import type { AEntity } from "../../../common/symbol.js";
import { signatureOf } from "../../../type-layer/schema-to-ts.js";

const symbols = srfi95.spec.symbols as Record<string, AEntity>;
function def(name: string): AEntity {
  const d = symbols[name];
  if (d === undefined) throw new Error(`srfi-95 pack: no symbol named ${name}`);
  return d;
}

describe("scheme/srfi-95 Contract harvest precision — author-asserted `type:` replaces the z.custom degrade path", () => {
  // INVARIANT: sort's harvested signature recovers arity and the optional binary
  // comparator while keeping seq/return representation-blind via override (pins
  // implementation, not behavior)
  it("sort: recovers arity + the optional binary comparator, keeping the receiver/return representation-blind (unknown)", () => {
    expect(signatureOf(def("sort"))).toBe("(seq: unknown, less?: (a: unknown, b: unknown) => unknown) => unknown");
  });
});
