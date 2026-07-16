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

import type { Span } from "../coreform/types.js";
import { classify } from "../coreform/classify.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { greenfieldRegistryFor, openOracleSession } from "../oracle/harness.js";
import { defaultClassifier, type ClassifyFile } from "./classify.js";
import { compileDataFile, DATA_EXTENSIONS } from "./data-module.js";
import { foldOverridableExports, type FlowedUpOverridable, type OverridableExport } from "./overridable.js";
import { flattenTopBegins, hasProgramFace, scanRequires } from "./require-scan.js";
import { aliasFromPath, compileScmModule } from "./scm-module.js";
import type { BuildFile, BuildResult, BuildWarning, ExportShape, PendingWarning, RequireResolution } from "./types.js";

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

/** One resolved `(require …)` edge: `target` is the dependency's relPath,
 *  `span` is the SOURCE POSITION (in the REQUIRING file, `relPath`, not
 *  `target`) of the FIRST require statement that names it — first-encounter
 *  order, mirroring require-scan.ts's own convention (§4.2's "first
 *  occurrence is the one that's named"). Kept alongside `target` (not
 *  discarded, v0's original shape) so `topoSort` can attribute a require
 *  cycle to the ANCESTOR's own closing statement (TASK #84) instead of the
 *  revisited node. */
interface RequireEdge {
  readonly target: string;
  readonly span: Span;
}

interface FileInfo {
  readonly relPath: string;
  readonly ext: string;
  /** Resolved dependency edges this `.scm` file requires — ONLY targets that
   *  exist among the project's own files (a dangling require is a per-file
   *  `resolveRequire` warning at compile time, not a graph edge). Empty for
   *  every non-`.scm` file (data/`.prompt` files have no requires of their
   *  own). */
  readonly deps: readonly RequireEdge[];
  /** Only meaningful for `.scm` — does this file's own flattened top-level
   *  forms end in a genuine program-face expression (require-scan.ts's
   *  `hasProgramFace`)? Computed here, from the SAME parse `deps` already
   *  needed, so `classify.ts`'s default classifier never re-parses a file it
   *  has already been parsed once for (TASK #87). `false` for every
   *  non-`.scm` file. */
  readonly hasProgramFace: boolean;
  /** This file's OWN top-level `define/overridable` names (cleaned, bare —
   *  pre-collision), from the SAME parse — seeds a pipeline's flow-up
   *  collision check (TASK #87 Q2) with names that must NEVER be
   *  namespaced away, since they're the pipeline's own pre-existing,
   *  already-shipped signature. Empty for every non-`.scm` file. */
  readonly localOverridableNames: readonly string[];
}

/** Parse `source` exactly ONCE and extract every project-graph fact
 *  `project.ts` needs about it: its resolved require edges (with span, for
 *  TASK #84's honest cycle attribution), whether it has a program face, and
 *  its own local overridable names (for TASK #87 Q2's collision seeding) —
 *  replacing three separate re-parses of the same file (`scanScmDeps`'s own
 *  parse, the old inline `isPipeline` re-parse, and a hypothetical fourth
 *  for overridable names) with one. */
function analyzeScmFile(relPath: string, source: string, files: Readonly<Record<string, string>>): Omit<FileInfo, "relPath" | "ext"> {
  const forms = flattenTopBegins(classify(desugar(parseSexprs(source))).forms);
  const uses = scanRequires(forms);
  const depsByTarget = new Map<string, Span>();
  for (const use of uses) {
    const target = resolveSpecifier(relPath, use.node.path);
    if (Object.hasOwn(files, target) && !depsByTarget.has(target)) depsByTarget.set(target, use.node.span);
  }
  const deps: RequireEdge[] = [...depsByTarget].map(([target, span]) => ({ target, span }));
  return {
    deps,
    hasProgramFace: hasProgramFace(forms),
    localOverridableNames: foldOverridableExports(forms).map((o) => o.name),
  };
}

