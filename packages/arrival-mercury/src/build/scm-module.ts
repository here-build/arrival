/**
 * The per-`.scm`-file BUILD compiler — module-faced emission
 * composing the EXISTING greenfield pipeline (classify → extractFacts →
 * walk → materializeSharedBindings → materializeAsyncness → materializeImports
 * → render), never rewriting any of those passes. Three things this module
 * owns instead:
 *
 *  1. **The require→import rewrite** (`require-scan.ts` + this file): a
 *     `(require "…")` lowers via `walk()`'s additive `requireOf` hook (see
 *     `walker/walk.ts`) to a reference against an `Import` decl THIS module
 *     hoists — resolved by REQUIRE PATH, never by CoreForm node identity, so it
 *     is indifferent to which `classify()` pass produced the node it's asked
 *     about (see this file's own `buildRequireMachinery`).
 *  2. **The export contract**: module face (every top-level
 *     define → named export, ALWAYS) and program face (a trailing non-define
 *     expression → `export default function`) — ALWAYS an on-demand callable,
 *     never an eager value. A MODULE-classified file wraps its trailing
 *     expression as `export default function Main() { … }`; a
 *     PIPELINE-classified file (`classify.ts`) exports its thunked,
 *     parameterized `run` with every `define/overridable` lifted into its
 *     env-chained params cone (`overridable.ts`) — INCLUDING every overridable
 *     transitively reachable through its own require-DAG (`project.ts`'s
 *     cone walk). A MODULE-classified file's own
 *     local overridables still resolve a real (params-less) env chain, just
 *     with no explicit-argument tier of their own. The value/function boundary
 *     lives at the CONSUMER: a requiring sibling imports the function and
 *     mints one run-once access const (`buildRequireMachinery`).
 *  3. **v0's pipeline wrap**: reusing the SAME "whole program as one synthetic
 *     function body" technique `oracle/harness.ts`'s `compileGreenfield` uses
 *     for its own (unrelated) reason — proven semantics-neutral there (a
 *     function body's tail position preserves the trailing value; body-position
 *     defines pre-register exactly like top-level ones) — parameterized instead
 *     of zero-arg, and never immediately called (the whole point is deferral:
 *     nothing may run at import time).
 */
import type { CoreForm, DefineFn, NodeId, Require, Span } from "../coreform/types.js";
import { classify } from "../coreform/classify.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { SchemeSemanticModel } from "../model/model.js";
import { maxNodeId } from "../peepholes/index.js";
import { materializeAsyncness, materializeImports, materializeSharedBindings, originOf } from "../naming/index.js";
import type { OverlayEmitRegistry, SymbolRule, SymbolRuleTable } from "../rules/overlay.js";
import { withRules } from "../rules/overlay.js";
import { inferAsyncSeeds } from "../rules/index.js";
import { render } from "../residual/render.js";
import {
  Await,
  Binding as mkBinding,
  Call,
  ConstDecl,
  Export,
  Import,
  ObjectLit,
  Ref,
  type Binding,
  type CompilationUnit,
  type Decl,
  type R,
  type TsType,
} from "../residual/types.js";
import { cleanName } from "../walker/names.js";
import { walk } from "../walker/walk.js";
import {
  foldOverridableExports,
  idMinter,
  isLiftableOverridable,
  liftFlowedUpOverridable,
  liftLocalOverridable,
  liftOverridable,
  MODULE_OVERRIDABLE_SYMBOL,
  moduleOverridableSymbolRule,
  OVERRIDABLE_SYMBOL,
  overridableSymbolRule,
  PIPELINE_PARAMS_SCHEME_NAME,
  type FlowedUpOverridable,
} from "./overridable.js";
import { flattenTopBegins, hasProgramFace, scanRequires, topLevelDefineNames, type RequireOccurrence } from "./require-scan.js";
import type { CompileFileOptions, CompileFileResult, NamedExport, PendingWarning } from "./types.js";

export interface ScmCompileDeps {
  /** The shared base registry — `greenfieldRegistryFor(session)` from
   *  `oracle/harness.ts`, ONE per build (session assembly is the expensive
   *  part). This file only ever OVERLAYS it, never mutates it. */
  readonly baseRegistry: OverlayEmitRegistry;
}

/** Dedup a candidate binding text against everything this file has already
 *  minted for its own sibling-import/env-chain machinery. Does not (cannot)
 *  see the walker's OWN name allocation — a collision there is `--check`'s
 *  job to catch (see `overridable.ts`'s header for the same caveat). */
