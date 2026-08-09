/**
 * THE BINDING CENSUS — E1a's global, decision-bearing view over the walked
 * (pre-allocation, "provisional") Residual tree (engine plan §2 E1a item 1):
 * every binding site, its entity kind, its scope shape, and the use-shape
 * facts the naming policy needs (destructure/singularize candidacy).
 *
 * Reads the ALREADY-WALKED tree — not the raw CoreForm/scheme AST — for one
 * load-bearing reason: destructure/singularize candidacy is a property of the
 * LOWERED shape (a car/cdr chain is an `Index`/`Method("slice")` node only
 * AFTER the registry's rules have run; a `.map()` receiver is only visible
 * post-lowering). Re-deriving this from CoreForm would duplicate the walker's
 * own §4.2 dispatch ladder, dishonestly — model.ts's `importsOf` states the
 * same principle for the same reason.
 *
 * Scope reconstruction: every SURVIVING `Block`/`Arrow`/`FnDecl` node in the
 * (already-walked) tree is a JS scope boundary — nothing more is needed. A
 * `Let`/`NamedLet` compiled in TAIL position has its own wrapping `Block`
 * SPLICED away by `lowerTail` (walk.ts) before this ever runs, so its
 * bindings already read as siblings of their new surrounding scope's other
 * bindings in the tree we see here — exactly the flattening the RENDERED
 * code will have. Reconstructing scope nesting from anything OTHER than the
 * final (post-splice) tree's own shape would risk disagreeing with what
 * render() actually emits; the tree we walk already IS the ground truth.
 *
 * The singularize gate (`Method(_, "map"|"filter"|"forEach"|"some"|"every",
 * [Arrow, …])`, first param, FRESH origin) replicates the dissolved
 * legibility/singularize.ts's own `.map`-only trigger, BROADENED to every
 * native iterator method this compiler's emit rules actually construct a
 * `Method` node for (naming lane item 3 — "deliberately not landed" is no
 * longer the boundary; `filterEmitRule`'s Law-T guard wrapper is the other
 * REAL site today, `forEach`/`some`/`every` are unreached in practice — r7rs
 * `for-each`/`any`/`every` compile to runtime-shim CALLS, never a native
 * method — but included for completeness/forward-compat, unit-tested
 * directly). The destructure analysis (`analyzeParam`/`cdrOffsetOf`) is a
 * verbatim port of the dissolved legibility/destructure.ts's own analysis —
 * unchanged logic, now a pure census READ instead of a decide-and-rewrite
 * pass. `analyzeFieldParam` is its dict-field twin (item 2): same "every
 * occurrence qualifies, or the whole candidacy is off" discipline, keyed on
 * literal-string `Index` access instead of car/cdr chains. `foldRoleNames`
 * (item 4) reads the STRUCTURAL shape a `.reduce` fold call already has
 * (`Method(recv, "reduce", [Arrow([acc, item], Bin(op, …)), identity])` —
 * `foundations/arrival/arrival/src/env/r7rs/lists.ts`'s `applyEmitRule`,
 * arrival-core, never touched here) and supplies BOTH params a readable-name
 * candidate — operator-derived for the accumulator, singularized-collection
 * for the item — so the allocation phase never has to hand-name `__acc`/
 * `__item` at emit.
 */
import { elementNameOf } from "../legibility/names.js";
import { childrenOf } from "../legibility/tree.js";
import type { Binding, BinOp, CompilationUnit, Decl, Param, Pattern, R } from "../residual/types.js";
import { originOf } from "./origin.js";
import type { BindingCensus, BindingSite, DestructureShape, EntityKind, FieldDestructureShape } from "./types.js";

// ── destructure analysis (verbatim port — see the module header) ───────────

function asNonNegIntLit(n: R): number | undefined {
  return n.t === "Lit" && n.value.k === "number" && Number.isInteger(n.value.value) && n.value.value >= 0
    ? n.value.value
    : undefined;
}