/**
 * DFS post-order topological sort — leaves first (a file's own deps are
 * compiled, and their `shape`s known, before it is). TASK #84's ruling on the
 * v0.1 finding: a require cycle is honestly a LOADER question, not a graph
 * one — a lazy-reference cycle (this cycle's closing require is never
 * evaluated at module-eval time, only referenced) is legal in ESM the same
 * way it's legal here; a true VALUE cycle (the closing require's result is
 * actually NEEDED before either side finishes initializing) is a real error.
 * Scheme `require` is run-once-spill (module-cache semantics — design doc
 * §3), so this compiler cannot, in general, tell which case a given cycle is
 * WITHOUT running it; v0's chosen semantics (kept, unchanged by this lane):
 * **compile both files, let the SECOND-to-resolve side's specific closing
 * require report unresolved** (`resolveRequire`, in `buildProject`'s main
 * loop, below — a real, per-file, span-accurate `build/unresolved-require`
 * on whichever side actually needed the not-yet-compiled sibling) — never a
 * hard failure, since a cycle whose closing reference is never actually
 * evaluated (e.g. spilled but unused, or only referenced inside a function
 * body called later) would otherwise door a program that runs FINE. This
 * function's OWN job is narrower: name the cycle SHAPE itself, honestly.
 *
 * Every node in `infos` still reaches its own `inStack.delete`/`order.push`
 * once its (partial) DFS subtree returns — a 2-file mutual cycle still
 * compiles BOTH files; nothing is excluded here.
 *
 * TASK #84's span fix: the cycle check moved from "top of visit()" (which
 *  only ever sees the REVISITED node — no CoreForm site of its own to point
 *  at) to the LOOP that's ABOUT TO RECURSE — at that point `relPath` is the
 *  ANCESTOR file whose OWN `(require …)` statement closes the loop, and
 *  `dep.span` is that statement's REAL, exact position (threaded through
 *  from `analyzeScmFile`'s parse) — never a fabricated or misattributed one.
 */
function topoSort(infos: ReadonlyMap<string, FileInfo>, warnings: BuildWarning[]): string[] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const order: string[] = [];
  const visit = (relPath: string, chain: readonly string[]): void => {
    if (visited.has(relPath)) return;
    const info = infos.get(relPath);
    if (info === undefined) return;
    inStack.add(relPath);
    for (const dep of info.deps) {
      if (inStack.has(dep.target)) {
        // `relPath` (the CURRENT frame — an ANCESTOR of `dep.target` in this
        // DFS) has a require statement, at `dep.span`, that closes a loop
        // back to `dep.target`, which is still mid-compile on the stack.
        warnings.push({
          path: relPath,
          span: dep.span,
          code: "build/require-cycle",
          message: `require cycle: ${[...chain, relPath, dep.target].join(" → ")} — this (require "${dep.target}") closes the loop; both files still compile, but whichever side resolves second will report ITS OWN closing require as unresolved (see that file's own build/unresolved-require)`,
        });
        continue; // don't recurse back into the cycle — already on the stack
      }
      visit(dep.target, [...chain, relPath]);
    }
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
  /** TASK #87 — the pluggable file-classification seam (`classify.ts`).
   *  Omitted ⇒ `defaultClassifier`, built from this project's own require-DAG
   *  facts (v0's exact "DAG-root + program-face" derivation, unchanged). A
   *  project supplies its own to opt out of that derivation entirely (e.g.
   *  `pipelinesDirClassifier` — the CLI resolves `inhuman.config.json`'s
   *  `build.classifier` to a value of this type before calling in). */
  readonly classifyFile?: ClassifyFile;
}

/** The project-root-anchored form of `relPath` — `classify.ts`'s `absPath`
 *  argument, reusing `resolveSpecifier`'s OWN "a leading `/` means root-
 *  relative" vocabulary rather than inventing a second notion of "absolute"
 *  (never a real OS path — this stays pure). */
function rootAnchored(relPath: string): string {
  return `/${relPath}`;
}

/** BFS over `infos`' require-DAG from `startRelPath` (EXCLUDING itself),
 *  collecting every reachable dependency's OWN published overridables
 *  (`ExportShape.overridables`) — TASK #87 Q2's "transitive knob cone". A
 *  dependency that never got a recorded `shape` (an upstream cycle/data-
 *  parse-error/`.prompt` gap) contributes nothing — an already-warned gap
 *  elsewhere, not a new failure here. `visited` guards a diamond dependency
 *  from being counted twice and a require CYCLE from looping forever
 *  (mirrors `topoSort`'s own revisit guard; breadth-first since only
 *  REACHABILITY — not compile order — matters here). */
