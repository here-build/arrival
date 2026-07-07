// type-layer — the public seam for the Σ∩T NARROW (the harvested-prelude query lens).
//
// `@here.build/arrival/type-layer` surfaces the pieces a consumer assembles to narrow a
// constrained decode by the host tools' TYPES (Scheme is a TS subset except lists and pairs).
// `printType`/`lower` are exposed so a hand-rolled `declare const` (e.g. value-symbol
// constants) prints with the SAME flatten the harvest uses — never diverges from a harvested
// signature. Internals (carriers.ts ambient text, the role finder, the virtual program host)
// stay unexported; see each export's own doc for its contract.

export { assembleHarvestedPrelude, assemblePreludeFromSignatures, type HarvestedPrelude } from "./prelude.js";
export { createQueryLens, type QueryLens, type SlotArrayKind } from "./query.js";
export { printType, signatureOf, sTagToTsType } from "./schema-to-ts.js";
export { lower, type LoweredStatement } from "./lower.js";
export { createDiagnoseLens, type DiagnoseLens, type RawMappedDiagnostic } from "./diagnose.js";
