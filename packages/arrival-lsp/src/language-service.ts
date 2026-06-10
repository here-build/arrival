// language-service — the Node entry of the Scheme language service.
//
// The implementation lives in `service-core.ts` (environment-agnostic — no
// `node:fs`, no `ts.sys`). This wrapper supplies the Node environment: the
// prelude read from disk, the default-lib chain resolved off the installed
// `typescript` package, and `ts.sys` as the real-fs fallback. The browser
// counterpart is `browser.ts` (generated bundles, no fs).

import ts from "typescript";

import { getPreludeFiles } from "./prelude.js";
import {
  createSchemeLanguageServiceCore,
  type SchemeLanguageService,
  type SchemeLanguageServiceOptions,
} from "./service-core.js";

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

/** Create a Scheme language service with the Node environment (disk prelude,
 *  installed-typescript default libs, `ts.sys` fallback). */
export function createSchemeLanguageService(opts?: SchemeLanguageServiceOptions): SchemeLanguageService {
  return createSchemeLanguageServiceCore(
    {
      rootFiles: getPreludeFiles(),
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      sys: ts.sys,
    },
    opts,
  );
}