function makeUniqueAlias(): (base: string) => string {
  const used = new Set<string>();
  return (base: string): string => {
    const safe = base === "" ? "_" : base;
    let candidate = safe;
    let n = 2;
    while (used.has(candidate)) candidate = `${safe}_${n++}`;
    used.add(candidate);
    return candidate;
  };
}

/** A require path's basename, cleaned to a JS identifier — the alias an
 *  `"inline"` require falls back to when there's no user-chosen `define`
 *  name to borrow. Exported: `project.ts`'s cone walk reuses this EXACT
 *  alias convention to namespace a flowed-up overridable on collision
 *  (`<moduleAlias>.<name>`), so a module's own default-import alias and its
 *  knob namespace always agree. */
export function aliasFromPath(specifier: string): string {
  const base = (specifier.split("/").pop() ?? specifier).replace(/\.[^.]+$/, "");
  return cleanName(base);
}

interface RequireMachinery {
  readonly importDecls: readonly Decl[];
  /** The run-once access consts a `"function"`-faced default needs
   *  (`const metric = [await ]metricProgram();`) — kept SEPARATE from
   *  `importDecls` so the caller can print every import first, then every
   *  access const, matching how a human orders a module head (and the
   *  paradigm's imports-first materialization). */
  readonly accessDecls: readonly Decl[];
  readonly overlayTable: SymbolRuleTable;
  readonly requireOf: (node: Require) => R | undefined;
  /** The `boundName`s of every `(define x (require "…"))` that resolved. Each
   *  ALSO got a registry overlay row (below), so `x` is never lexically bound —
   *  the caller must drop the enclosing `Define` from what it hands to `walk()`,
   *  or `bindingForDefine` would mint a SECOND, competing binding for the exact
   *  same JS name (`const examples = examples;` — a TDZ self-reference; this was
   *  a real bug caught by the GEPA smoke test, not a hypothetical). */
  readonly resolvedBoundNames: ReadonlySet<string>;
  /** scheme `boundName` → the ACTUAL local JS identifier this machinery bound
   *  it to (the import alias for a `"value"` face, the run-once const for a
   *  `"function"` face). The module face's named-export list consults this for
   *  bound-require re-exports — the walked tree has no decl for them (their
   *  `Define` is dropped, see `resolvedBoundNames`), so without this map the
   *  export list could only fall back to the RAW scheme name, emitting
   *  uncompilable `export { parsed-config }` for any kebab/predicate name. */
  readonly boundJsNames: ReadonlyMap<string, string>;
  readonly warnings: PendingWarning[];
}

/**
 * Build the sibling-import machinery from a require-scan (`require-scan.ts`).
 * Resolution is keyed by `Require.path` — a plain string already ON every
 * `Require` node — never by node object identity, so this is indifferent to
 * whether the scan ran against the SAME `classify()` output `walk()` later
 * consumes or a throwaway earlier pass (this file always scans the SAME
 * `SchemeSemanticModel.coreform` it walks, but the design doesn't depend on
 * that coincidence).
 *
 * A `"bound"` require (`(define x (require "y"))`) is handled EXACTLY like a
 * `"spill"`, not like an `"inline"` one: `x` becomes a registry overlay row
 * (never a lexical binding) resolving to the default import — because `x` is
 * ALSO, structurally, a `Define` name, and `walk()`'s own `bindingForDefine`
 * would otherwise mint a SECOND binding for that same JS identifier the moment
 * the caller lets the enclosing `Define` reach `walk()` at all. The caller
 * drops that `Define` from the form list it walks (see `resolvedBoundNames`).
 */
