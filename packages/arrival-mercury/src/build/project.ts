/**
 * `inhuman build` — the project-level orchestration (design doc §4): discover
 * file types, order `.scm` files leaves-first over their `(require …)` graph,
 * compile each (per-file work lives in `scm-module.ts`/`data-module.ts`), and
 * emit the stage-0 runtime alongside. Pure — takes a project's files as an
 * in-memory map and returns an in-memory output; the CLI package owns all real
 * disk I/O (mirrors `@inhuman.tools/mercury`'s own `compileProject`, which this
 * surface is the greenfield sibling of).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classify } from "../coreform/classify.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { greenfieldRegistryFor, openOracleSession } from "../oracle/harness.js";
import { compileDataFile, DATA_EXTENSIONS } from "./data-module.js";
import { flattenTopBegins, hasProgramFace, scanRequires } from "./require-scan.js";
import { compileScmModule } from "./scm-module.js";
import type { BuildFile, BuildResult, BuildWarning, ExportShape, RequireResolution } from "./types.js";

const SCM_EXT = ".scm";
const PROMPT_EXT = ".prompt";

function extOf(relPath: string): string {
  return path.posix.extname(relPath);
}

/** Swap the source extension for `.ts` — every compiled file lands as a TS
 *  source, 1:1 with its input (design doc §4: "emit a TS package"). */
function outPathFor(relPath: string): string {
  return relPath.replace(/\.[^./]+$/, ".ts");
}

/** Resolve a `(require "…")` specifier against the requiring file's own
 *  directory — mirrors arrival core's OWN loader (`loader.ts`'s `joinPath`):
 *  any specifier is directory-relative unless it starts with `/` (root-
 *  relative); there is no Node-style bare-specifier/node_modules distinction. */
function resolveSpecifier(fromRelPath: string, specifier: string): string {
  if (specifier.startsWith("/")) return path.posix.normalize(specifier).replace(/^\/+/, "");
  const dir = path.posix.dirname(fromRelPath);
  return path.posix.normalize(dir === "." ? specifier : `${dir}/${specifier}`);
}

/** The relative IMPORT SPECIFIER `fromRelPath`'s compiled output should use to
 *  reach `toRelPath`'s compiled output — `.js`-suffixed (the workspace's own
 *  NodeNext convention: TS source, `.js`-suffixed import specifiers, exactly
 *  as `inhuman`'s own `cli.ts` already writes `"./cache.js"` etc.). */
function importSpecifierBetween(fromRelPath: string, toRelPath: string): string {
  const fromDir = path.posix.dirname(outPathFor(fromRelPath));
  const toOut = outPathFor(toRelPath);
  let rel = path.posix.relative(fromDir, toOut);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.replace(/\.ts$/, ".js");
}

interface FileInfo {
  readonly relPath: string;
  readonly ext: string;
  /** Resolved relPaths this `.scm` file requires — ONLY targets that exist
   *  among the project's own files (a dangling require is a per-file
   *  `resolveRequire` warning at compile time, not a graph edge). Empty for
   *  every non-`.scm` file (data/`.prompt` files have no requires of their
   *  own). */
  readonly deps: readonly string[];
}

function scanScmDeps(relPath: string, source: string, files: Readonly<Record<string, string>>): string[] {
  const forms = flattenTopBegins(classify(desugar(parseSexprs(source))).forms);
  const uses = scanRequires(forms);
  const targets = new Set<string>();
  for (const use of uses) {
    const target = resolveSpecifier(relPath, use.node.path);
    if (Object.hasOwn(files, target)) targets.add(target);
  }
  return [...targets];
}

/** Kahn-style DFS post-order topological sort — leaves first (a file's own
 *  deps are compiled, and their `shape`s known, before it is). A require cycle
 *  doors: the cycle-closing edge is dropped with a warning, per design doc §3's
 *  sequencing note ("the project tree is a DAG; cycles door"); the culprit
 *  file(s) are excluded from `order` (and therefore never compiled — any
 *  OTHER file requiring one reports "not compiled" via `resolveRequire`). */
function topoSort(infos: ReadonlyMap<string, FileInfo>, warnings: BuildWarning[]): string[] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const order: string[] = [];
  const visit = (relPath: string, chain: readonly string[]): void => {
    if (visited.has(relPath)) return;
    if (inStack.has(relPath)) {
      warnings.push({
        path: relPath,
        message: `require cycle: ${[...chain, relPath].join(" → ")} — this file is excluded from the build (design doc §3: cycles door)`,
      });
      return;
    }
    const info = infos.get(relPath);
    if (info === undefined) return;
    inStack.add(relPath);
    for (const dep of info.deps) visit(dep, [...chain, relPath]);
    inStack.delete(relPath);
    visited.add(relPath);
    order.push(relPath);
  };
  for (const relPath of infos.keys()) visit(relPath, []);
  return order;
}

/** The stage-0 runtime module's own source text, staged verbatim into the
 *  output (design doc §5: "copy/emit the stage-0 runtime module into the
 *  output"). Mirrors `oracle/harness.ts`'s `stageRuntimeModule` candidate
 *  order exactly (`.ts` source first, `.js` dist fallback — plain JS is valid
 *  `.ts` content too), so this works identically whether the package is run
 *  from source or from its built `dist/`. */
