/**
 * The per-`.scm`-file BUILD compiler (design doc §3/§4) — module-faced emission
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
 *  2. **The export contract** (design doc §3): module face (every top-level
 *     define → named export, ALWAYS) and program face (a trailing non-define
 *     expression → `export default`) — either a plain, eager value, or, for a
 *     PIPELINE-classified file (`classify.ts`, TASK #87), a thunked,
 *     parameterized function with every `define/overridable` lifted into its
 *     env-chained params cone (`overridable.ts`) — INCLUDING every overridable
 *     transitively reachable through its own require-DAG (TASK #87 Q2's
 *     flow-up; `project.ts`'s cone walk). A MODULE-classified file's own
 *     local overridables still resolve a real (params-less) env chain, just
 *     with no explicit-argument tier of their own.
 *  3. **v0's pipeline wrap**: reusing the SAME "whole program as one synthetic
 *     function body" technique `oracle/harness.ts`'s `compileGreenfield` uses
 *     for its own (unrelated) reason — proven semantics-neutral there (a
 *     function body's tail position preserves the trailing value; body-position
 *     defines pre-register exactly like top-level ones) — parameterized instead
 *     of zero-arg, and never immediately called (the whole point is deferral:
 *     nothing may run at import time).
 */
import type { CoreForm, DefineFn, Require, Span } from "../coreform/types.js";
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
 *  `"inline"` require falls back to when there's no user-chosen `define` name
 *  to borrow (design doc §3's bound-require aliasing; see this file's header).
 *  Exported: `project.ts`'s cone walk (TASK #87 Q2) reuses this EXACT alias
 *  convention to namespace a flowed-up overridable on collision
 *  (`<moduleAlias>.<name>`), so a module's own default-import alias and its
 *  knob namespace always agree. */
export function aliasFromPath(specifier: string): string {
  const base = (specifier.split("/").pop() ?? specifier).replace(/\.[^.]+$/, "");
  return cleanName(base);
}

interface RequireMachinery {
  readonly importDecls: readonly Decl[];
  readonly overlayTable: SymbolRuleTable;
  readonly requireOf: (node: Require) => R | undefined;
  /** The `boundName`s of every `(define x (require "…"))` that resolved. Each
   *  ALSO got a registry overlay row (below), so `x` is never lexically bound —
   *  the caller must drop the enclosing `Define` from what it hands to `walk()`,
   *  or `bindingForDefine` would mint a SECOND, competing binding for the exact
   *  same JS name (`const examples = examples;` — a TDZ self-reference; this was
   *  a real bug caught by the GEPA smoke test, not a hypothetical). */
  readonly resolvedBoundNames: ReadonlySet<string>;
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
  // Built mutably (the exported `RequireMachinery.overlayTable` field is the
  // read-only `SymbolRuleTable` view — structurally the same object, only the
  // TYPE narrows once construction is done).
  const overlayTable: Record<string, SymbolRule> = {};
  const warnings: PendingWarning[] = [];
  const uniqueAlias = makeUniqueAlias();
  /** ONE default-import binding per distinct required PATH that's ever bound/
   *  inline-used — several occurrences of the same require share it. */
  const defaultImportOf = new Map<string, Binding>();
  const spilledPaths = new Set<string>();
  const unresolvedPaths = new Set<string>();
  const resolvedBoundNames = new Set<string>();

  // `span` is always the CURRENT `RequireOccurrence.node.span` — the specific
  // require/define statement whose name is spilling/binding `exported` — never
  // a fabricated position (DX memo item 2).
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
      // BUG #89: the overlay row's KEY is the RAW scheme name (`scheme`) — an
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
    if (defaultImportOf.has(path)) {
      // Already imported once (e.g. required both bound and inline, or bound
      // twice) — a "bound" occurrence still needs its OWN overlay row even on
      // a repeat path, since each `boundName` is a distinct JS identifier.
      if (use.kind === "bound") {
        addOverlayRow(use.boundName, defaultImportOf.get(path)!, `(define ${use.boundName} (require "${path}"))`, span);
        resolvedBoundNames.add(use.boundName);
      }
      continue;
    }
    if (!res.shape.hasDefault) {
      unresolvedPaths.add(path);
      warnings.push({
        code: "build/require-no-default",
        span,
        message: `(require "${path}") has no program-face value — "${path}" ends in defines only, nothing to import as a value`,
      });
      continue;
    }
    const aliasBase = use.kind === "bound" ? cleanName(use.boundName) : aliasFromPath(path);
    const local = uniqueAlias(aliasBase);
    const binding = mkBinding(local);
    defaultImportOf.set(path, binding);
    // `{ imported: "default", local }` renders `import { default as local } from "…"` —
    // the ES2015-legal spelling of a default import, since the Residual `Import`
    // decl (residual/types.ts) has no dedicated default-import shape (see this
    // file's header note in the project report: never modified, only composed).
    importDecls.push(Import([{ imported: "default", local }], res.importPath));
    if (use.kind === "bound") {
      addOverlayRow(use.boundName, binding, `(define ${use.boundName} (require "${path}"))`, span);
      resolvedBoundNames.add(use.boundName);
    }
  }

  const requireOf = (node: Require): R | undefined => {
    if (unresolvedPaths.has(node.path)) return undefined; // fall through to the existing door
    const binding = defaultImportOf.get(node.path);
    // A spill-only path has no default binding — harmless: every call site that
    // reaches this is a bare statement position (see walk.ts's own comment),
    // so ANY non-undefined return discards cleanly. A "bound" occurrence never
    // actually reaches here either (its enclosing Define is filtered out of
    // the walked forms entirely — see `resolvedBoundNames`); this fallback
    // only serves genuine "inline" occurrences and defensive completeness.
    return binding !== undefined ? Ref(binding) : { t: "Lit", value: { k: "undefined" } };
  };

  return { importDecls, overlayTable, requireOf, resolvedBoundNames, warnings };
}

