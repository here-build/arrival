/**
 * Host pretreat → scheme → ordinary scm module compile.
 *
 * Domain filetypes (`.prompt`, …) convert bytes to scheme OUTSIDE mercury.
 * This module compiles the resulting scheme as a normal module face — trailing
 * expression → `export default function Main()`. Mercury never names those
 * extensions.
 */
import { compileScmModule, type ScmCompileDeps } from "./scm-module.js";
import type { CompileFileOptions, CompileFileResult } from "./types.js";

/** Bytes → scheme source. The compiler walks the result; it does not parse the original format. */
export type PretreatFile = (contents: string, path: string) => string;

export function compilePretreatFile(
  content: string,
  pretreat: PretreatFile,
  deps: ScmCompileDeps,
  opts: Pick<CompileFileOptions, "path" | "runtimeImportPath">,
): CompileFileResult {
  const scheme = pretreat(content, opts.path);
  return compileScmModule(scheme, deps, {
    path: opts.path,
    runtimeImportPath: opts.runtimeImportPath,
    isPipeline: false,
    resolveRequire: (specifier) => ({
      kind: "unresolved",
      code: "build/unresolved-require",
      reason: `— generated pretreat scheme must not (require …) (got "${specifier}")`,
    }),
  });
}