function cdrOffsetOf(expr: R, param: Binding): number | undefined {
  if (expr.t === "Ref" && expr.binding === param) return 0;
  if (expr.t === "Method" && expr.name === "slice" && expr.args.length === 1) {
    const k = asNonNegIntLit(expr.args[0]!);
    if (k === undefined) return undefined;
    const inner = cdrOffsetOf(expr.recv, param);
    return inner === undefined ? undefined : inner + k;
  }
  return undefined;
}

function analyzeParam(body: R, param: Binding): DestructureShape | undefined {
  let stray = false;
  const positions = new Map<R, number>();
  let maxIndex = -1;
  const visit = (n: R): void => {
    if (stray) return;
    if (n.t === "Index") {
      const k = asNonNegIntLit(n.index);
      if (k !== undefined) {
        const offset = cdrOffsetOf(n.recv, param);
        if (offset !== undefined) {
          const pos = offset + k;
          positions.set(n, pos);
          maxIndex = Math.max(maxIndex, pos);
          return; // fully accounted for — do not also flag the buried Ref as stray
        }
      }
    }
    if (n.t === "Ref" && n.binding === param) {
      stray = true;
      return;
    }
    for (const c of childrenOf(n)) visit(c);
  };
  visit(body);
  if (stray || positions.size === 0) return undefined;
  return { positions, maxIndex };
}

// ── field-destructure analysis (item 2 — the dict-field twin of the above) ─────────

/**
 * `param` is field-destructure-eligible iff EVERY occurrence in `body` is a
 * literal-string-keyed `Index(Ref(param), Lit({k:"string", value: key}))` —
 * arrival's keyword-accessor lowering, `(:key obj)` → `obj["key"]`. A single
 * bare (non-field) occurrence anywhere — including a positional `Index`, a
 * chained field access reading a FIELD'S result rather than `param` itself,
 * or a plain `Ref` — forces `undefined` (all-or-nothing, mirroring
 * `analyzeParam`'s own "stray" discipline exactly). Field names are recorded
 * in first-encountered order for stable emission.
 */
function analyzeFieldParam(body: R, param: Binding): FieldDestructureShape | undefined {
  let stray = false;
  const accesses = new Map<R, string>();
  const fields: string[] = [];
  const seen = new Set<string>();
  const visit = (n: R): void => {
    if (stray) return;
    if (n.t === "Index" && n.recv.t === "Ref" && n.recv.binding === param && n.index.t === "Lit" && n.index.value.k === "string") {
      const key = n.index.value.value;
      accesses.set(n, key);
      if (!seen.has(key)) {
        seen.add(key);
        fields.push(key);
      }
      return; // fully accounted for — do not also flag the buried Ref as stray
    }
    if (n.t === "Ref" && n.binding === param) {
      stray = true;
      return;
    }
    for (const c of childrenOf(n)) visit(c);
  };
  visit(body);
  if (stray || accesses.size === 0) return undefined;
  return { accesses, fields };
}

// ── scope-tree construction ──────────────────────────────────────────────

interface Builder {
  sites: BindingSite[];
  children: Builder[];
}
const newBuilder = (): Builder => ({ sites: [], children: [] });
const newChildScope = (parent: Builder): Builder => {
  const child = newBuilder();
  parent.children.push(child);
  return child;
};

function registerSite(
  binding: Binding,
  kind: EntityKind,
  scope: Builder,
  bySite: Map<Binding, BindingSite>,
  extra?: Partial<Pick<BindingSite, "destructure" | "fieldDestructure" | "singularName">>,
): void {
  const origin = originOf(binding);
  if (origin === undefined) {
    // Every Binding a DECLARATION site reaches was minted by walk.ts's
    // declareJs/fresh (the only two mint paths that register into a scheme
    // frame or a param/pattern position) — an un-originated Binding here
    // signals a walker bug, not a legitimate "no origin" case (contrast: a
    // bare global reference like Ref(Binding("Error")) never reaches here
    // because it is never a declaration site — see this module's header).
    throw new Error(`binding census: Binding("${binding.text}") reached as a declaration site with no recorded mint origin`);
  }
  const site: BindingSite = { binding, origin, kind, ...extra };
  scope.sites.push(site);
  bySite.set(binding, site);
}

