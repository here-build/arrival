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
 *     v0-classified PIPELINE file, a thunked, parameterized function with every
 *     `define/overridable` lifted into its env-chained params cone
 *     (`overridable.ts`).
 *  3. **v0's pipeline wrap**: reusing the SAME "whole program as one synthetic
 *     function body" technique `oracle/harness.ts`'s `compileGreenfield` uses
 *     for its own (unrelated) reason — proven semantics-neutral there (a
 *     function body's tail position preserves the trailing value; body-position
 *     defines pre-register exactly like top-level ones) — parameterized instead
 *     of zero-arg, and never immediately called (the whole point is deferral:
 *     nothing may run at import time).
 */
import type { CoreForm, Define, DefineFn, Require } from "../coreform/types.js";
import { classify } from "../coreform/classify.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { SchemeSemanticModel } from "../model/model.js";
import { maxNodeId } from "../peepholes/index.js";
import { materializeAsyncness, materializeImports, materializeSharedBindings } from "../naming/index.js";
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
  Ref,
  type Binding,
  type CompilationUnit,
  type Decl,
  type R,
} from "../residual/types.js";
import { cleanName } from "../walker/names.js";
import { walk } from "../walker/walk.js";
import { idMinter, liftOverridable, OVERRIDABLE_SYMBOL, overridableSymbolRule, PIPELINE_PARAMS_SCHEME_NAME } from "./overridable.js";
import { flattenTopBegins, hasProgramFace, scanRequires, topLevelDefineNames, type RequireOccurrence } from "./require-scan.js";
import type { CompileFileOptions, CompileFileResult } from "./types.js";

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
 *  to borrow (design doc §3's bound-require aliasing; see this file's header). */
