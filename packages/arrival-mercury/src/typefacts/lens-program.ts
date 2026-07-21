/**
 * typefacts/lens-program — one checked virtual-TS program per extract call.
 *
 * The in-memory file map is the LENS PRELUDE ASSEMBLY (`getBundledPreludeFiles()`
 * from `@inhuman.tools/arrival-internals-types-prelude/browser` — PRE under
 * `__pre.d.ts` + every `__leaf_*.d.ts` builtin) plus the emitted program under
 * `__program.ts`. We source the prelude from the BUNDLED `/browser` entry, not the
 * node-disk `.` entry, so importing this module (hence `SchemeSemanticModel`) never
 * executes `node:fs` — the prelude is compiler-internal STATIC DATA (frozen `.d.ts`
 * strings inlined at the prelude package's own build), not fs. That keeps the whole
 * model/`/product` graph browser-safe; only `createFactsProgram`'s tsc host below is
 * node-bound (`ts.sys` lib fallback / `process.cwd`), and it runs solely when facts
 * are QUERIED — never on a browser compile path. The prelude itself stays owned by
 * that shared type-vocabulary package (never vendored here), which both this
 * extractor and the LSP depend down on.
 *
 * One LanguageService per call is the sanctioned v1 cost: one
 * `loadSource`-equivalent + a few thousand cached checker queries ≪ 1s.
 * Batching several compiles over one DocumentRegistry is the later
 * optimization, noted, not built.
 */
import { getBundledPreludeFiles, PRELUDE_FILE, PROGRAM_FILE } from "@inhuman.tools/arrival-internals-types-prelude/browser";
import ts from "typescript";

export { PRELUDE_FILE, PROGRAM_FILE };

export interface FactsProgram {
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
}

const OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts"],
  types: [],
  skipLibCheck: false,
};

export function createFactsProgram(virtualTs: string): FactsProgram {
  const files = getBundledPreludeFiles();
  files.set(PROGRAM_FILE, virtualTs);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => {
      const mem = files.get(name);
      if (mem !== undefined) return ts.ScriptSnapshot.fromString(mem);
      const disk = ts.sys.readFile(name);
      return disk === undefined ? undefined : ts.ScriptSnapshot.fromString(disk);
    },
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => OPTIONS,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (name) => files.has(name) || ts.sys.fileExists(name),
    readFile: (name) => files.get(name) ?? ts.sys.readFile(name),
  };
  const program = ts.createLanguageService(host, ts.createDocumentRegistry()).getProgram();
  const sourceFile = program?.getSourceFile(PROGRAM_FILE);
  if (!program || !sourceFile) {
    // Structurally unreachable (the file map always carries PROGRAM_FILE);
    // loud beats a null-checker cascade.
    throw new Error("typefacts: virtual program failed to materialize");
  }
  return { checker: program.getTypeChecker(), sourceFile };
}

/**
 * The tightest TS node whose `[getStart(), getEnd())` covers `[start, end)` —
 * the TS-side containment half of the span join (spec §5's `nodeAt`, widened
 * from a point to the mapping's full range so an exact whole-form mapping
 * selects the call expression, never its `__arr` head token). Public-API
 * recursion, deliberately not `ts.getTouchingToken` (a TS-internal API).
 * Ties prefer the deeper node. Returns `null` when only the SourceFile covers
 * the range (⇒ `"no-ts-node"`).
 */
export function tightestCovering(sf: ts.SourceFile, start: number, end: number): ts.Node | null {
  let best: ts.Node | null = null;
  const visit = (n: ts.Node): void => {
    if (n.getStart(sf) <= start && end <= n.getEnd()) {
      if (best === null || n.getEnd() - n.getStart(sf) <= best.getEnd() - best.getStart(sf)) best = n;
      // Only a covering node's children can still cover the range.
      n.forEachChild(visit);
    }
  };
  ts.forEachChild(sf, visit);
  return best;
}