function registerPattern(p: Pattern, kind: EntityKind, scope: Builder, bySite: Map<Binding, BindingSite>): void {
  if (p.t === "Binding") registerSite(p, kind, scope, bySite);
  else if (p.t === "RestBinding") registerSite(p.binding, kind, scope, bySite);
  else if (p.t === "ObjectPattern") for (const prop of p.properties) registerSite(prop.binding, kind, scope, bySite); // not produced pre-allocation; defensive
  else for (const el of p.elements) registerPattern(el, kind, scope, bySite); // ArrayPattern — not produced pre-allocation; defensive
}

/** One param-index override: forces `kind` + a readable-name candidate onto
 *  that positional param, bypassing the destructure/field-destructure
 *  analysis's own kind decision (still subordinate to it — see below). Used
 *  by `walkR`'s Method case for the singularize gate (index 0 → "element")
 *  and the reduce fold-role gate (index 0 → "accumulator", index 1 →
 *  "element"). */
interface ParamOverride {
  readonly kind: EntityKind;
  readonly singularName: string | undefined;
}

/** Register an Arrow/FnDecl's own param list against ITS OWN body (destructure
 *  is analyzed per-param, over the scope the param actually lives in).
 *  `overrides[i]` optionally overrides param `i`'s kind/readable-name
 *  candidate — the singularize gate's and the fold-role gate's entry point
 *  (see `walkR`'s Method case; index-addressed rather than "first" only,
 *  now that a two-param reduce fold names BOTH its accumulator and its
 *  item). */
function registerParams(
  params: readonly Param[],
  body: R,
  scope: Builder,
  bySite: Map<Binding, BindingSite>,
  overrides?: readonly (ParamOverride | undefined)[],
): void {
  params.forEach((p, i) => {
    if (p.pattern.t !== "Binding") {
      registerPattern(p.pattern, "param", scope, bySite);
      return;
    }
    const destructure = analyzeParam(body, p.pattern);
    // Field-destructure is checked only when positional destructure DIDN'T
    // fire — the two shapes are mutually exclusive by construction (a mixed-
    // use param registers as "stray" in BOTH analyses independently) but
    // positional keeps precedence as documented policy, matching how
    // singularize already deferred to it.
    const fieldDestructure = destructure === undefined ? analyzeFieldParam(body, p.pattern) : undefined;
    const eligible = destructure !== undefined || fieldDestructure !== undefined;
    const override = overrides?.[i];
    // Destructure (either shape) takes precedence over singularize/fold-role
    // naming — a destructured param has no single remaining Binding to rename
    // (matches the dissolved legs' destructure-before-singularize ordering,
    // legibility.ts's own doc, now extended to the field shape too).
    const kind = eligible ? "param" : (override?.kind ?? "param");
    const singularName = eligible ? undefined : override?.singularName;
    registerSite(p.pattern, kind, scope, bySite, { destructure, fieldDestructure, singularName });
  });
}

// ── the singularize gate's method set (item 3) ──────────────────────────────

/** Native iterator methods whose first-arg Arrow's leading (fresh) param is
 *  the "element" — see the module header. `map`/`filter` are the only two
 *  any registered emit rule constructs a `Method` node for today
 *  (`mapEmitRule`/`filterEmitRule`, arrival-core); `forEach`/`some`/`every`
 *  are forward-compat (r7rs `for-each`/`any`/`every` currently lower to
 *  runtime-shim CALLS, not native methods) — unreached in practice, covered
 *  by a direct unit test instead of a corpus fixture. */
const SINGULARIZE_METHODS = new Set(["map", "filter", "forEach", "some", "every"]);

