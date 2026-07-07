// Browser entry: same API as the Node one, but everything comes from Vite globs
// (no fs, no `ts.sys`). This keeps the "empty barrel" (no JS globals) contract
// identical to Node while staying self-contained for workers.
//
// skipLibCheck is on by default — re-checking the stock libs on every keystroke
// buys nothing.

import {
  createSchemeLanguageServiceCore,
  type SchemeLanguageService,
  type SchemeLanguageServiceOptions,
} from "./service-core.js";
import { stripLibFiles } from "./ts-lib-strip.js";
import { TS_DEFAULT_LIB, TS_LIB_FILE_NAMES } from "./ts-libs.generated.js";
import { PRELUDE_FILE } from "./virtual-files.js";

// Load via glob so both Node and browser see the identical stripped set.
const rawModules = import.meta.glob("typescript/lib/lib.*.d.ts", { eager: true, query: "?raw" }) as Record<
  string,
  string
>;

function getRawForLib(name: string): string {
  const directKey = `typescript/lib/${name}?raw`;
  if (rawModules[directKey]) return rawModules[directKey];
  const match = Object.entries(rawModules).find(([k]) => k.includes(name));
  if (match) return match[1];
  throw new Error(`[arrival-type-lens] missing Vite ?raw for ${name}`);
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

// Load prelude via glob (same sources as disk path).
const preludeModules = import.meta.glob("./prelude/**/*.d.ts", { eager: true, query: "?raw" }) as Record<
  string,
  string
>;

export const getBundledPreludeFiles = () => {
  const map = new Map<string, string>();

  // Main PRE (use the exported constant for the key)
  const preKey = Object.keys(preludeModules).find((k) => k.includes("prelude/types.d.ts"));
  if (preKey && preludeModules[preKey]) {
    map.set(PRELUDE_FILE, preludeModules[preKey]);
  }

  // Builtin leaves — mirror the logic from getPreludeFiles
  for (const [key, content] of Object.entries(preludeModules)) {
    if (key.includes("/builtins/") && key.endsWith(".d.ts?raw")) {
      const match = /builtins\/([^/]+)\.d\.ts\?raw$/.exec(key);
      if (match) {
        const f = match[1];
        if (!f.startsWith("_")) {
          map.set(`__leaf_${f}.d.ts`, content);
        }
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
