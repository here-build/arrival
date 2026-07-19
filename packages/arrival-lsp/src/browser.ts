// Browser entry: same API as the Node one, but everything is baked in at THIS
// package's `vite build` time (no fs, no `ts.sys`). This keeps the "empty
// barrel" (no JS globals) contract identical to Node while staying
// self-contained for workers — dist/browser.js is a plain module: no
// `import.meta.glob`, no `?raw` specifiers survive into consumers.
//
// TS libs come from the generated explicit-`?raw` barrel (Vite 7 bans
// bare-package GLOBS like "typescript/lib/lib.*.d.ts" everywhere; bare `?raw`
// IMPORTS stay legal and get inlined by the lib build). The prelude glob below
// is relative — Vite-legal — and inlines the same way.
//
// skipLibCheck is on by default — re-checking the stock libs on every keystroke
// buys nothing.

import {
  createSchemeLanguageServiceCore,
  type SchemeLanguageService,
  type SchemeLanguageServiceOptions,
} from "./service-core.js";
import { stripLibFiles } from "./ts-lib-strip.js";
import { TS_LIB_RAW } from "./ts-libs-raw.generated.js";
import { TS_DEFAULT_LIB, TS_LIB_FILE_NAMES } from "./ts-libs.generated.js";
import { PRELUDE_FILE } from "./virtual-files.js";

function getRawForLib(name: string): string {
  // The manifest and the barrel are two generated artifacts — guard their
  // drift at runtime.
  if (!(name in TS_LIB_RAW))
    throw new Error(`[arrival-lsp] missing bundled ?raw for ${name} (fix: pnpm generate:bundles)`);
  return TS_LIB_RAW[name];
}

const TS_LIB_FILES = stripLibFiles(TS_LIB_FILE_NAMES, getRawForLib);

export type {
  SchemeDiagnostic,
  SchemeQuickInfo,
  SchemeClassifiedSpan,
  SchemeCompletionEntry,
  SchemeRichCompletion,
  SchemeCompletionContext,
  SchemeDefinition,
  SchemeLanguageService,
  SchemeLanguageServiceOptions,
} from "./service-core.js";

// Load prelude via RELATIVE glob (same sources as the disk path). Vite 7's
// eager-`?raw` glob yields `{ default: string }` modules unless told which
// binding to take — `import: "default"` makes the values plain strings.
const preludeModules = import.meta.glob("./prelude/**/*.d.ts", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

export const getBundledPreludeFiles = () => {
  const map = new Map<string, string>();

  // Main PRE (use the exported constant for the key)
  const preKey = Object.keys(preludeModules).find((k) => k.includes("prelude/types.d.ts"));
  if (preKey && preludeModules[preKey]) {
    map.set(PRELUDE_FILE, preludeModules[preKey]);
  }

  // Builtin leaves — mirror the logic from getPreludeFiles. Keys are the glob's
  // relative paths; tolerate a `?raw` suffix (older Vite key shapes) so the
  // guard is on CONTENT, not on Vite's key cosmetics.
  for (const [key, content] of Object.entries(preludeModules)) {
    const match = /builtins\/([^/]+)\.d\.ts(?:\?raw)?$/.exec(key);
    if (match) {
      const f = match[1];
      if (!f.startsWith("_")) {
        map.set(`__leaf_${f}.d.ts`, content);
      }
    }
  }

  return map;
};

export const createBrowserSchemeLanguageService = (opts?: SchemeLanguageServiceOptions): SchemeLanguageService =>
  createSchemeLanguageServiceCore(
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

export { scanRequires, type RequireRef } from "./service-core.js";

export { TS_LIB_FILES }; // for the coherence test