/**
 * True iff `body` IS EXACTLY the Law-T truthiness-guard shape
 * `Bin("!==", Call(pred, [Ref(param)]), Lit(false))` — `filterEmitRule`'s
 * wrapper around a non-provably-boolean predicate (arrival-core's
 * `srfi-1.ts`: `__x => (pred)(__x) !== false`). `param` is pure plumbing
 * here (a truthiness-coercion variable, never "the element" in any
 * meaningful sense); when `pred` is itself an inline lambda (usually
 * declared-origin, user-authored), the MEANINGFUL name belongs to ITS OWN
 * parameter, named normally regardless of what happens here. Declining the
 * singularize candidate for exactly this shape stops the wrapper from
 * claiming a name (e.g. a `.filter` guard around `(lambda (rec) …)` claiming
 * "rec", singularized from the receiver, ahead of the real predicate
 * parameter that needs it more).
 *
 * Deliberately narrower than "is `param` forwarded to a nested Arrow
 * anywhere in the body": `mapEmitRule`'s multi-list zip shape
 * (`Arrow([el, idx], Call(userFn, [Ref(el), ...rest]))`, the callback
 * applied directly with NO `!== false` wrapper) has the identical
 * "Call(Arrow, [Ref(param), …])" skeleton but is a completely different,
 * legitimate case — `el` genuinely IS the element there, and declining to
 * name it would be the exact "do NOT force a bad name" mistake in the other
 * direction. Matching the WHOLE arrow body against the guard's exact
 * three-node signature (not a generic tree search) is what tells the two
 * apart. See naming.test.ts's dedicated regression rows for both.
 */
function isLawTGuardWrapper(body: R, param: Binding): boolean {
  return (
    body.t === "Bin" &&
    body.op === "!==" &&
    body.right.t === "Lit" &&
    body.right.value.k === "boolean" &&
    body.right.value.value === false &&
    body.left.t === "Call" &&
    body.left.args.length === 1 &&
    body.left.args[0]!.t === "Ref" &&
    body.left.args[0]!.binding === param
  );
}

// ── the fold-role gate (item 4) ──────────────────────────────────────────────

/** Reduce-operator → its accumulator's readable role name. A NAMING table
 *  only — no coupling to arrival-core's `FOLD_OPS` (`lists.ts`'s own
 *  identity/op table for `(apply + xs)`/`(apply * xs)`); this module just
 *  reads the `Bin` shape that lowering already emits. Extend as new
 *  `Bin`-shaped folds appear (a future `apply max`/`apply min` would need a
 *  DIFFERENT residual shape — `max`/`min` are not a `BinOp` — so they're
 *  deliberately not guessed at here; see naming lane item 4's own report). */
const FOLD_ACCUMULATOR_NAMES: Readonly<Partial<Record<BinOp, string>>> = {
  "+": "total",
  "*": "product",
};

/**
 * Structural recognizer for a `(apply <fold-op> xs)`-shaped `.reduce` call —
 * `Method(recv, "reduce", [Arrow([acc, item], Bin(op, Ref(acc)|Ref(item), …)), identity])`,
 * the ONLY `.reduce` shape any registered emit rule constructs today
 * (`applyEmitRule`, arrival-core — see the module header). Both params must
 * be FRESH-minted (never a user's own two-arg reduce callback — the same
 * "never a user's own choice" guard the singularize gate uses) and the
 * body must reference BOTH of them through the recognized `BinOp`, in
 * either operand order (the fold is always commutative today: `+`/`*`).
 * Returns `undefined` — declining the naming, never mis-naming — for any
 * other shape, including an unrecognized operator.
 */
