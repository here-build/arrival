// capability — TYPE-LEVEL PROOF that SymbolDeclaration (the raw, pre-bake authoring-time
// union a capability author writes in `symbols: {}` — a baked AEntity, a bare fn, an inline
// rosetta-shaped object, or a `{ value }` binding) is its own stable, importable export,
// distinct from `common/symbol.js`'s `AEntity` (the baked, discriminated union AEntity IS a
// member of). The two used to share the identical name `SymbolDef` — a real naming collision
// this proof guards against regressing.
import { describe, expectTypeOf, test } from "vitest";
import type { SymbolDeclaration } from "../capability.js";
import type { AEntity } from "../symbol.js";

describe("SymbolDeclaration — the raw pre-bake authoring-time union", () => {
  // INVARIANT: a baked AEntity is assignable to SymbolDeclaration (its own distinct type from
  // symbol.js's AEntity, no name collision).
  test("a baked AEntity is assignable to SymbolDeclaration (the baked arm of the wider union)", () => {
    expectTypeOf<AEntity>().toExtend<SymbolDeclaration>();
  });

  // INVARIANT: a bare `{ value }` binding object is assignable to SymbolDeclaration.
  test("a bare value-binding object is assignable to SymbolDeclaration", () => {
    expectTypeOf<{ value: unknown }>().toExtend<SymbolDeclaration>();
  });

  // INVARIANT: a bare function is assignable to SymbolDeclaration.
  test("a bare function is assignable to SymbolDeclaration", () => {
    expectTypeOf<(...args: unknown[]) => unknown>().toExtend<SymbolDeclaration>();
  });
});
