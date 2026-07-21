export {
  createSchemeLanguageService,
  createSchemeLanguageServiceCore,
  type ServiceEnvironment,
  type SchemeLanguageService,
  type SchemeLanguageServiceOptions,
  type SchemeDiagnostic,
  type SchemeQuickInfo,
  type SchemeClassifiedSpan,
  type SchemeCompletionEntry,
  type SchemeRichCompletion,
  type SchemeCompletionContext,
  type SchemeDefinition,
} from "./language-service.js";

// The prelude vocabulary (`getPreludeFiles`, `PRELUDE_FILE`, `PROGRAM_FILE`) and
// the `.d.ts` builtin surface now live in
// `@inhuman.tools/arrival-internals-types-prelude` — import them from there.
export { Mapper, type Mapping, type Span, type LineCol } from "./span-map.js";
export { narrowByType, type Scanner, type ScannerState, type TypeLens } from "./typed-scanner.js";
export { assembleHostPrelude, type HostPrelude, type AssembleHostPreludeOptions } from "./host-prelude.js";
export { scanRequires, type RequireRef } from "./service-core.js";
