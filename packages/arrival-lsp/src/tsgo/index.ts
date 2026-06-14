// tsgo — the TypeScript 7 (typescript-go) wasm backend, BROWSER-SAFE barrel:
// nothing here imports `typescript` or node builtins, so a worker chunk built
// from this entry carries the lens logic and the ~17KB Go glue — not the 8MB
// JS compiler. The Node transport (child-process spawn) lives at
// `./tsgo/node` (node-transport.ts); the wasm asset itself is re-exported by
// the package as `@here.build/arrival-type-lens/tsgo.wasm` so consumers
// inherit ONE pinned, canary-gated artifact instead of each pinning the
// 51MB binary themselves.

import { PRELUDE_BUNDLE } from "../prelude-bundle.generated.js";

export {
  createTsgoClient,
  SIGNATURE_KIND_CALL,
  SYMBOL_FLAGS_VALUE,
  type ProjectId,
  type SignatureId,
  type SignatureRef,
  type SnapshotId,
  type SymbolId,
  type SymbolRef,
  type TsgoClient,
  type TsgoDiagnostic,
  type TsgoProject,
  type TsgoTransport,
  type TsgoVirtualFs,
  type TypeId,
  type TypeRef,
  type UpdateSnapshotResult,
} from "./client.js";
export { createTsgoBrowserTransport, type TsgoBrowserTransportOptions } from "./browser-transport.js";
export {
  createTsgoTypeLens,
  scanInnermostCall,
  type CallSlot,
  type TsgoTypeLens,
  type TsgoTypeLensOptions,
} from "./type-lens.js";

/** The bundled prelude (PRE + builtin leaves) WITHOUT the `typescript` import
 *  the `./browser` entry's service factory drags in — the file map a
 *  tsgo-backed worker feeds to {@link createTsgoTypeLens}. */
export function bundledPreludeFiles(): Map<string, string> {
  return new Map(PRELUDE_BUNDLE);
}

export {
  createTsgoSchemeService,
  type SchemeClassifiedSpan,
  type SchemeCompletionContext,
  type SchemeCompletionEntry,
  type SchemeDefinition,
  type SchemeDiagnostic,
  type SchemeQuickInfo,
  type SchemeRichCompletion,
  type TsgoSchemeService,
  type TsgoSchemeServiceOptions,
} from "./scheme-service.js";