function foldRoleNames(n: Extract<R, { t: "Method" }>): { readonly accName: string; readonly itemName: string | undefined } | undefined {
  const arrow = n.args[0];
  if (arrow === undefined || arrow.t !== "Arrow" || arrow.params.length !== 2) return undefined;
  const [pAcc, pItem] = arrow.params;
  if (pAcc!.pattern.t !== "Binding" || pItem!.pattern.t !== "Binding") return undefined;
  const accB = pAcc!.pattern;
  const itemB = pItem!.pattern;
  if (originOf(accB)?.mint !== "fresh" || originOf(itemB)?.mint !== "fresh") return undefined;
  const body = arrow.body;
  if (body.t !== "Bin") return undefined;
  const refTo = (r: R, b: Binding): boolean => r.t === "Ref" && r.binding === b;
  const straight = refTo(body.left, accB) && refTo(body.right, itemB);
  const swapped = refTo(body.left, itemB) && refTo(body.right, accB);
  if (!straight && !swapped) return undefined;
  const accName = FOLD_ACCUMULATOR_NAMES[body.op];
  if (accName === undefined) return undefined;
  return { accName, itemName: elementNameOf(n.recv) };
}

/** Walk `n`, registering bindings into `scope` and spawning new CHILD scopes
 *  at every surviving Block/Arrow. Falls back to `childrenOf` (generic,
 *  scope-preserving recursion) for every shape that neither declares a
 *  binding nor introduces a new JS scope. */
function walkR(n: R, scope: Builder, bySite: Map<Binding, BindingSite>): void {
  switch (n.t) {
    case "Const": {
      const kind: EntityKind = n.init.t === "Arrow" ? "function" : "value";
      registerPattern(n.pattern, kind, scope, bySite);
      walkR(n.init, scope, bySite);
      return;
    }
    case "Let":
      // Let is engine-minted TCO/loop machinery only (residual/types.ts's own
      // doc) — the self-tail-loop's reassigned loop variable.
      registerPattern(n.pattern, "accumulator", scope, bySite);
      walkR(n.init, scope, bySite);
      return;
    case "Assign":
      // Reassigns an EXISTING binding (the TCO simultaneous-reassignment step)
      // — never a new declaration site.
      walkR(n.value, scope, bySite);
      return;
    case "ForOf": {
      // Dead code path today (no rule constructs ForOf) — handled for
      // exhaustiveness, mirroring Const/Let's own treatment.
      registerPattern(n.pattern, "value", scope, bySite);
      walkR(n.iterable, scope, bySite);
      const child = newChildScope(scope);
      for (const s of n.body.stmts) walkR(s, child, bySite);
      return;
    }
    case "Arrow": {
      const child = newChildScope(scope);
      registerParams(n.params, n.body, child, bySite);
      walkR(n.body, child, bySite);
      return;
    }
    case "Block": {
      const child = newChildScope(scope);
      for (const s of n.stmts) walkR(s, child, bySite);
      return;
    }
    case "While": {
      walkR(n.test, scope, bySite);
      const child = newChildScope(scope);
      for (const s of n.body.stmts) walkR(s, child, bySite);
      return;
    }
    case "If": {
      walkR(n.test, scope, bySite);
      const thenScope = newChildScope(scope);
      for (const s of n.then.stmts) walkR(s, thenScope, bySite);
      // n.else is a Block (own case, own child scope) or a chained If (stays
      // in THIS scope — an else-if's condition is evaluated here, matching
      // render.ts's else-if chain shape); either way, plain recursion suffices.
      if (n.else !== undefined) walkR(n.else, scope, bySite);
      return;
    }
    case "Method": {
      // The singularize gate — replicates the dissolved singularize.ts's own
      // `.map`-only trigger structurally, BROADENED to every native iterator
      // method (item 3): a call whose first arg is an Arrow whose sole/
      // leading Binding-shaped param is FRESH-minted (never a user's own
      // choice — see origin.ts's header).
      if (SINGULARIZE_METHODS.has(n.name) && n.args.length > 0 && n.args[0]!.t === "Arrow") {
        const arrow = n.args[0]!;
        const firstParam = arrow.params[0];
        const firstBinding = firstParam !== undefined && firstParam.pattern.t === "Binding" ? firstParam.pattern : undefined;
        const isFreshFirst = firstBinding !== undefined && originOf(firstBinding)?.mint === "fresh";
        // The Law-T guard wrapper shape declines the candidate — see
        // `isLawTGuardWrapper`'s own doc.
        const singularName =
          isFreshFirst && firstBinding !== undefined && !isLawTGuardWrapper(arrow.body, firstBinding)
            ? elementNameOf(n.recv)
            : undefined;
        const child = newChildScope(scope);
        registerParams(
          arrow.params,
          arrow.body,
          child,
          bySite,
          isFreshFirst ? [{ kind: "element", singularName }] : undefined,
        );
        walkR(arrow.body, child, bySite);
        walkR(n.recv, scope, bySite);
        for (const a of n.args.slice(1)) walkR(a, scope, bySite);
        return;
      }
      // The fold-role gate (item 4) — a `.reduce` call structurally shaped
      // like `applyEmitRule`'s `(apply + xs)` lowering (arrival-core,
      // `foundations/arrival/arrival/src/env/r7rs/lists.ts`, never touched
      // here): names BOTH the accumulator (operator-derived) and the item
      // (singularized collection, same mechanism as the gate above).
      if (n.name === "reduce" && n.args.length > 0 && n.args[0]!.t === "Arrow") {
        const fold = foldRoleNames(n);
        if (fold !== undefined) {
          const arrow = n.args[0]!;
          const child = newChildScope(scope);
          registerParams(arrow.params, arrow.body, child, bySite, [
            { kind: "accumulator", singularName: fold.accName },
            { kind: "element", singularName: fold.itemName },
          ]);
          walkR(arrow.body, child, bySite);
          walkR(n.recv, scope, bySite);
          for (const a of n.args.slice(1)) walkR(a, scope, bySite);
          return;
        }
      }
      walkR(n.recv, scope, bySite);
      for (const a of n.args) walkR(a, scope, bySite);
      return;
    }
    default:
      for (const c of childrenOf(n)) walkR(c, scope, bySite);
  }
}

