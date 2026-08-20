/**
 * `.hbs` → scheme → ordinary scm module compile.
 *
 * Well-known pretreat (`hbsContentsToSchemeSource`) then import-executable
 * (`compileScmModule`). Domain filetypes register via `buildProject` pretreat.
 */
import { hbsContentsToSchemeSource } from "@inhuman.tools/arrival-modules/handlebars";

import { compileScmModule, type ScmCompileDeps } from "./scm-module.js";
import type { CompileFileOptions, CompileFileResult } from "./types.js";

export const HBS_EXT = ".hbs";

export function compileHbsFile(
  content: string,
  deps: ScmCompileDeps,
  opts: Pick<CompileFileOptions, "path" | "runtimeImportPath">,
): CompileFileResult {
  const scheme = hbsContentsToSchemeSource(content);
  return compileScmModule(scheme, deps, {
    path: opts.path,
    runtimeImportPath: opts.runtimeImportPath,
    isPipeline: false,
    resolveRequire: (specifier) => ({
      kind: "unresolved",
      code: "build/unresolved-require",
      reason: `— generated .hbs scheme must not (require …) (got "${specifier}")`,
    }),
  });
}