function buildRequireMachinery(uses: readonly RequireOccurrence[], opts: CompileFileOptions): RequireMachinery {
  const importDecls: Decl[] = [];
  const accessDecls: Decl[] = [];
  // Built mutably (the exported `RequireMachinery.overlayTable` field is the
  // read-only `SymbolRuleTable` view — structurally the same object, only the
  // TYPE narrows once construction is done).
  const overlayTable: Record<string, SymbolRule> = {};
  const warnings: PendingWarning[] = [];
  const uniqueAlias = makeUniqueAlias();
  /** ONE value binding per distinct required PATH that's ever bound/inline-
   *  used — several occurrences of the same require share it (run-once,
   *  matching the interpreter's module cache). For a `"value"` face this is
   *  the default-import alias itself; for a `"function"` face it is the
   *  run-once access const (`accessDecls`) holding the called result. */
  const defaultValueOf = new Map<string, Binding>();
  const spilledPaths = new Set<string>();
  const unresolvedPaths = new Set<string>();
  const resolvedBoundNames = new Set<string>();
  const boundJsNames = new Map<string, string>();
  const bindBound = (boundName: string, binding: Binding, path: string, span: Span): void => {
    addOverlayRow(boundName, binding, `(define ${boundName} (require "${path}"))`, span);
    resolvedBoundNames.add(boundName);
    boundJsNames.set(boundName, binding.text);
  };

  // `span` is always the CURRENT `RequireOccurrence.node.span` — the specific
  // require/define statement whose name is spilling/binding `exported` — never
  // a fabricated position.
  const addOverlayRow = (exported: string, binding: Binding, context: string, span: Span): void => {
    if (Object.hasOwn(overlayTable, exported)) {
      warnings.push({
        code: "build/require-name-collision",
        span,
        message: `${context} spills/binds "${exported}", which an earlier require in this file already bound — the earlier binding wins`,
      });
      return;
    }
    overlayTable[exported] = { emit: { call: (args) => Call(Ref(binding), args), ref: () => Ref(binding) } };
  };

  for (const use of uses) {
    const path = use.node.path;
    const span = use.node.span;
    const res = opts.resolveRequire(path);
    if (res.kind === "unresolved") {
      unresolvedPaths.add(path);
      warnings.push({ code: res.code, span, message: `(require "${path}") ${res.reason}` });
      continue;
    }
    if (use.kind === "spill") {
      if (spilledPaths.has(path)) continue; // already imported this sibling's names once
      spilledPaths.add(path);
      if (res.shape.named.length === 0) {
        warnings.push({
          code: "build/require-no-exports",
          span,
          message: `(require "${path}") spills no names — "${path}" declares no top-level defines`,
        });
        continue;
      }
      // The overlay row's KEY is deliberately the RAW scheme name (`scheme`) — an
      // importing file's own `(over-threshold? …)` call site spells the scheme
      // identifier verbatim, never a cleaned JS one, so registry resolution
      // must key on it unchanged. The imported/local JS text is `js` — the
      // exporting module's own ALREADY-ALLOCATED identifier
      // (`NamedExport`'s own doc, ./types.js) — never re-cleaned here a
      // second time, so it agrees with that module's compiled body and
      // export list by construction.
      const names = res.shape.named.map(({ scheme, js }) => ({ scheme, js, local: uniqueAlias(js) }));
      for (const { scheme, local } of names) addOverlayRow(scheme, mkBinding(local), `(require "${path}")`, span);
      importDecls.push(
        Import(names.map(({ js, local }) => ({ imported: js, local: local === js ? undefined : local })), res.importPath),
      );
      continue;
    }
    // "bound" | "inline" — needs the sibling's DEFAULT (program-face) export.
    const existing = defaultValueOf.get(path);
    if (existing !== undefined) {
      // Already imported once (e.g. required both bound and inline, or bound
      // twice) — a "bound" occurrence still needs its OWN overlay row even on
      // a repeat path, since each `boundName` is a distinct scheme identifier;
      // both share the SAME value binding (run-once, module-cache semantics).
      if (use.kind === "bound") bindBound(use.boundName, existing, path, span);
      continue;
    }
    if (res.shape.defaultFace === undefined) {
      unresolvedPaths.add(path);
      warnings.push({
        code: "build/require-no-default",
        span,
        message: `(require "${path}") has no program-face value — "${path}" ends in defines only, nothing to import as a value`,
      });
      continue;
    }
    const aliasBase = use.kind === "bound" ? cleanName(use.boundName) : aliasFromPath(path);
    // `{ imported: "default", local }` renders `import { default as local } from "…"` —
    // the ES2015-legal spelling of a default import, since the Residual `Import`
    // decl (residual/types.ts) has no dedicated default-import shape (see this
    // file's header note in the project report: never modified, only composed).
    let valueBinding: Binding;
    if (res.shape.defaultFace === "function") {
      // A program face is an on-demand callable (reference-program-face-always-
      // function) — the interpreter's `require` yields the program's VALUE, so
      // the compiled site imports the function and mints ONE run-once access
      // const per path. Awaited iff the sibling's face came out async — the
      // consumer owns the value/function (and sync/async) boundary, the
      // artifact never bakes it in.
      const fnLocal = uniqueAlias(`${aliasBase}Program`);
      const fnBinding = mkBinding(fnLocal);
      importDecls.push(Import([{ imported: "default", local: fnLocal }], res.importPath));
      valueBinding = mkBinding(uniqueAlias(aliasBase));
      const call = Call(Ref(fnBinding), []);
      accessDecls.push(ConstDecl(valueBinding, res.shape.defaultAsync === true ? Await(call) : call));
    } else {
      valueBinding = mkBinding(uniqueAlias(aliasBase));
      importDecls.push(Import([{ imported: "default", local: valueBinding.text }], res.importPath));
    }
    defaultValueOf.set(path, valueBinding);
    if (use.kind === "bound") bindBound(use.boundName, valueBinding, path, span);
  }

  const requireOf = (node: Require): R | undefined => {
    if (unresolvedPaths.has(node.path)) return undefined; // fall through to the existing door
    const binding = defaultValueOf.get(node.path);
    // A spill-only path has no default binding — harmless: every call site that
    // reaches this is a bare statement position (see walk.ts's own comment),
    // so ANY non-undefined return discards cleanly. A "bound" occurrence never
    // actually reaches here either (its enclosing Define is filtered out of
    // the walked forms entirely — see `resolvedBoundNames`); this fallback
    // only serves genuine "inline" occurrences and defensive completeness.
    return binding !== undefined ? Ref(binding) : { t: "Lit", value: { k: "undefined" } };
  };

  return { importDecls, accessDecls, overlayTable, requireOf, resolvedBoundNames, boundJsNames, warnings };
}

