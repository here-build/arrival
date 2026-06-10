// language-service — the Node entry of the Scheme language service.
//
// The implementation lives in `service-core.ts` (environment-agnostic — no
// `node:fs`, no `ts.sys`). This wrapper supplies the Node environment: the
// prelude read from disk + the SAME generated, value-stripped TS lib bundle the
// browser entry uses (`browser.ts`). One world on purpose: scheme has no JS
// environment, so the compilation's globals are types-only ("the env is an
// empty barrel" — `(parseInt "3")` is a Cannot-find-name bite, not a silently
// well-typed call), and Node/browser answers can never diverge on lib version
// or content. No `ts.sys` fallback — the compilation is hermetic.

import { getPreludeFiles } from "./prelude.js";
import {
  createSchemeLanguageServiceCore,
  type SchemeLanguageService,
  type SchemeLanguageServiceOptions,
} from "./service-core.js";
import { TS_DEFAULT_LIB, TS_LIB_FILES } from "./ts-libs.generated.js";

export type {
  SchemeDiagnostic,
  SchemeQuickInfo,
  SchemeCompletionEntry,
  SchemeDefinition,
  SchemeLanguageService,
  SchemeLanguageServiceOptions,
  ServiceEnvironment,
} from "./service-core.js";
export { createSchemeLanguageServiceCore } from "./service-core.js";

/** Create a Scheme language service with the Node environment: disk prelude,
 *  bundled value-stripped TS libs (identical to the browser entry's world). */
export function createSchemeLanguageService(opts?: SchemeLanguageServiceOptions): SchemeLanguageService {
  return createSchemeLanguageServiceCore(
    {
      rootFiles: getPreludeFiles(),
      supportFiles: new Map(TS_LIB_FILES),
      getDefaultLibFileName: () => TS_DEFAULT_LIB,
    },
    opts,
  );
}