/** Pop the last body statement and rebind it as a top-level `const`, mirroring
 *  `oracle/harness.ts`'s `exportUnitResult` — BEFORE shared-bindings/asyncness/
 *  imports run (so those passes see a `Const` init, not a bare trailing
 *  statement, and can await/hoist it correctly), never after. */
function popTrailingAsConst(unit: CompilationUnit, binding: Binding): CompilationUnit {
  const body = [...unit.body];
  const last = body.pop();
  if (last === undefined) {
    throw new Error("scm-module: expected a trailing body statement for the program face — found none (internal invariant)");
  }
  return { decls: [...unit.decls, ConstDecl(binding, last)], body };
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
 *  bracketed `inhumanParams["metric.threshold"]`, the flow-up namespaced form,
 *  TASK #87 Q2) whose values stay `any` — exactly what a non-strict emitted
 *  project (build.ts's `emittedTsconfig`: `strict:false`/`noImplicitAny:false`,
 *  type-emit not yet wired) already runs on everywhere else. The `any` value
 *  rides the EXISTING `ref` carrier (the same shape `naming/asyncness.ts` emits
 *  `Promise<T>` through) — no new `TsType` variant, no residual-algebra change. */
const PARAMS_CONE_TYPE: TsType = { k: "ref", name: "Record", args: [{ k: "prim", name: "string" }, { k: "ref", name: "any" }] };

/**
 * BUG #90 — the pipeline wrapper's own params-parameter needs a declared
 * `= {}` default (design doc §3's example: `async function run(inhumanParams
 * = {}) {…}`); today it has none, so the common zero-arg call `run()` (every
 * knob resolving from env/default) is a real arity/type error under
 * `--check`. `compilePipelineFace`'s `walk()` call always lowers EXACTLY one
 * top-level form (`forms: [wrapper]` — the whole file becomes one synthetic
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
 *  match both this filter and `isLiftableOverridable`; nothing in the design
 *  doc or this lane's fixtures constructs that shape, so it is left
 *  unresolved rather than guessed at.) */
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
  const { importDecls, overlayTable, requireOf, resolvedBoundNames, warnings } = buildRequireMachinery(uses, opts);

  const flowedUpOverridables = opts.flowedUpOverridables ?? [];
  const fnLiftWarnings: PendingWarning[] = [];
  // `.find`, not `.some` — the FIRST offending node's own span is a real,
  // exact position (DX memo item 2); a boolean check would leave this
  // warning span-less for no reason (only the first occurrence is named
  // when several exist, a deliberate v0 simplification — see require-scan's
  // own "first-encounter order" convention for the same call). Checked for
  // BOTH faces (TASK #87): a module-face fn-shorthand overridable is just as
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
  // flow-up cone (TASK #87 Q2); a module overlays the params-less symbol
  // when it has local overridables of its own (TASK #87 Q2's prerequisite —
  // see overridable.ts's module-face section). A file with neither needs no
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
    : compileModuleFace(sm, flatForms, requireOf, resolvedBoundNames, opts.runtimeImportPath);

  const finalDecls: Decl[] = [...importDecls, ...result.decls];
  const code = `${render({ decls: finalDecls, body: result.body })}${result.defaultSuffix ?? ""}`;
  return {
    content: code,
    shape: { named: result.named, hasDefault: result.defaultSuffix !== undefined, overridables: foldOverridableExports(scanForms) },
    warnings: [...warnings, ...fnLiftWarnings],
  };
}

interface FaceResult {
  readonly decls: readonly Decl[];
  readonly body: readonly R[];
  readonly named: readonly NamedExport[];
  /** Present iff this file has a default export; the exact suffix text to
   *  append after `render()` (see this file's header — `Export`'s residual
   *  shape has no default/aliased form, so the default line is composed as
   *  plain text over an already-real top-level binding `render()` produced). */
  readonly defaultSuffix?: string;
}