/** The module face's program-face wrapper name — the trailing expression
 *  compiles as `(define (__main) <trailing>)`, emitted `export default
 *  function Main() { … }` (reference-program-face-always-function: the
 *  artifact exports an on-demand callable, never an eager value — same
 *  technique, and same reasoning, as `oracle/harness.ts`'s `__oracle-main`
 *  wrap). The double-underscore scheme spelling cannot collide with a user
 *  identifier's cleaned form: `cleanName("__main")` is `"Main"`, while a
 *  user's own `main` cleans to `"main"` — and even a true JS-name collision
 *  is the allocator's ordinary suffixing case, not a correctness hazard. */
const SCM_MAIN = "__main";

/** Wrap the trailing program-face form as a synthetic zero-arg `DefineFn` so
 *  the walker lowers it as a real function body (tail position preserved,
 *  asyncness landing INSIDE the function instead of as a top-level await) —
 *  BEFORE `walk()` runs, never a post-pass over emitted output. */
function wrapTrailingAsMain(forms: readonly CoreForm[], id: () => NodeId): CoreForm[] {
  const last = forms.at(-1);
  if (last === undefined) {
    throw new Error("scm-module: expected a trailing program-face form — found none (internal invariant)");
  }
  const wrapper: DefineFn = { kind: "DefineFn", id: id(), span: last.span, name: SCM_MAIN, params: [], body: [last] };
  return [...forms.slice(0, -1), wrapper];
}

/** Mark the face's own FnDecl as the module's default export — the ONE decl
 *  whose scheme-name origin is `mainName` (the synthetic `__main`, or the
 *  pipeline wrapper's `run`). Post-`walk()`, pre-materialization; every
 *  naming pass spread-rebuilds decls, so the flag survives to `render()`. */
function exportMainAsDefault(unit: CompilationUnit, mainName: string): CompilationUnit {
  const decls = unit.decls.map((d) =>
    d.t === "FnDecl" && originOf(d.name)?.text === mainName ? { ...d, exported: "default" as const } : d,
  );
  return { ...unit, decls };
}

/** The params-cone parameter's own annotation — `Record<string, any>`.
 *  Threaded in ALONGSIDE the `= {}` default (below): a bare `= {}` with no
 *  annotation makes TypeScript INFER the parameter's type as the empty object
 *  type `{}`, which has no index signature — so `inhumanParams.greeting`
 *  (every knob read) becomes `Property 'greeting' does not exist on type
 *  '{}'` under `--check`. The un-defaulted parameter was implicitly `any`
 *  before (the emitted tsconfig runs `noImplicitAny: false`), so every knob
 *  read typechecked freely — including the ones that FLOW ONWARD into a typed
 *  position: `(inhumanParams.factor ?? …) * x`, `inhumanParams.threshold +
 *  overLimit(…)`. `Record<string, unknown>` restores index ACCESS but NOT that
 *  onward flow (`unknown` is not an arithmetic operand — "left-hand side of an
 *  arithmetic operation must be of type 'any'/'number'/…"), so the honest
 *  restatement of the old implicit-`any` contract is `Record<string, any>`: a
 *  bag of knobs indexable by any key (bare `inhumanParams.greeting` OR
 *  bracketed `inhumanParams["metric.threshold"]`, the flow-up namespaced form)
 *  whose values stay `any` — exactly what a non-strict emitted
 *  project (build.ts's `emittedTsconfig`: `strict:false`/`noImplicitAny:false`,
 *  type-emit not yet wired) already runs on everywhere else. The `any` value
 *  rides the EXISTING `ref` carrier (the same shape `naming/asyncness.ts` emits
 *  `Promise<T>` through) — no new `TsType` variant, no residual-algebra change. */
