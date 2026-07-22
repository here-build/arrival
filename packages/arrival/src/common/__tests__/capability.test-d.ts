// capability — TYPE-LEVEL PROOF that SymbolDeclaration (the raw authoring-time union a
// capability author writes in `symbols: {}`) is its own stable, importable export, distinct
// from `common/symbol.js`'s `AEntity` (the baked, discriminated union AEntity IS a member
// of). The two used to share the identical name `SymbolDef` — a real naming collision this
// proof guards against regressing.
//
// COLLAPSE PIN (Stage-6, 2026-07-22): the bare-`Fn` and untagged `{ value }` arms are
// RETIRED — a data constant authors as `symbol.value` (a baked AEntity kind) and a bare fn
// as an explicit `{ fn }` record (the one surviving legacy arm, McpEnvCapability's authoring
// shape). The negative assertions below keep the retirement from silently regressing.
import { describe, expectTypeOf, test } from "vitest";
import type { SymbolDeclaration } from "../capability.js";
import type { AEntity } from "../symbol.js";

describe("SymbolDeclaration — the raw authoring-time union, post-collapse", () => {
  // INVARIANT: a baked AEntity is assignable to SymbolDeclaration (its own distinct type from
  // symbol.js's AEntity, no name collision).
  test("a baked AEntity is assignable to SymbolDeclaration (the baked arm of the wider union)", () => {
    expectTypeOf<AEntity>().toExtend<SymbolDeclaration>();
  });

  // INVARIANT (retirement pin): an untagged `{ value }` object is NOT assignable — data
  // constants go through `symbol.value` (kind: "value", an AEntity member) instead.
  test("a bare value-binding object is NOT assignable to SymbolDeclaration (retired arm)", () => {
    expectTypeOf<{ value: unknown }>().not.toExtend<SymbolDeclaration>();
  });

  // INVARIANT (retirement pin): a bare function is NOT assignable — callables author as
  // baked symbol.* defs, or as the explicit legacy `{ fn }` record while MCP still rides it.
  test("a bare function is NOT assignable to SymbolDeclaration (retired arm)", () => {
    expectTypeOf<(...args: unknown[]) => unknown>().not.toExtend<SymbolDeclaration>();
  });

  // INVARIANT: the surviving legacy `{ fn }` record stays assignable (the postponed MCP
  // surface authors through it).
  test("an explicit { fn } record is assignable to SymbolDeclaration (the surviving legacy arm)", () => {
    expectTypeOf<{ fn: (...args: unknown[]) => unknown }>().toExtend<SymbolDeclaration>();
  });
});