function collectOverridableCone(
  startRelPath: string,
  infos: ReadonlyMap<string, FileInfo>,
  shapes: ReadonlyMap<string, ExportShape>,
): { readonly sourceRelPath: string; readonly entry: OverridableExport }[] {
  const visited = new Set<string>([startRelPath]);
  const queue: string[] = (infos.get(startRelPath)?.deps ?? []).map((d) => d.target);
  const out: { sourceRelPath: string; entry: OverridableExport }[] = [];
  while (queue.length > 0) {
    const relPath = queue.shift()!;
    if (visited.has(relPath)) continue;
    visited.add(relPath);
    const shape = shapes.get(relPath);
    if (shape !== undefined) for (const entry of shape.overridables) out.push({ sourceRelPath: relPath, entry });
    for (const dep of infos.get(relPath)?.deps ?? []) queue.push(dep.target);
  }
  return out;
}

/** Resolve each cone entry's EXPOSED key (design doc Q2: "metric.threshold
 *  style" — namespaced ONLY on collision, bare otherwise). `localNames` seeds
 *  the taken-set with the PIPELINE's OWN local overridable names (unchanged,
 *  always bare — see overridable.ts) so a same-named MODULE knob is the one
 *  that gets namespaced, never the reverse. First-encounter order (the
 *  cone's own BFS order, from `collectOverridableCone`) decides which of
 *  several SAME-named module knobs stays bare when more than one collides —
 *  mirrors require-scan's own "first encounter wins" convention. Returns the
 *  resolved list PLUS any `build/overridable-flow-up-*` notes (the caller
 *  stamps `path`, matching every other per-file warning list in this file). */