const PARAMS_CONE_TYPE: TsType = { k: "ref", name: "Record", args: [{ k: "prim", name: "string" }, { k: "ref", name: "any" }] };

/**
 * The pipeline wrapper's own params-parameter needs a declared `= {}`
 * default (`async function run(inhumanParams = {}) {…}`) — without it, the
 * common zero-arg call `run()` (every knob resolving from env/default) is a
 * real arity/type error under `--check`, since the walker itself never
 * annotates a params-parameter with one. `compilePipelineFace`'s `walk()`
 * call always lowers EXACTLY one top-level form (`forms: [wrapper]` — the
 * whole file becomes one synthetic
 * `DefineFn`, this file's own header), so `unit.decls` has EXACTLY one
 * `FnDecl` at this point — the wrapper's own — with EXACTLY one param
 * (`PIPELINE_PARAMS_SCHEME_NAME`).
 *
 * Sets BOTH the `= {}` default AND the `Record<string, unknown>` annotation
 * (`PARAMS_CONE_TYPE`'s own doc for why the annotation is load-bearing, not
 * cosmetic). The annotation is only added when the param carries none of its
 * own (the wrapper's never does — the walker doesn't annotate params) so this
 * can never clobber a real type.
 *
 * Pure data surgery over the already-walked Residual tree (`Param.default`,
 * residual/types.ts's additive field) — no re-lowering, and never touches
 * `walk()` itself. Safe to run BEFORE shared-bindings/asyncness/imports
 * materialize: each of those only ever SPREADS a `FnDecl`'s `.params` through
 * unchanged when rebuilding it (verified against naming/shared-bindings.ts's,
 * naming/asyncness.ts's, and naming/imports.ts's own `FnDecl` cases — none
 * reconstructs `.params`), so the added default survives untouched all the
 * way to `render()`.
 */
function withParamsDefault(unit: CompilationUnit): CompilationUnit {
  let touched = false;
  const decls = unit.decls.map((d) => {
    if (d.t !== "FnDecl") return d;
    const [first, ...rest] = d.params;
    if (first === undefined) return d;
    touched = true;
    return { ...d, params: [{ ...first, type: first.type ?? PARAMS_CONE_TYPE, default: ObjectLit([]) }, ...rest] };
  });
  if (!touched) {
    throw new Error("scm-module: expected the pipeline wrapper's own FnDecl with its params-cone parameter — found none (internal invariant)");
  }
  return { ...unit, decls };
}

/** Drop every `(define x (require "…"))` whose `x` resolved (per
 *  `resolvedBoundNames`) from a form list before it reaches `walk()` — `x` is
 *  a registry row now (`buildRequireMachinery`'s `addOverlayRow`), never a
 *  lexical binding; letting the `Define` through would mint a SECOND,
 *  colliding binding for the same JS name (see `buildRequireMachinery`'s own
 *  header — the `const examples = examples;` bug this fixes). The named-
 *  export list (`topLevelDefineNames`) is computed from the UNFILTERED forms —
 *  `x` still deserves to be re-exported, it just isn't ALSO locally declared.
 *  (One acknowledged v0 edge case, absent from every real fixture: a form that
 *  is BOTH `define/overridable` and bound to a bare `(require …)` default —
 *  `overridableType !== undefined` AND `value.kind === "Require"` — would
 *  match both this filter and `isLiftableOverridable`; no fixture constructs
 *  that shape, so it is left unresolved rather than guessed at.) */
function dropResolvedBoundRequires(forms: readonly CoreForm[], resolvedBoundNames: ReadonlySet<string>): CoreForm[] {
  return forms.filter((f) => !(f.kind === "Define" && f.value.kind === "Require" && resolvedBoundNames.has(f.name)));
}

/**
 * Compile one `.scm` source to its module text. Never throws for an ordinary
 * unsupported form (the walker's own door contract handles that at RUNTIME,
 * inside the emitted artifact, exactly as the interpreter would) — only for a
 * genuine internal-invariant violation.
 */
