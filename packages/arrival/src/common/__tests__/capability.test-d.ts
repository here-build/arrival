// capability — TYPE-LEVEL PROOF that SymbolDeclaration (the raw authoring-time union a
// capability author writes in `symbols: {}`) is its own stable, importable export, distinct
// from `common/symbol.js`'s `AEntity` (the CONTRACT-data union — riding `.contract`/`.door`
// on a minted value now, no longer a record that travels in `SymbolDeclaration` on its own).
//
// STAGE A2 PIN (2026-07-22): the symbol.* factories mint the runtime A-VALUE directly —
// `native`/`sequence`/`tagless`/`tagless-guard` → `ANativeProcedure`, `rosetta` →
// `ARosettaProcedure`, `door`/`notImplemented` → `DoorProcedure`, `keyword` →
// `AKernelKeyword`, `value` → a boxed `AmbientValue` leaf. `AEntity`'s OTHER members
// (`NativeSymbolDef`, `RosettaSymbolDef`, …) are CONTRACT shapes only now — they no longer
// travel in `SymbolDeclaration` directly, only nested under a minted value's `.contract`/
// `.door`. `symbol.define`/`symbol.defineSyntax`/`symbol.macro` are the surviving two-phase/
// already-Macro-carrying declarative record kinds — unaffected by this stage, still bare
// `AEntity` members that bind directly. The assertions below pin BOTH halves of the split.
//
// COLLAPSE PIN (Stage-6, 2026-07-22): the bare-`Fn` and untagged `{ value }` arms are
// RETIRED — a data constant authors as `symbol.value` (mints a boxed `AmbientValue` now). The
// negative assertions below keep the retirement from silently regressing.
//
// STAGE C CUT 4 PIN (2026-07-23, docs/plans/stage-c-corpse-deletion.md): the legacy `{ fn }`
// record arm is ALSO dropped from the union — `lower()`, its sole BINDER, is retired. Phase B
// (§"bans live at the TYPE level") went further: `isSymbolSpec`/`VocabularyLegacyCapabilityError`
// (the runtime refusal check that used to guard `env/vocabulary.ts`'s bind loop against this
// shape) are DELETED — compat theater for a shape this very type-level pin already rejects.
// An untyped author reaching for `{ fn }` now gets a TS error at the keyboard, never a runtime
// door; this test is that error's proof.
import { describe, expectTypeOf, test } from "vitest";
import type { SymbolDeclaration } from "../capability.js";
import type { DefineSymbolDef, DefineSyntaxSymbolDef, MacroSymbolDef, NativeSymbolDef } from "../symbols/_bake.js";
import { ANativeProcedure, ARosettaProcedure, DoorProcedure } from "../../values/primitives/ACallable.js";
import { AKernelKeyword } from "../../values/AKernelKeyword.js";

describe("SymbolDeclaration — the raw authoring-time union, post Stage-A2 mint", () => {
  // INVARIANT: every symbol.* factory that now mints an A-value directly is assignable to
  // SymbolDeclaration — the whole point of Stage A2 is that these classes ARE what a
  // `symbols` record entry holds, not a `{kind:"native", …}` record describing one.
  test("the minted A-value classes (native/sequence/tagless/tagless-guard/rosetta/door/keyword) are assignable", () => {
    expectTypeOf<ANativeProcedure>().toExtend<SymbolDeclaration>();
    expectTypeOf<ARosettaProcedure>().toExtend<SymbolDeclaration>();
    expectTypeOf<DoorProcedure>().toExtend<SymbolDeclaration>();
    expectTypeOf<AKernelKeyword>().toExtend<SymbolDeclaration>();
  });

  // INVARIANT: the three SURVIVING declarative record kinds — symbol.define / defineSyntax
  // (the two-phase carve-out) and symbol.macro (already hands over a real Macro) — stay
  // assignable, unaffected by Stage A2.
  test("define / defineSyntax / macro stay assignable (the surviving declarative record kinds)", () => {
    expectTypeOf<DefineSymbolDef>().toExtend<SymbolDeclaration>();
    expectTypeOf<DefineSyntaxSymbolDef>().toExtend<SymbolDeclaration>();
    expectTypeOf<MacroSymbolDef>().toExtend<SymbolDeclaration>();
  });

  // INVARIANT (Stage A2 pin): a raw CONTRACT shape (what `native()` used to return directly)
  // is NOT itself assignable anymore — it only ever rides `.contract` on a minted
  // ANativeProcedure now, never traveling loose in a `symbols` record.
  test("a bare NativeSymbolDef contract shape is NOT assignable (rides `.contract` on the minted value instead)", () => {
    expectTypeOf<NativeSymbolDef>().not.toExtend<SymbolDeclaration>();
  });

  // INVARIANT (retirement pin): an untagged `{ value }` object is NOT assignable — data
  // constants go through `symbol.value` (mints a boxed `AmbientValue` leaf) instead.
  test("a bare value-binding object is NOT assignable to SymbolDeclaration (retired arm)", () => {
    expectTypeOf<{ value: unknown }>().not.toExtend<SymbolDeclaration>();
  });

  // INVARIANT (retirement pin): a bare function is NOT assignable — callables author as
  // baked symbol.* defs, or as the explicit legacy `{ fn }` record while MCP still rides it.
  test("a bare function is NOT assignable to SymbolDeclaration (retired arm)", () => {
    expectTypeOf<(...args: unknown[]) => unknown>().not.toExtend<SymbolDeclaration>();
  });

  // INVARIANT (Stage C Cut 4 retirement pin, Phase B RETROACTIVE): the legacy `{ fn }` record
  // is NO LONGER assignable — `lower()` (its sole binder) is retired, and there is no runtime
  // refusal check left either (`isSymbolSpec`/`VocabularyLegacyCapabilityError` are deleted,
  // docs/plans/stage-c-corpse-deletion.md §"bans live at the TYPE level") — this compile-time
  // rejection IS the whole contract now.
  test("an explicit { fn } record is NOT assignable to SymbolDeclaration (retired arm)", () => {
    expectTypeOf<{ fn: (...args: unknown[]) => unknown }>().not.toExtend<SymbolDeclaration>();
  });
});
