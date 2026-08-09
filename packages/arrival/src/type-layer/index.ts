// type-layer — public seam for the Σ∩T NARROW (harvested-prelude query lens).
// Plane framing: docs/static-plane.md §THE Σ∩T NARROW, §THE FOUR READERS 4.1.
//
// `@inhuman.tools/arrival/type-layer` surfaces the pieces a consumer assembles to narrow
// constrained decode by host tools' TYPES (Scheme is a TS subset except lists and pairs).
// `printType`/`lower` are exposed so a hand-rolled `declare const` prints with the SAME
// flatten the harvest uses. Internals (carriers ambient text, role finder, virtual program
// host) stay unexported; see each export's own doc for its contract.

export { assembleHarvestedPrelude, assemblePreludeFromSignatures, type HarvestedPrelude } from "./prelude.js";
export { createQueryLens, type QueryLens, type SlotArrayKind } from "./query.js";
export { printType, signatureOf, sTagToTsType } from "./schema-to-ts.js";
export { lower, type LoweredStatement } from "./lower.js";
export { createDiagnoseLens, type DiagnoseLens, type RawMappedDiagnostic } from "./diagnose.js";