export function compileScmModule(source: string, deps: ScmCompileDeps, opts: CompileFileOptions): CompileFileResult {
  // The require-scan needs only `Require.path`/`.kind`/bound name — never node
  // identity — so scanning THIS package's own `classify()` output (below, via
  // the model) is fine; no throwaway pre-pass needed.
  const scanForms = flattenTopBegins(classify(desugar(parseSexprs(source))).forms);
  const uses = scanRequires(scanForms);
  const { importDecls, accessDecls, overlayTable, requireOf, resolvedBoundNames, boundJsNames, warnings } = buildRequireMachinery(uses, opts);

  const flowedUpOverridables = opts.flowedUpOverridables ?? [];
  const fnLiftWarnings: PendingWarning[] = [];
  // `.find`, not `.some` — the FIRST offending node's own span is a real,
  // exact position; a boolean check would leave this
  // warning span-less for no reason (only the first occurrence is named
  // when several exist, a deliberate v0 simplification — see require-scan's
  // own "first-encounter order" convention for the same call). Checked for
  // BOTH faces: a module-face fn-shorthand overridable is just as
  // silently un-lifted as a pipeline-face one now that `compileModuleFace`
  // ALSO lifts its plain-value overridables (below).
  const overridableFnShorthand = scanForms.find((f): f is DefineFn => f.kind === "DefineFn" && f.overridableType !== undefined);
  if (overridableFnShorthand !== undefined) {
    fnLiftWarnings.push({
      code: "build/overridable-fn-shorthand-unlifted",
      span: overridableFnShorthand.span,
      message:
        "one or more `define/overridable`'s fn-shorthand forms found — v0 does not lift a function-bodied overridable into the params cone; it compiles as an ordinary (un-lifted) function",
    });
  }
  // Which registry row (if either) this file needs: a pipeline overlays the
  // params-aware symbol when it has local overridables OR a transitive
  // flow-up cone; a module overlays the params-less symbol
  // when it has local overridables of its own (see overridable.ts's
  // module-face section). A file with neither needs no
  // overlay row at all, matching v0's original "only overlay when used".
  const hasLocalOverridables = scanForms.some(isLiftableOverridable);
  let overlay = overlayTable;
  if (opts.isPipeline) {
    if (hasLocalOverridables || flowedUpOverridables.length > 0) overlay = { ...overlayTable, [OVERRIDABLE_SYMBOL]: overridableSymbolRule };
  } else if (hasLocalOverridables) {
    overlay = { ...overlayTable, [MODULE_OVERRIDABLE_SYMBOL]: moduleOverridableSymbolRule };
  }

  const registry = withRules(deps.baseRegistry, overlay);
  const sm = new SchemeSemanticModel(source, registry);
  const flatForms = flattenTopBegins(sm.coreform.forms);

  const result = opts.isPipeline
    ? compilePipelineFace(sm, flatForms, requireOf, resolvedBoundNames, opts.runtimeImportPath, flowedUpOverridables)
    : compileModuleFace(sm, flatForms, requireOf, resolvedBoundNames, boundJsNames, opts.runtimeImportPath);

  // Imports first, then the run-once access consts they feed, then the walked
  // module — the order a human writes a module head in (and the only order
  // that parses: an access const reads its own import binding).
  const finalDecls: Decl[] = [...importDecls, ...accessDecls, ...result.decls];
  const code = render({ decls: finalDecls, body: result.body });
  return {
    content: code,
    shape: {
      named: result.named,
      defaultFace: result.hasDefault ? "function" : undefined,
      defaultAsync: result.hasDefault && result.defaultAsync ? true : undefined,
      overridables: foldOverridableExports(scanForms),
    },
    warnings: [...warnings, ...fnLiftWarnings],
  };
}

interface FaceResult {
  readonly decls: readonly Decl[];
  readonly body: readonly R[];
  readonly named: readonly NamedExport[];
  /** Does this file export a default at all? When true it is ALWAYS the
   *  `export default function` FnDecl already IN `decls` (rendered by
   *  `residual/render.ts`'s own `exported: "default"` path — the old
   *  post-`render()` `export default <binding>;` text suffix is gone with
   *  the eager-value shape it existed to print). */
  readonly hasDefault: boolean;
  /** Did the default face come out `async` after asyncness materialization?
   *  Threaded into `ExportShape.defaultAsync` so a requiring sibling knows
   *  to await its run-once access const. */
  readonly defaultAsync: boolean;
}

/** Ordinary module face: every top-level define is a named export; a trailing
 *  expression (if present) compiles as `export default function Main() { … }`
 *  (the `wrapTrailingAsMain` synthetic — reference-program-face-always-
 *  function) — module-level top-level define PROPAGATION is deliberately NOT
 *  enabled here (`propagationOf` omitted) because `walk()` gates its
 *  whole-program `propagateTopLevelDefines` pass on that same option: letting
 *  it run could eliminate a top-level define this file's named-export list has
 *  already promised exists. Per-node `idiomAt`/`prevalueOf`/`sameBranchOf`
 *  stay on — none of them touch the top-level decls/body split. */
