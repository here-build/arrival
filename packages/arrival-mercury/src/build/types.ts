/**
 * `inhuman build` — shared vocabulary for the build-emitter surface
 * (`docs/working-proposals/inhuman-build-cli.md`, `docs/working-proposals/
 * inhuman-build-cli-dx.md`). Pure types; no logic.
 */
import type { Span } from "../coreform/types.js";

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

/** Stable, namespaced build-warning identities (the DX memo's item 4: the
 *  field-prov "code is the identity" discipline extended to the build wire) —
 *  a CLOSED union, never a bare string minted ad hoc at a call site. Each is
 *  documented at its one minting site (`project.ts`/`scm-module.ts`). */
export type BuildWarningCode =
  /** A project file whose extension v0 doesn't recognize at all (`project.ts`'s
   *  main loop) — never compiled, never even parsed. */
  | "build/unrecognized-ext"
  /** A `.prompt` file itself, encountered directly (`project.ts`'s main loop) —
   *  the documented v0 STOP (phase-1 dotprompt→scheme isn't a pure function
   *  yet). Never carries a span: a `.prompt` file is never parsed as CoreForm,
   *  so there is no node to point at. */
  | "build/prompt-unsupported"
  /** A `(require "…")` whose target IS a `.prompt` file — the SAME gap as
   *  `build/prompt-unsupported`, viewed from the require site, which DOES have
   *  a real CoreForm `Require` node (and therefore a real span) even though its
   *  target never compiled. */
  | "build/prompt-phase1-gap"
  /** A `(require "…")` that didn't resolve to a compiled sibling for any OTHER
   *  reason — dangling (no such file in the project), or the target itself
   *  never got a shape recorded (an upstream cycle/data-parse-error). */
  | "build/unresolved-require"
  /** A cycle in the require graph (`project.ts`'s `topoSort`). No span: the
   *  detecting frame sees the REVISITED node, not the specific requiring
   *  statement in some ancestor's source — see this lane's report for why a
   *  span here would misattribute a byte offset to the wrong file's text. */
  | "build/require-cycle"
  /** A bare, spilling `(require "x.scm")` whose target declares no top-level
   *  defines — nothing to import. */
  | "build/require-no-exports"
  /** A bound/inline `(require "x.scm")` whose target has no program-face value
   *  (ends in defines only) — nothing to import as a value. */
  | "build/require-no-default"
  /** Two requires in the same file would bind the same local/exported name;
   *  the earlier one wins, the later is dropped. */
  | "build/require-name-collision"
  /** A `define/overridable`'s fn-shorthand form — v0 does not lift a
   *  function-bodied overridable into the pipeline's params cone; it compiles
   *  un-lifted, un-parameterized. */
  | "build/overridable-fn-shorthand-unlifted"
  /** A `.json`/`.yaml`/`.txt` file that failed to parse. No span: a data-file
   *  parse error has no CoreForm position (see this lane's report). */
  | "build/data-parse-error";

/** A non-fatal build-time note — a file this build couldn't fully handle (the
 *  `.prompt` gap), a require that didn't resolve, a dependency cycle. Surfaced to
 *  the CLI as warnings, never silently dropped (errors-as-doors: teach, don't ban).
 *  `code` is the stable identity (DX memo item 4); `span` is the `.scm` SOURCE
 *  position of the responsible CoreForm node — present whenever one genuinely
 *  exists, omitted (never fabricated) for file-level notes that predate any
 *  parse (DX memo item 2: "thread line:col through", honestly, not invented). */
export interface BuildWarning {
  readonly path: string;
  readonly code: BuildWarningCode;
  readonly message: string;
  readonly span?: Span;
}

/** A `BuildWarning` minus `path` — every per-file compiler (`scm-module.ts`,
 *  `data-module.ts`) already knows its OWN path from `CompileFileOptions.path`/
 *  the data-file caller's `relPath`, so its own warnings never repeat it; the
 *  project-level caller (`project.ts`) stamps `path` on the way into the
 *  returned `BuildResult.warnings`. */
export type PendingWarning = Omit<BuildWarning, "path">;

export interface BuildResult {
  readonly files: readonly BuildFile[];
  readonly warnings: readonly BuildWarning[];
  /** Project-relative INPUT paths that produced no compiled output at all —
   *  an unrecognized extension, a `.prompt` file (always, v0), or a data file
   *  whose parse threw. Distinct from a "door" (`project.ts`'s doors/skipped
   *  split, DX memo item 1): a door is a gap INSIDE a file that still compiled;
   *  a skip is a whole file that never did. */
  readonly skippedFiles: readonly string[];
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
  | {
      readonly kind: "unresolved";
      /** Which {@link BuildWarningCode} the requiring file's own warning should
       *  carry — `resolveRequire` already knows WHY resolution failed (dangling
       *  vs. an upstream `.prompt` gap vs. some other uncompiled sibling), so it
       *  picks the code once, at the source of truth, rather than making
       *  `scm-module.ts` re-derive it from prose. */
      readonly code: BuildWarningCode;
      readonly reason: string;
    };

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
  readonly warnings: readonly PendingWarning[];
}