function resolveFlowUp(
  cone: readonly { readonly sourceRelPath: string; readonly entry: OverridableExport }[],
  localNames: ReadonlySet<string>,
): { readonly overridables: FlowedUpOverridable[]; readonly warnings: PendingWarning[] } {
  const taken = new Set(localNames);
  const overridables: FlowedUpOverridable[] = [];
  const warnings: PendingWarning[] = [];
  for (const { sourceRelPath, entry } of cone) {
    let exposedKey = entry.name;
    if (taken.has(exposedKey)) {
      exposedKey = `${aliasFromPath(sourceRelPath)}.${entry.name}`;
      warnings.push({
        code: "build/overridable-flow-up-namespaced",
        message: `"${entry.name}" (from "${sourceRelPath}") collided with an existing knob name in this pipeline's cone — exposed as "${exposedKey}" instead`,
      });
    }
    taken.add(exposedKey);
    if (entry.defaultLit === undefined) {
      warnings.push({
        code: "build/overridable-flow-up-nonliteral-default",
        message: `"${exposedKey}" (from "${sourceRelPath}") declares a non-literal default — the flowed-up param falls back to undefined rather than re-deriving the computed value across the require boundary`,
      });
    }
    overridables.push({ exposedKey, envKey: entry.envKey, tag: entry.tag, defaultLit: entry.defaultLit });
  }
  return { overridables, warnings };
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
  // Project-relative INPUT paths that end up with NO compiled output at all —
  // the CLI's "skipped" count (DX memo item 1), kept as a direct structural
  // fact (every `continue` below that never reaches an `outFiles.push`) rather
  // than inferred after the fact from warning codes, which would have to
  // special-case "a warning on a file that also never compiled" vs. "a warning
  // on a require site whose OWN file still compiled fine" (see `resolveRequire`
  // below for exactly that second case).
  const skippedFiles: string[] = [];

  const infos = new Map<string, FileInfo>();
  for (const [relPath, content] of Object.entries(files)) {
    const ext = extOf(relPath);
    if (ext === SCM_EXT) {
      infos.set(relPath, { relPath, ext, ...analyzeScmFile(relPath, content, files) });
    } else if (DATA_EXTENSIONS.has(ext) || ext === PROMPT_EXT) {
      infos.set(relPath, { relPath, ext, deps: [], hasProgramFace: false, localOverridableNames: [] });
    } else {
      warnings.push({
        path: relPath,
        code: "build/unrecognized-ext",
        message: `unrecognized file type "${ext || "(none)"}" — v0 handles .scm/.prompt/.json/.yaml/.yml/.txt; skipped`,
      });
      skippedFiles.push(relPath);
    }
  }

  const order = topoSort(infos, warnings);

  // TASK #87: the file-classification seam (`classify.ts`). `requiredBy`/
  // `hasProgramFaceOf` are whole-project facts ONLY `defaultClassifier` needs
  // (a per-file policy structurally cannot see them) — computed once here,
  // regardless of whether they end up used, since a project's OWN classifier
  // (`opts.classifyFile`) may ignore them entirely (that's the point: a
  // pipeline's classification no longer HAS to depend on whether something
  // else requires it).
  const requiredBy = new Set<string>();
  for (const info of infos.values()) for (const dep of info.deps) requiredBy.add(dep.target);
  const hasProgramFaceOf = new Map<string, boolean>();
  for (const info of infos.values()) hasProgramFaceOf.set(info.relPath, info.hasProgramFace);
  const classifyFile: ClassifyFile = opts?.classifyFile ?? defaultClassifier(requiredBy, hasProgramFaceOf);

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
        // which is a real (visible) build warning, never a silent gap. No
        // span: a `.prompt` file is never parsed as CoreForm at all (that IS
        // the gap), so there is no node to point at — `build/prompt-phase1-gap`
        // (on the REQUIRING file's own require site, below) carries the real,
        // CoreForm-anchored position instead.
        warnings.push({
          path: relPath,
          code: "build/prompt-unsupported",
          message:
            ".prompt compilation is not implemented in this build (v0 STOP item — the phase-1 dotprompt→scheme step is embedded in a live EnvCapability's ContentResolver, not a pure function; see the lane report). Requiring this file will door at build/run time.",
        });
        skippedFiles.push(relPath);
        continue;
      }

      if (DATA_EXTENSIONS.has(info.ext)) {
        try {
          const compiled = compileDataFile(info.ext, source, relPath);
          shapes.set(relPath, compiled.shape);
          outFiles.push({ path: outPathFor(relPath), content: compiled.content });
          for (const w of compiled.warnings) warnings.push({ path: relPath, ...w });
        } catch (e) {
          warnings.push({
            path: relPath,
            code: "build/data-parse-error",
            message: e instanceof Error ? e.message : String(e),
          });
          skippedFiles.push(relPath);
        }
        continue;
      }

      // .scm — TASK #87: the classifier seam decides pipeline vs module (the
      // ambiguity v0's own DAG-root+program-face detector got fuzzy — data
      // files stay extension-routed above, unambiguous either way, so the
      // seam's ONLY job here is the split that actually needed one).
      const isPipeline = classifyFile(relPath, rootAnchored(relPath)) === "pipeline";

      // TASK #87 Q2: a pipeline's params cone is the TRANSITIVE knob set —
      // every overridable reachable through its own require-DAG, collision-
      // resolved against its OWN local overridable names (unchanged, always
      // bare). A module face never computes this (empty, the default).
      let flowedUpOverridables: readonly FlowedUpOverridable[] = [];
      if (isPipeline) {
        const cone = collectOverridableCone(relPath, infos, shapes);
        const resolved = resolveFlowUp(cone, new Set(info.localOverridableNames));
        flowedUpOverridables = resolved.overridables;
        for (const w of resolved.warnings) warnings.push({ path: relPath, ...w });
      }

      const resolveRequire = (specifier: string): RequireResolution => {
        const target = resolveSpecifier(relPath, specifier);
        if (!Object.hasOwn(files, target)) {
          return { kind: "unresolved", code: "build/unresolved-require", reason: `— "${target}" is not a file in this project` };
        }
        const shape = shapes.get(target);
        if (shape === undefined) {
          // The target IS a project file, just never got a recorded shape —
          // either it's a known, named gap (`.prompt`, v0's STOP item — give
          // it its OWN code so a caller can filter on "the prompt gap"
          // specifically) or some other upstream failure (cycle/data-parse).
          const code = extOf(target) === PROMPT_EXT ? "build/prompt-phase1-gap" : "build/unresolved-require";
          const why = extOf(target) === PROMPT_EXT ? "the .prompt phase-1 gap" : "a require cycle or an upstream data-parse-error";
          return { kind: "unresolved", code, reason: `— "${target}" was not compiled (${why}; see its own warning)` };
        }
        return { kind: "resolved", importPath: importSpecifierBetween(relPath, target), shape };
      };
      const runtimeImportPath = importSpecifierBetween(relPath, `${stage0Basename}.ts`);
      const compiled = compileScmModule(source, { baseRegistry }, { path: relPath, resolveRequire, runtimeImportPath, isPipeline, flowedUpOverridables });
      shapes.set(relPath, compiled.shape);
      outFiles.push({ path: outPathFor(relPath), content: compiled.content });
      for (const w of compiled.warnings) warnings.push({ path: relPath, ...w });
    }
  } finally {
    await session.dispose();
  }

  outFiles.push({ path: `${stage0Basename}.ts`, content: loadStage0Source() });

  return { files: outFiles, warnings, skippedFiles };
}