function loadStage0Source(): string {
  const candidates = [new URL("../runtime/stage0.ts", import.meta.url), new URL("../runtime/stage0.js", import.meta.url)];
  for (const url of candidates) {
    try {
      return readFileSync(fileURLToPath(url), "utf8");
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("buildProject: stage-0 runtime module not found — checked ../runtime/stage0.{ts,js}");
}

export interface BuildProjectOptions {
  /** Output basename for the copied stage-0 runtime module (no extension).
   *  Default `"stage0"`. */
  readonly stage0Basename?: string;
}

/**
 * Compile a whole project (design doc §4's `inhuman build`). `files` is
 * project-relative-path → source text, exactly the shape
 * `loadProjectFromDir`/`listFiles`/`readProgram` (the CLI's existing
 * `load-project.ts`) already produce for `run`/`compile` — this function adds
 * no filesystem access of its own.
 */
export async function buildProject(files: Readonly<Record<string, string>>, opts?: BuildProjectOptions): Promise<BuildResult> {
  const stage0Basename = opts?.stage0Basename ?? "stage0";
  const warnings: BuildWarning[] = [];
  const outFiles: BuildFile[] = [];

  const infos = new Map<string, FileInfo>();
  for (const [relPath, content] of Object.entries(files)) {
    const ext = extOf(relPath);
    if (ext === SCM_EXT) {
      infos.set(relPath, { relPath, ext, deps: scanScmDeps(relPath, content, files) });
    } else if (DATA_EXTENSIONS.has(ext) || ext === PROMPT_EXT) {
      infos.set(relPath, { relPath, ext, deps: [] });
    } else {
      warnings.push({
        path: relPath,
        message: `unrecognized file type "${ext || "(none)"}" — v0 handles .scm/.prompt/.json/.yaml/.yml/.txt; skipped`,
      });
    }
  }

  const order = topoSort(infos, warnings);

  // The v0 pipeline heuristic (design doc §3's `@/pipelines/*` rule, resolved
  // for THIS project layout — see the CLI report): a `.scm` file gets the
  // thunked, parameterized `export default function` treatment iff (a) it has
  // a genuine trailing program-face expression, AND (b) no OTHER file in the
  // project requires it (a DAG root — nothing to spill/import FROM it, so
  // there is no "module face" consumer to preserve; it is, structurally, an
  // entry point). A file matching neither stays ordinary module face.
  const requiredBy = new Set<string>();
  for (const info of infos.values()) for (const dep of info.deps) requiredBy.add(dep);

  const shapes = new Map<string, ExportShape>();
  const session = await openOracleSession();
  try {
    const baseRegistry = greenfieldRegistryFor(session);
    for (const relPath of order) {
      const info = infos.get(relPath);
      if (info === undefined) continue; // an unrecognized-extension file, already warned
      const source = files[relPath]!;

      if (info.ext === PROMPT_EXT) {
        // STOP item (this lane's own directive): the `.prompt` phase-1
        // (dotprompt → scheme) compiler is not a reusable pure-string-in
        // library today — see the CLI report's precise account. No shape is
        // recorded; any require of this file reports "unresolved" below,
        // which is a real (visible) build warning, never a silent gap.
        warnings.push({
          path: relPath,
          message:
            ".prompt compilation is not implemented in this build (v0 STOP item — the phase-1 dotprompt→scheme step is embedded in a live EnvCapability's ContentResolver, not a pure function; see the lane report). Requiring this file will door at build/run time.",
        });
        continue;
      }

      if (DATA_EXTENSIONS.has(info.ext)) {
        try {
          const compiled = compileDataFile(info.ext, source, relPath);
          shapes.set(relPath, compiled.shape);
          outFiles.push({ path: outPathFor(relPath), content: compiled.content });
          for (const m of compiled.warnings) warnings.push({ path: relPath, message: m });
        } catch (e) {
          warnings.push({ path: relPath, message: e instanceof Error ? e.message : String(e) });
        }
        continue;
      }

      // .scm
      const isPipeline = !requiredBy.has(relPath) && hasProgramFace(flattenTopBegins(classify(desugar(parseSexprs(source))).forms));
      const resolveRequire = (specifier: string): RequireResolution => {
        const target = resolveSpecifier(relPath, specifier);
        if (!Object.hasOwn(files, target)) {
          return { kind: "unresolved", reason: `— "${target}" is not a file in this project` };
        }
        const shape = shapes.get(target);
        if (shape === undefined) {
          return { kind: "unresolved", reason: `— "${target}" was not compiled (a require cycle or an upstream .prompt/.json gap; see its own warning)` };
        }
        return { kind: "resolved", importPath: importSpecifierBetween(relPath, target), shape };
      };
      const runtimeImportPath = importSpecifierBetween(relPath, `${stage0Basename}.ts`);
      const compiled = compileScmModule(source, { baseRegistry }, { path: relPath, resolveRequire, runtimeImportPath, isPipeline });
      shapes.set(relPath, compiled.shape);
      outFiles.push({ path: outPathFor(relPath), content: compiled.content });
      for (const m of compiled.warnings) warnings.push({ path: relPath, message: m });
    }
  } finally {
    await session.dispose();
  }

  outFiles.push({ path: `${stage0Basename}.ts`, content: loadStage0Source() });

  return { files: outFiles, warnings };
}
