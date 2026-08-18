// compile-host — the type-layer's ONE virtual-program compile, shared by the query lens
// (query.ts, Σ∩T narrow) and the diagnose lens (diagnose.ts, type-hint spine).
//
// Both build a throwaway `ts.Program` over a single in-memory probe file against the real
// `lib.es2022.d.ts` (strict, skipLibCheck). `createQueryLens` reads TYPES off the checker
// and ignores diagnostics; `createDiagnoseLens` reads `getSemanticDiagnostics` off the
// SAME program shape. Lifting the host here keeps that compile identical across both
// consumers (decode-gate invariant).

import * as ts from "typescript";

/** Type-check one in-memory probe file against the real lib, keeping the program + checker.
 *  One call = one compile; diagnostics are read by the caller (query ignores them,
 *  diagnose reads them) — the compile itself is identical either way.
 *  Returns `null` when the source file fails to materialize (corrupt probe / host failure). */
export function compile(
  source: string,
): { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile } | null {
  const fileName = "/__query.ts";
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreate);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => (name === fileName ? source : readFile(name));

  const program = ts.createProgram([fileName], options, host);
  const sourceFile = program.getSourceFile(fileName);
  if (sourceFile === undefined) return null;
  return { program, checker: program.getTypeChecker(), sourceFile };
}
