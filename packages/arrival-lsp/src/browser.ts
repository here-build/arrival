// browser — the browser entry of the Scheme language service.
//
// Same service as `language-service.ts` (Node), but every virtual file the
// compilation needs is baked in at build time (`scripts/generate-bundles.mjs`):
// the prelude bundle and the `lib.es2022.d.ts` reference chain of the pinned
// `typescript`. Self-contained on purpose — no CDN fetch, no `node:fs`, no
// `ts.sys` — so type checks work in an offline (CLI-served) studio and the lib
// version can never drift from the `typescript` the service runs on.
//
// `skipLibCheck` defaults to TRUE here (the Node default is false): re-verifying
// the stock TS libs inside an editor keystroke loop buys nothing.

import { PRELUDE_BUNDLE } from "./prelude-bundle.generated.js";
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
} from "./service-core.js";

/** The bundled prelude (PRE + builtin leaves) as a fresh mutable map — the
 *  browser twin of `getPreludeFiles()`. */
export function getBundledPreludeFiles(): Map<string, string> {
  return new Map(PRELUDE_BUNDLE);
}

/** Create a Scheme language service that runs entirely in the browser (or any
 *  fs-less runtime): bundled prelude + bundled TS default libs, no `ts.sys`. */
export function createBrowserSchemeLanguageService(opts?: SchemeLanguageServiceOptions): SchemeLanguageService {
  return createSchemeLanguageServiceCore(
    {
      rootFiles: getBundledPreludeFiles(),
      supportFiles: new Map(TS_LIB_FILES),
      // The compilation's `lib: ["lib.es2022.d.ts"]` entries resolve relative to
      // this file's directory — bare names against the bare-keyed map.
      getDefaultLibFileName: () => TS_DEFAULT_LIB,
    },
    {
      ...opts,
      compilerOptions: { skipLibCheck: true, ...opts?.compilerOptions },
    },
  );
}