function compileModuleFace(
  sm: SchemeSemanticModel,
  flatForms: readonly CoreForm[],
  requireOf: (n: Require) => R | undefined,
  resolvedBoundNames: ReadonlySet<string>,
  boundJsNames: ReadonlyMap<string, string>,
  runtimeImportPath: string,
): FaceResult {
  const named = topLevelDefineNames(flatForms);
  const wantsDefault = hasProgramFace(flatForms);
  const id = idMinter(maxNodeId(sm.coreform.forms) + 1);
  const droppedRequires = dropResolvedBoundRequires(flatForms, resolvedBoundNames);
  // A LOCAL `define/overridable` still gets a
  // real (params-less) env chain even though a module face has no params
  // cone of its own to consult an explicit argument from — see
  // overridable.ts's `liftLocalOverridable`/`MODULE_OVERRIDABLE_SYMBOL`.
  const lifted = droppedRequires.map((f) => (isLiftableOverridable(f) ? liftLocalOverridable(f, id) : f));
  const formsToWalk = wantsDefault ? wrapTrailingAsMain(lifted, id) : lifted;

  const walked = walk(
    { forms: formsToWalk, originAtom: sm.coreform.originAtom, parentOf: sm.coreform.parentOf, doors: sm.coreform.doors },
    {
      registry: sm.registry,
      facts: sm.factsMap(),
      idiomAt: sm.idiomAt,
      prevalueOf: sm.prevalueOf,
      sameBranchOf: sm.sameBranchOf,
      requireOf,
      register: "run",
    },
  );
  const sync = wantsDefault ? exportMainAsDefault(walked, SCM_MAIN) : walked;

  // The ONE source of truth for a top-level define's exported name:
  // `sync.decls`, read RIGHT NOW (before shared-bindings/asyncness/imports run
  // any further splicing), is exactly the ConstDecl/FnDecl set `walk()`'s own
  // top-level loop pushed for `formsToWalk`'s Define/DefineFn forms — one per
  // name — each still carrying its scheme-name mint origin (`originOf`,
  // naming/origin.ts) alongside its ALREADY-ALLOCATED `.text` (walk()'s own
  // internal census→allocate→materialize phase, naming/allocate.ts, already
  // committed this before returning — see walker/walk.ts's own module header).
  // Reading it here is the guarantee: NEVER call `cleanName` independently to
  // guess the export name a second time — that could disagree with the
  // allocator's own collision-resolved pick (a contested predicate `foo?`
  // yielding `isFoo`, not `foo`, when a co-scoped plain `foo` binding also
  // wants the bare name — naming/allocate.ts's `declaredCandidates`).
  const jsNameOfScheme = new Map<string, string>();
  for (const d of sync.decls) {
    if (d.t !== "ConstDecl" && d.t !== "FnDecl") continue;
    const origin = originOf(d.name);
    if (origin !== undefined) jsNameOfScheme.set(origin.text, d.name.text);
  }
  // A resolved bound-require's name has no walked decl of its own (its
  // `Define` was dropped — `dropResolvedBoundRequires`), but the require
  // machinery DID allocate its real local identifier (the import alias or the
  // run-once access const) — `boundJsNames` closes the gap that used to fall
  // back to the RAW scheme name here, emitting uncompilable
  // `export { parsed-config }` for any kebab/predicate bound name.
  for (const [scheme, js] of boundJsNames) if (!jsNameOfScheme.has(scheme)) jsNameOfScheme.set(scheme, js);
  const namedPairs: readonly NamedExport[] = named.map((scheme) => ({ scheme, js: jsNameOfScheme.get(scheme) ?? scheme }));

  const shared = materializeSharedBindings(sm.sharedBindingsOf(sync));
  const asyncified = materializeAsyncness(sm.asyncnessOf(shared, inferAsyncSeeds));
  const importSymbols = new Set<string>();
  for (const form of sm.coreform.forms) for (const s of sm.importsOf(form)) importSymbols.add(s);
  const materialized = materializeImports(asyncified, { symbols: importSymbols, runtimeModule: runtimeImportPath });

  const decls: Decl[] = [...materialized.decls];
  if (namedPairs.length > 0) decls.push(Export(namedPairs.map((p) => p.js)));
  return {
    decls,
    body: materialized.body,
    named: namedPairs,
    hasDefault: wantsDefault,
    defaultAsync: faceIsAsync(asyncified),
  };
}

