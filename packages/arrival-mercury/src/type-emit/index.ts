// type-emit — the TYPE pass (virtual TS, type-checked never run): Law T's
// `__scmTruth` wrap + the §5.3 narrowing-form grammar over `narrowsMembers`
// (constitution §5.2/§5.3; docs/working-proposals/arrival-mercury/type-emit-lawt.md).
export { emitTypes, type EmitTypesOptions, type EmitTypesResult, type Mapping } from "./emit.js";
export { narrowsMembersOf } from "./narrows.js";
