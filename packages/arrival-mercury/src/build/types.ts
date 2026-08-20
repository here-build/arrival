/**
 * `inhuman build` — shared vocabulary for the build-emitter surface
 * (`docs/working-proposals/inhuman-build-cli.md`, `docs/working-proposals/
 * inhuman-build-cli-dx.md`). Pure types; no logic.
 */
import type { Span } from "../coreform/types.js";
import type { FlowedUpOverridable, OverridableExport } from "./overridable.js";

/**
 * One top-level module-face export: a `scheme`/`js` coherence pair. `scheme` is the
 * RAW scheme identifier (`"over-threshold?"`) exactly as written in the
 * source: this is the ONLY spelling an importing file's own source ever uses
 * (`(over-threshold? …)`), so it is also the registry-overlay KEY
 * `scm-module.ts`'s `buildRequireMachinery` binds a spilled import under —
 * `require` spills scheme names into scope VERBATIM, there is no
 * import-renaming syntax at the language level. `js` is the ACTUAL, allocated
 * JS identifier the exporting module's own compiled body binds that define
 * to — read directly off the walked tree's own `Binding.text` post-allocation
 * (`naming/allocate.ts`'s census→allocate→materialize phase, run inside
 * `walk()`), NEVER re-derived by an independent `cleanName` call out here
 * (which could disagree with the allocator's own collision-resolved pick —
 * e.g. a predicate `foo?` yielding `isFoo` instead of `foo` to a co-scoped
 * plain `foo` binding — naming/allocate.ts's `declaredCandidates`). `js` is
 * what BOTH the export list (`export { js }`) and every importer's import
 * list (`import { js } from "…"`) print — the identical string, by
 * construction, never cleaned twice.
 */
export interface NamedExport {
  readonly scheme: string;
  readonly js: string;
}

/** What a compiled sibling actually offers a `(require …)` site: the module face
 *  (named exports, always populated for a `.scm` file's top-level defines) and
 *  whether a program face exists at all (a `.json`/`.yaml`/`.txt` always has one —
 *  the whole value; a `.scm` file has one iff it ends in a non-define expression;
 *  a pipeline's program face is the parameterized function itself). */
