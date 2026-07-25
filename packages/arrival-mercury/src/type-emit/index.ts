// type-emit — the TYPE pass: emits virtual TypeScript (type-checked, never run).
// Non-narrowing conditions lower as `(expr === true)`; narrowing forms emit
// native boolean ops (see emit.ts).
export { emitTypes, type EmitTypesOptions, type EmitTypesResult, type Mapping } from "./emit.js";
export { narrowsMembersOf } from "./narrows.js";
export {
  decodeSchemeIdent,
  encodeSchemeIdent,
  isPlainIdent,
  schemeIdentIsBareTs,
  SCHEME_IDENT_CHAR_TOKENS,
  SCHEME_IDENT_RESERVED,
  SCHEME_IDENT_TOKEN_CHARS,
} from "./scheme-ident.js";
