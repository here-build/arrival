/**
 * `.prompt` → scheme → ordinary scm module compile.
 *
 * Loader logic (interpreter) and build logic (mercury) share one pure
 * conversion: `promptContentsToSchemeSource` in llm-plane-arrival-env. That
 * yields the CALLABLE RULE shape (let* + lambda over infer/run) — the same
 * forms `kind: "eval"` returns at require time. Mercury then compiles that
 * scheme as a normal module face: trailing expression →
 * `export default function Main() { … }` so a requiring sibling's
 * `const x = xProgram()` materializes the prompt lambda exactly as the
 * interpreter's `(require "x.prompt")` yields it.
 *
 * Not a special import path. Convert the target to scheme, then compile.
 */
import { promptContentsToSchemeSource } from "@inhuman.tools/llm-plane/arrival-env";

import { compileScmModule, type ScmCompileDeps } from "./scm-module.js";
import type { CompileFileOptions, CompileFileResult } from "./types.js";

export const PROMPT_EXT = ".prompt";

/**
 * Compile one `.prompt` file: pure bytes→scheme, then the ordinary scm
 * pipeline. `resolveRequire` is unused (the generated scheme has no
 * `(require …)`), but the scm options surface still needs a runtime path
 * for residual stage0 imports when the walk needs them.
 */
export function compilePromptFile(
  content: string,
  deps: ScmCompileDeps,
  opts: Pick<CompileFileOptions, "path" | "runtimeImportPath">,
): CompileFileResult {
  const scheme = promptContentsToSchemeSource(content, opts.path);
  return compileScmModule(scheme, deps, {
    path: opts.path,
    runtimeImportPath: opts.runtimeImportPath,
    isPipeline: false,
    // Generated scheme is a self-contained expression over capability verbs —
    // no project-relative requires.
    resolveRequire: (specifier) => ({
      kind: "unresolved",
      code: "build/unresolved-require",
      reason: `— generated .prompt scheme must not (require …) (got "${specifier}")`,
    }),
  });
}