/** Did the default-exported FnDecl come out `async` after asyncness
 *  materialization? Read off the ASYNCIFIED unit (imports materialization
 *  never touches async flags) — the one place the compiled face's asyncness
 *  is knowable, threaded into `ExportShape.defaultAsync` for consumers. */
function faceIsAsync(unit: CompilationUnit): boolean {
  return unit.decls.some((d) => d.t === "FnDecl" && d.exported === "default" && d.async === true);
}

/** v0's pipeline face: the WHOLE file becomes one synthetic
 *  `DefineFn` ("the wrap" — see the module header), its own top-level
 *  `define/overridable`s PLUS the entire transitive flow-up cone
 *  (`flowedUpOverridables`) lifted into the params cone
 *  (`overridable.ts`), then exported as a plain `export default` of that
 *  function — thunked BY CONSTRUCTION (a function body never runs at import;
 *  v0 treats every pipeline as unconditionally deferred — the simplest sound
 *  choice; an effect-derived refinement is future work). No named exports:
 *  this is a DIFFERENT cone than a per-file intra-file lift (still not
 *  built) — that one would decide which of THIS file's own defines close
 *  over params vs. escape as named exports; this cone is INTER-file (which
 *  OTHER files' overridables flow up into THIS file's signature). */
function compilePipelineFace(
  sm: SchemeSemanticModel,
  flatForms: readonly CoreForm[],
  requireOf: (n: Require) => R | undefined,
  resolvedBoundNames: ReadonlySet<string>,
  runtimeImportPath: string,
  flowedUpOverridables: readonly FlowedUpOverridable[],
): FaceResult {
  const id = idMinter(maxNodeId(sm.coreform.forms) + 1);
  const wrapperSpan = flatForms[0]?.span ?? ([0, 0] as const);
  const formsForBody = dropResolvedBoundRequires(flatForms, resolvedBoundNames);
  const liftedBody = formsForBody.map((f) => (isLiftableOverridable(f) ? liftOverridable(f, id) : f));
  // Every overridable transitively reached through this
  // pipeline's require-DAG (project.ts's cone walk — already collision-
  // resolved) lifts ALONGSIDE this file's own local ones, prepended so the
  // params cone reads as one coherent block of declared knobs ahead of the
  // pipeline's own logic.
  const flowedUpDefines = flowedUpOverridables.map((entry, index) => liftFlowedUpOverridable(entry, index, id, wrapperSpan));
  const wrapperName = "run";
  const wrapper: DefineFn = {
    kind: "DefineFn",
    id: id(),
    span: wrapperSpan,
    name: wrapperName,
    params: [{ recordKind: "param", id: id(), span: wrapperSpan, name: PIPELINE_PARAMS_SCHEME_NAME, rest: false }],
    body: [...flowedUpDefines, ...liftedBody],
  };

  const sync = walk(
    { forms: [wrapper], originAtom: sm.coreform.originAtom, parentOf: sm.coreform.parentOf, doors: sm.coreform.doors },
    {
      registry: sm.registry,
      facts: sm.factsMap(),
      idiomAt: sm.idiomAt,
      prevalueOf: sm.prevalueOf,
      // The wrap is ONE top-level DefineFn — never a literal-valued define —
      // so `propagateTopLevelDefines` (gated on this same option) can never
      // eliminate it; safe to enable, matching `compileGreenfield`'s own call
      // shape and picking up the per-`let` propagation optimization for free.
      propagationOf: sm.propagationOf,
      sameBranchOf: sm.sameBranchOf,
      requireOf,
      register: "run",
    },
  );
  // The wrapper's own params-parameter carries no declared default from `walk()` —
  // a zero-arg call `run()` (the common case: every knob resolves from env/
  // default) is a real arity error under `--check` otherwise. Pure data
  // surgery over the ALREADY-WALKED tree (see `withParamsDefault`'s own doc) —
  // no re-lowering, no touching `walk()` itself.
  const defaulted = withParamsDefault(exportMainAsDefault(sync, wrapperName));

  const shared = materializeSharedBindings(sm.sharedBindingsOf(defaulted));
  const asyncified = materializeAsyncness(sm.asyncnessOf(shared, inferAsyncSeeds));
  const importSymbols = new Set<string>();
  for (const s of sm.importsOf(wrapper)) importSymbols.add(s);
  const materialized = materializeImports(asyncified, { symbols: importSymbols, runtimeModule: runtimeImportPath });

  return {
    decls: materialized.decls,
    body: materialized.body,
    named: [],
    hasDefault: true,
    defaultAsync: faceIsAsync(asyncified),
  };
}