/** Ordinary module face: every top-level define is a named export; a trailing
 *  expression (if present) is a PLAIN, EAGER default export — module-level
 *  top-level define PROPAGATION is deliberately NOT enabled here
 *  (`propagationOf` omitted) because `walk()` gates its whole-program
 *  `propagateTopLevelDefines` pass on that same option: letting it run could
 *  eliminate a top-level define this file's named-export list has already
 *  promised exists. Per-node `idiomAt`/`prevalueOf`/`sameBranchOf` stay on —
 *  none of them touch the top-level decls/body split. */
function compileModuleFace(
  sm: SchemeSemanticModel,
  flatForms: readonly CoreForm[],
  requireOf: (n: Require) => R | undefined,
  resolvedBoundNames: ReadonlySet<string>,
  runtimeImportPath: string,
): FaceResult {
  const named = topLevelDefineNames(flatForms);
  const wantsDefault = hasProgramFace(flatForms);
  const id = idMinter(maxNodeId(sm.coreform.forms) + 1);
  const droppedRequires = dropResolvedBoundRequires(flatForms, resolvedBoundNames);
  // TASK #87 Q2's prerequisite: a LOCAL `define/overridable` still gets a
  // real (params-less) env chain even though a module face has no params
  // cone of its own to consult an explicit argument from — see
  // overridable.ts's `liftLocalOverridable`/`MODULE_OVERRIDABLE_SYMBOL`.
  const formsToWalk = droppedRequires.map((f) => (isLiftableOverridable(f) ? liftLocalOverridable(f, id) : f));

  const sync = walk(
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

  // BUG #89 — the ONE source of truth for a top-level define's exported name:
  // `sync.decls`, read RIGHT NOW (before shared-bindings/asyncness/imports run
  // any further splicing), is exactly the ConstDecl/FnDecl set `walk()`'s own
  // top-level loop pushed for `formsToWalk`'s Define/DefineFn forms — one per
  // name — each still carrying its scheme-name mint origin (`originOf`,
  // naming/origin.ts) alongside its ALREADY-ALLOCATED `.text` (walk()'s own
  // internal census→allocate→materialize phase, naming/allocate.ts, already
  // committed this before returning — see walker/walk.ts's own module header).
  // Reading it here is the whole fix: NEVER call `cleanName` independently to
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
  // Every published name paired with its real, allocated JS identifier. Falls
  // back to the raw scheme name for the one acknowledged v0 edge case
  // `dropResolvedBoundRequires` already documents (a resolved bound-require
  // re-export has no local decl of its own to allocate a name for) —
  // unchanged from today's behavior for that gap, never worse.
  const namedPairs: readonly NamedExport[] = named.map((scheme) => ({ scheme, js: jsNameOfScheme.get(scheme) ?? scheme }));

  const defaultBinding = mkBinding("__default");
  const withDefault = wantsDefault ? popTrailingAsConst(sync, defaultBinding) : sync;

  const shared = materializeSharedBindings(sm.sharedBindingsOf(withDefault));
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
    defaultSuffix: wantsDefault ? `export default ${defaultBinding.text};\n` : undefined,
  };
}

/** v0's pipeline face (design doc §3): the WHOLE file becomes one synthetic
 *  `DefineFn` ("the wrap" — see the module header), its own top-level
 *  `define/overridable`s PLUS the entire transitive flow-up cone
 *  (`flowedUpOverridables` — TASK #87 Q2) lifted into the params cone
 *  (`overridable.ts`), then exported as a plain `export default` of that
 *  function — thunked BY CONSTRUCTION (a function body never runs at import;
 *  v0 treats every pipeline as unconditionally deferred, per this lane's
 *  directive — "simplest sound choice; the effect-derived refinement is the
 *  documented end-state, not yours"). No named exports: this is a DIFFERENT
 *  cone than design doc §3's stated end-state (still deferred) — that one
 *  is INTRA-file (which of THIS file's own defines close over params vs.
 *  escape as named exports); TASK #87 Q2's cone is INTER-file (which
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
  // TASK #87 Q2: every overridable transitively reached through this
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
  // BUG #90: the wrapper's own params-parameter carries no declared default —
  // a zero-arg call `run()` (the common case: every knob resolves from env/
  // default) is a real arity error under `--check` otherwise. Pure data
  // surgery over the ALREADY-WALKED tree (see `withParamsDefault`'s own doc) —
  // no re-lowering, no touching `walk()` itself.
  const defaulted = withParamsDefault(sync);

  const shared = materializeSharedBindings(sm.sharedBindingsOf(defaulted));
  const asyncified = materializeAsyncness(sm.asyncnessOf(shared, inferAsyncSeeds));
  const importSymbols = new Set<string>();
  for (const s of sm.importsOf(wrapper)) importSymbols.add(s);
  const materialized = materializeImports(asyncified, { symbols: importSymbols, runtimeModule: runtimeImportPath });

  return {
    decls: materialized.decls,
    body: materialized.body,
    named: [],
    defaultSuffix: `export default ${wrapperName};\n`,
  };
}