function visitDecl(d: Decl, scope: Builder, bySite: Map<Binding, BindingSite>): void {
  switch (d.t) {
    case "FnDecl": {
      registerSite(d.name, "function", scope, bySite);
      const child = newChildScope(scope);
      registerParams(d.params, d.body, child, bySite);
      for (const s of d.body.stmts) walkR(s, child, bySite);
      return;
    }
    case "ConstDecl": {
      const kind: EntityKind = d.init.t === "Arrow" ? "function" : "value";
      registerSite(d.name, kind, scope, bySite);
      walkR(d.init, scope, bySite);
      return;
    }
    case "DeclComment":
      visitDecl(d.decl, scope, bySite);
      return;
    case "Import":
    case "ImportType":
    case "Export":
      return;
  }
}

/**
 * The whole-unit entry point (`sm.bindingCensus`'s underlying machinery — see
 * model/model.ts's thin wrap). `unit` is the PROVISIONAL CompilationUnit
 * walk() builds before allocation commits final names — a value never
 * observed outside walker/walk.ts's own internal pipeline in practice, but a
 * plain, pure function of it (same object graph ⇒ same census, deterministically,
 * since the origin side-table is populated once, at mint time, before this
 * ever runs).
 */
export function bindingCensusOf(unit: CompilationUnit): BindingCensus {
  const root = newBuilder();
  const bySite = new Map<Binding, BindingSite>();
  for (const d of unit.decls) visitDecl(d, root, bySite);
  for (const s of unit.body) walkR(s, root, bySite);
  return { root, bySite };
}

// Re-exported for allocate.ts (avoids a second copy of the destructure ladder's
// ordinal-name convention) and for tests exercising the analysis in isolation.
export { analyzeFieldParam, analyzeParam, cdrOffsetOf, foldRoleNames };