function aliasFromPath(specifier: string): string {
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
  readonly warnings: string[];
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
  const warnings: string[] = [];
  const uniqueAlias = makeUniqueAlias();
  /** ONE default-import binding per distinct required PATH that's ever bound/
   *  inline-used — several occurrences of the same require share it. */
  const defaultImportOf = new Map<string, Binding>();
  const spilledPaths = new Set<string>();
  const unresolvedPaths = new Set<string>();
  const resolvedBoundNames = new Set<string>();

  const addOverlayRow = (exported: string, binding: Binding, context: string): void => {
    if (Object.hasOwn(overlayTable, exported)) {
      warnings.push(`${context} spills/binds "${exported}", which an earlier require in this file already bound — the earlier binding wins`);
      return;
    }
    overlayTable[exported] = { emit: { call: (args) => Call(Ref(binding), args), ref: () => Ref(binding) } };
  };

  for (const use of uses) {
    const path = use.node.path;
    const res = opts.resolveRequire(path);
    if (res.kind === "unresolved") {
      unresolvedPaths.add(path);
      warnings.push(`(require "${path}") ${res.reason}`);
      continue;
    }
    if (use.kind === "spill") {
      if (spilledPaths.has(path)) continue; // already imported this sibling's names once
      spilledPaths.add(path);
      if (res.shape.named.length === 0) {
        warnings.push(`(require "${path}") spills no names — "${path}" declares no top-level defines`);
        continue;
      }
      const names = res.shape.named.map((exported) => ({ exported, local: uniqueAlias(exported) }));
      for (const { exported, local } of names) addOverlayRow(exported, mkBinding(local), `(require "${path}")`);
      importDecls.push(
        Import(names.map(({ exported, local }) => ({ imported: exported, local: local === exported ? undefined : local })), res.importPath),
      );
      continue;
    }
    // "bound" | "inline" — needs the sibling's DEFAULT (program-face) export.
    if (defaultImportOf.has(path)) {
      // Already imported once (e.g. required both bound and inline, or bound
      // twice) — a "bound" occurrence still needs its OWN overlay row even on
      // a repeat path, since each `boundName` is a distinct JS identifier.
      if (use.kind === "bound") {
        addOverlayRow(use.boundName, defaultImportOf.get(path)!, `(define ${use.boundName} (require "${path}"))`);
        resolvedBoundNames.add(use.boundName);
      }
      continue;
    }
    if (!res.shape.hasDefault) {
      unresolvedPaths.add(path);
      warnings.push(`(require "${path}") has no program-face value — "${path}" ends in defines only, nothing to import as a value`);
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
      addOverlayRow(use.boundName, binding, `(define ${use.boundName} (require "${path}"))`);
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

/** Every top-level `Define` whose `overridableType` marks it `define/overridable`
 *  AND is a plain value (never `DefineFn` — see `overridable.ts`'s header). */
function isLiftableOverridable(f: CoreForm): f is Define {
  return f.kind === "Define" && f.overridableType !== undefined;
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

  const fnLiftWarnings: string[] = [];
  let overlay = overlayTable;
  if (opts.isPipeline) {
    const anyOverridableFnShorthand = scanForms.some((f) => f.kind === "DefineFn" && (f as DefineFn).overridableType !== undefined);
    if (anyOverridableFnShorthand) {
      fnLiftWarnings.push(
        "one or more `define/overridable`'s fn-shorthand forms found — v0 does not lift a function-bodied overridable into the params cone; it compiles as an ordinary (un-lifted) function",
      );
    }
    if (scanForms.some(isLiftableOverridable)) overlay = { ...overlayTable, [OVERRIDABLE_SYMBOL]: overridableSymbolRule };
  }

  const registry = withRules(deps.baseRegistry, overlay);
  const sm = new SchemeSemanticModel(source, registry);
  const flatForms = flattenTopBegins(sm.coreform.forms);

  const result = opts.isPipeline
    ? compilePipelineFace(sm, flatForms, requireOf, resolvedBoundNames, opts.runtimeImportPath)
    : compileModuleFace(sm, flatForms, requireOf, resolvedBoundNames, opts.runtimeImportPath);

  const finalDecls: Decl[] = [...importDecls, ...result.decls];
  const code = `${render({ decls: finalDecls, body: result.body })}${result.defaultSuffix ?? ""}`;
  return {
    content: code,
    shape: { named: result.named, hasDefault: result.defaultSuffix !== undefined },
    warnings: [...warnings, ...fnLiftWarnings],
  };
}

interface FaceResult {
  readonly decls: readonly Decl[];
  readonly body: readonly R[];
  readonly named: readonly string[];
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
  const formsToWalk = dropResolvedBoundRequires(flatForms, resolvedBoundNames);

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

  const defaultBinding = mkBinding("__default");
  const withDefault = wantsDefault ? popTrailingAsConst(sync, defaultBinding) : sync;

  const shared = materializeSharedBindings(sm.sharedBindingsOf(withDefault));
  const asyncified = materializeAsyncness(sm.asyncnessOf(shared, inferAsyncSeeds));
  const importSymbols = new Set<string>();
  for (const form of sm.coreform.forms) for (const s of sm.importsOf(form)) importSymbols.add(s);
  const materialized = materializeImports(asyncified, { symbols: importSymbols, runtimeModule: runtimeImportPath });

  const decls: Decl[] = [...materialized.decls];
  if (named.length > 0) decls.push(Export(named));
  return {
    decls,
    body: materialized.body,
    named,
    defaultSuffix: wantsDefault ? `export default ${defaultBinding.text};\n` : undefined,
  };
}

/** v0's pipeline face (design doc §3): the WHOLE file becomes one synthetic
 *  `DefineFn` ("the wrap" — see the module header), its own top-level
 *  `define/overridable`s lifted into the params cone (`overridable.ts`), then
 *  exported as a plain `export default` of that function — thunked BY
 *  CONSTRUCTION (a function body never runs at import; v0 treats every
 *  pipeline as unconditionally deferred, per this lane's directive — "simplest
 *  sound choice; the effect-derived refinement is the documented end-state,
 *  not yours"). No named exports: v0 does not attempt the "overridable cone"
 *  analysis that would let some defines escape the closure (design doc §3's
 *  stated end-state, explicitly deferred). */
function compilePipelineFace(
  sm: SchemeSemanticModel,
  flatForms: readonly CoreForm[],
  requireOf: (n: Require) => R | undefined,
  resolvedBoundNames: ReadonlySet<string>,
  runtimeImportPath: string,
): FaceResult {
  const id = idMinter(maxNodeId(sm.coreform.forms) + 1);
  const wrapperSpan = flatForms[0]?.span ?? ([0, 0] as const);
  const formsForBody = dropResolvedBoundRequires(flatForms, resolvedBoundNames);
  const liftedBody = formsForBody.map((f) => (isLiftableOverridable(f) ? liftOverridable(f, id) : f));
  const wrapperName = "run";
  const wrapper: DefineFn = {
    kind: "DefineFn",
    id: id(),
    span: wrapperSpan,
    name: wrapperName,
    params: [{ recordKind: "param", id: id(), span: wrapperSpan, name: PIPELINE_PARAMS_SCHEME_NAME, rest: false }],
    body: liftedBody,
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

  const shared = materializeSharedBindings(sm.sharedBindingsOf(sync));
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
