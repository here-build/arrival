// type-layer — the public seam for the Σ∩T NARROW (the harvested-prelude query lens).
//
// `@here.build/arrival/type-layer` surfaces the three pieces a consumer assembles to narrow a
// constrained decode by the host tools' TYPES (Scheme is a TS subset except lists and pairs):
//
//   • assembleHarvestedPrelude(entries) — turn a set of `[name, SymbolDef]` grant tools into the
//     ambient TS prelude (carriers.ts + one `declare const` per tool, harvested from the zod
//     contract via schema-to-ts).
//   • createQueryLens(harvested)        — the lens: `getTypeValidCandidates` (the Σ∩T mask,
//     drops-only) + `getSlotArrayKind` (the 3-way list/vector/scalar slot verdict).
//   • printType / lower                 — the harvest + lowering primitives (a consumer building
//     ad-hoc literal-typed `declare const`s — e.g. value-symbol constants — prints with the SAME
//     flatten the harvest uses, so a hand-rolled decl and a harvested signature never diverge).
//
// Internals (carriers.ts ambient text, the role finder, the virtual program host) stay unexported.

export { assembleHarvestedPrelude, type HarvestedPrelude } from "./prelude.js";
export { createQueryLens, type QueryLens, type SlotArrayKind } from "./query.js";
export { printType, signatureOf } from "./schema-to-ts.js";
export { lower, type LoweredStatement } from "./lower.js";
export { createDiagnoseLens, type DiagnoseLens, type RawMappedDiagnostic } from "./diagnose.js";
