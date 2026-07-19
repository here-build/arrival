// type-emit — the TYPE pass: emits virtual TypeScript (type-checked, never run)
// that wraps every non-narrowing condition in `__scmTruth` and narrows via
// `narrowsMembersOf` (see emit.ts for the full grammar).
export { emitTypes, type EmitTypesOptions, type EmitTypesResult, type Mapping } from "./emit.js";
export { narrowsMembersOf } from "./narrows.js";
