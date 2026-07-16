/**
 * `inhuman build` — shared vocabulary for the build-emitter surface
 * (`docs/working-proposals/inhuman-build-cli.md`). Pure types; no logic.
 */

/** What a compiled sibling actually offers a `(require …)` site: the module face
 *  (named exports, always populated for a `.scm` file's top-level defines) and
 *  whether a program face exists at all (a `.json`/`.yaml`/`.txt` always has one —
 *  the whole value; a `.scm` file has one iff it ends in a non-define expression;
 *  a pipeline's program face is the parameterized function itself). */
export interface ExportShape {
  readonly named: readonly string[];
  readonly hasDefault: boolean;
}

/** One compiled output file, ready to write to disk. `path` is OUTPUT-relative
 *  (mirrors the source's relative path, extension swapped to `.ts`). */
export interface BuildFile {
  readonly path: string;
  readonly content: string;
}

/** A non-fatal build-time note — a file this build couldn't fully handle (the
 *  `.prompt` gap), a require that didn't resolve, a dependency cycle. Surfaced to
 *  the CLI as warnings, never silently dropped (errors-as-doors: teach, don't ban). */
export interface BuildWarning {
  readonly path: string;
  readonly message: string;
}

export interface BuildResult {
  readonly files: readonly BuildFile[];
  readonly warnings: readonly BuildWarning[];
}

/** How a required sibling resolves, from the requiring file's point of view.
 *  `resolveRequire` (project.ts) computes this per `(require "…")` specifier,
 *  using the already-compiled dependency's recorded {@link ExportShape}. */
export type RequireResolution =
  | {
      readonly kind: "resolved";
      /** The relative import specifier THIS file should use, e.g. `"./metric.js"`. */
      readonly importPath: string;
      readonly shape: ExportShape;
    }
  | { readonly kind: "unresolved"; readonly reason: string };

export interface CompileFileOptions {
  /** This file's own project-relative path (diagnostics + require resolution). */
  readonly path: string;
  /** Resolve one `(require "…")` specifier (as written in THIS file) against the
   *  project's already-compiled dependency shapes. */
  readonly resolveRequire: (specifier: string) => RequireResolution;
  /** Relative import specifier this file should use to reach the copied stage-0
   *  runtime module (e.g. `"./stage0.js"`, or `"../stage0.js"` when nested). */
  readonly runtimeImportPath: string;
  /** v0's pipeline classification (design doc §3): true ⇒ the WHOLE file becomes
   *  `export default async function run(params = {}) { … }` (thunked, every
   *  `define/overridable` lifted to the env-chained params cone); false ⇒ ordinary
   *  module face (named exports) plus, if the file ends in a trailing expression,
   *  a PLAIN (eager) `export default`. */
  readonly isPipeline: boolean;
}

export interface CompileFileResult {
  readonly content: string;
  readonly shape: ExportShape;
  readonly warnings: readonly string[];
}