export interface ExportShape {
  readonly named: readonly NamedExport[];
  /** The default export's calling convention, or absent when there is no
   *  default at all. `"function"` — every compiled `.scm` program face
   *  (reference-program-face-always-function: the artifact exports an
   *  on-demand callable, NEVER an eager value; the value/function boundary
   *  lives at the consumer, which CALLS `.default()`). `"value"` — a data
   *  file's literal default (`data-module.ts`), which has no program to
   *  defer and is read directly. This bit is what lets the require
   *  machinery (`scm-module.ts`) emit the right consumption — a call for a
   *  program, a bare reference for data — instead of guessing from a
   *  boolean (the pre-ruling `hasDefault` shape, which bound a pipeline's
   *  `run` FUNCTION where the interpreter's `require` yields its VALUE). */
  readonly defaultFace?: "value" | "function";
  /** Only meaningful when `defaultFace` is `"function"`: does calling the
   *  default yield a promise (the compiled face came out `async` after
   *  asyncness materialization)? The requiring side awaits the run-once
   *  const it mints iff this is set — threaded here because the consumer
   *  cannot see the sibling's emitted `async` keyword, only its shape. */
  readonly defaultAsync?: boolean;
  /** This file's OWN top-level `define/overridable`s, folded to a portable
   *  triple — `project.ts`'s cone walk unions these across the
   *  WHOLE transitive require-graph reachable from an entry pipeline, so its
   *  signature is the transitive knob set, not just its own file's. Always
   *  populated (module or pipeline face alike), even when nothing ever
   *  requires this file. */
  readonly overridables: readonly OverridableExport[];
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
  /** A host-pretreat file failed convert→scheme or scm compile (`project.ts`).
   *  Never carries a span: pretreat input is not user CoreForm. */
  | "build/pretreat-unsupported"
  /** A `.hbs` file failed pure convert→scheme or scm compile. */
  | "build/hbs-unsupported"
  /** A `(require "…")` whose pretreat target failed convert/compile — same gap
   *  as `build/pretreat-unsupported`, from the require site (has a CoreForm span). */
  | "build/pretreat-gap"
  /** A `(require "…")` that didn't resolve to a compiled sibling for any OTHER
   *  reason — dangling (no such file in the project), or the target itself
   *  never got a shape recorded (an upstream cycle/data-parse-error). */
  | "build/unresolved-require"
  /** A cycle in the require graph (`project.ts`'s `topoSort`). `path`
   *  + `span` name the ANCESTOR file's own closing `(require …)` statement —
   *  the one whose target is still mid-compile on the DFS stack — never the
   *  REVISITED node (which has no CoreForm site of its own for this warning
   *  to point at; see `topoSort`'s own doc for the full reasoning). */
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
   *  function-bodied overridable into the params cone (pipeline OR module
   *  face); it compiles un-lifted, un-parameterized. */
  | "build/overridable-fn-shorthand-unlifted"
  /** A `.json`/`.yaml`/`.txt` file that failed to parse. No span: a data-file
   *  parse error has no CoreForm position (see this lane's report). */
  | "build/data-parse-error"
  /** A flowed-up overridable's bare name collided (with the
   *  entry pipeline's own local overridable names, or with another cone
   *  entry's) and was namespaced `<moduleAlias>.<name>` instead. No span: the
   *  collision is a whole-project fact (`project.ts`'s cone walk), not one
   *  CoreForm site's — attached to the entry pipeline's own path. */
  | "build/overridable-flow-up-namespaced"
  /** A flowed-up overridable's declared default (in the
   *  REQUIRING file, not the one that declared it) wasn't a plain literal —
   *  it still gets a full explicit-arg/env chain, only the innermost
   *  fallback becomes `undefined` rather than silently re-deriving a value
   *  this lane has no re-lowering machinery for. No span, same reason as
   *  `build/overridable-flow-up-namespaced`. */
  | "build/overridable-flow-up-nonliteral-default";

/** A non-fatal build-time note — a file this build couldn't fully handle (a
 *  pretreat gap), a require that didn't resolve, a dependency cycle. Surfaced to
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
   *  an unrecognized extension, a pretreat/hbs failure, or a data file
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
       *  vs. an upstream pretreat gap vs. some other uncompiled sibling), so it
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
  /** Which classifier verdict this file got: `"pipeline"` ⇒ the
   *  WHOLE file becomes `export default function run(params = {}) { … }`
   *  (thunked, every `define/overridable` lifted to the env-chained params
   *  cone, PLUS the transitive flow-up cone below — `params`'s own declared
   *  `= {}` default, `scm-module.ts`'s `withParamsDefault`, means calling the
   *  emitted function with zero arguments — the common case, every knob
   *  resolving from env/default — is never an arity error); `"module"`
   *  ⇒ ordinary module face (named exports) plus, if the file ends in a
   *  trailing expression, `export default function Main() { … }` — the
   *  program face is ALWAYS an on-demand callable, never an eager value
   *  (reference-program-face-always-function); its OWN local overridables
   *  still get a real (params-less) env-chain. */
  readonly isPipeline: boolean;
  /** The pipeline's TRANSITIVE overridable cone: every
   *  overridable reachable via the require-graph from this file, already
   *  collision-resolved (`project.ts`'s cone walk — see `FlowedUpOverridable`'s
   *  own doc for the namespacing rule). Empty when `isPipeline` is false;
   *  `project.ts` never computes this for a module face. Optional (defaults
   *  to empty) so a direct `compileScmModule` caller need not pass it. */
  readonly flowedUpOverridables?: readonly FlowedUpOverridable[];
}

export interface CompileFileResult {
  readonly content: string;
  readonly shape: ExportShape;
  readonly warnings: readonly PendingWarning[];
}
