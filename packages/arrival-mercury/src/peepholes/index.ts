/**
 * IDIOMS — the named cross-node idiom decision (constitution §3.1/§3.5, Law C;
 * docs/working-proposals/arrival-mercury/ — this is the opening pair, landed at
 * Phase-2 opening per §9's migration plan). E2b's dissolution (engine plan §2
 * E2: "CSE and the peephole pair become sharing/idiom decision views…
 * decided pre-census"): the old whole-tree `peephole(classified)` PASS is
 * gone. `idiomDecisionAt` is a per-node QUERY — `../model/model.ts`'s
 * `sm.idiomAt(node)` wraps it (memoized, id-floor-tracking); the WALKER
 * consults it inline (`../walker/walk.ts`'s `lowerApp`, at the top, before any
 * other rung of the §4.2 dispatch ladder) instead of the tree having been
 * pre-rewritten. Nothing here walks a tree anymore; every function is a pure
 * per-node (or whole-program-shadow) predicate.
 *
 * ORDERING, now recursive instead of bottom-up-tree-order: the OLD pass's
 * single post-order walk guaranteed cache-key-elide (matching the INNER
 * `infer`/`infer/chat` call) had already run by the time scalar-fold examined
 * the OUTER `car` call, so the fused node's args were already trimmed:
 *
 *   (car (infer m p schema #f))
 *     ▸ scalar-fold matches the OUTER App(car, [inner]) — inner is an
 *       infer-headed App
 *     ▸ to decide what the fused node's args ARE, it asks for the INNER
 *       node's OWN idiom decision first (`effectiveInnerOf`, below) — that
 *       recursive query lands on cache-key-elide (4 args, last is #f) →
 *       App(infer, [m,p,schema])
 *     ▸ the fused node reuses THOSE (already-trimmed) args →
 *       App(infer/scalar, [m,p,schema])
 *
 * This reproduces the pass's exact composition without ever visiting a node
 * the walker itself doesn't already visit: `idiomDecisionAt`'s `recurse`
 * parameter IS `sm.idiomAt` itself (model.ts wires it), so the inner query is
 * memoized exactly like any other `idiomAt` call — never a second, private
 * traversal.
 *
 * SOUNDNESS — the shadowing guard. An idiom matches on bare SYMBOL NAMES
 * (`"car"`, `"infer"`, `"infer/chat"`) with no scope information at all — unlike
 * the walker, which only reaches the registry for a name that resolve() proves is
 * NOT locally bound (walker.ts's `lowerApp`: "Resolved ⇒ ordinary lexical call —
 * the registry is NEVER consulted"). A program that locally rebinds one of these
 * names (`(let ((car identity)) (car (infer m p)))`) would, without a guard, get
 * WRONG-CODE folded by name alone. Mirrors gate1/measure.ts's OWN precedent for
 * this identical class of gap (`assertNoCxrShadowing`: "a real corpus program
 * that shadows `car` is corpus-authoring malpractice … the throw makes that
 * assumption an enforced invariant instead of a silent blind spot") — but where
 * that module throws (it is asserting an invariant about a fixed, curated
 * corpus), this decision instead ANSWERS "no idiom applies" (constitution's own
 * Law F stance: "the failure mode of this design is always 'uglier output',
 * never 'wrong output'" — declining an optimization is always safe; hard-failing
 * an otherwise-valid compile over an unrelated local rebind is not). The
 * over-approximation is deliberately coarse — one flat, whole-program name
 * census, no real scope nesting (porting the walker's full `schemeFrames` stack
 * just to answer "is `car` ever shadowed" would cost as much machinery as
 * `walk()` itself, exactly gate1/measure.ts's own reasoning) — so a shadow
 * ANYWHERE in the program (even in a function that never touches `infer`)
 * disables BOTH idioms for the WHOLE compile — computed ONCE per model (lazily,
 * memoized — see model.ts), not per query. Cheap, sound, and conservative; a
 * future idiom keying on different names should extend
 * `INFER_PEEPHOLE_LOAD_BEARING_NAMES` (or, if the table grows enough that a
 * shared name touches unrelated idioms, revisit this as a per-idiom guard).
 */
import type { App, CoreForm, NodeId } from "../coreform/types.js";
import { cacheKeyElideAt, inferScalarFoldAt, INFER_PEEPHOLE_LOAD_BEARING_NAMES } from "./infer.js";

export { cacheKeyElideAt, inferScalarFoldAt, INFER_PEEPHOLE_LOAD_BEARING_NAMES } from "./infer.js";

// ── max-id scan — the fresh-id floor `sm.idiomAt`'s fusions mint above ───────────────

/** The highest NodeId anywhere in `forms` — every Base-carrying record classify()
 *  can mint (CoreForm nodes, Param, Binding, KwEntry), not just CoreForm nodes
 *  themselves (classify()'s own counter is shared across all of them, so this is
 *  the only way to get a floor no real id can collide with). -1 if `forms` is
 *  empty (an empty program) — `maxNodeId(...) + 1 === 0`, matching classify()'s
 *  own counter start. Exported: `model.ts` computes its own idiom-id counter
 *  from this floor (lazily, once per model — see its header). */
export function maxNodeId(forms: readonly CoreForm[]): number {
  let max = -1;
  const bump = (id: NodeId): void => {
    if (id > max) max = id;
  };
  const visit = (node: CoreForm): void => {
    bump(node.id);
    switch (node.kind) {
      case "Define":
        visit(node.value);
        if (node.overridableType !== undefined) visit(node.overridableType);
        return;
      case "DefineFn":
        for (const p of node.params) bump(p.id);
        for (const f of node.body) visit(f);
        if (node.overridableType !== undefined) visit(node.overridableType);
        return;
      case "Lambda":
        for (const p of node.params) bump(p.id);
        for (const f of node.body) visit(f);
        return;
      case "If":
        visit(node.cond);
        visit(node.then);
        visit(node.else);
        return;
      case "And":
      case "Or":
        for (const a of node.args) visit(a);
        return;
      case "Let":
      case "NamedLet":
        for (const b of node.bindings) {
          bump(b.id);
          visit(b.init);
        }
        for (const f of node.body) visit(f);
        return;
      case "Begin":
        for (const f of node.body) visit(f);
        return;
      case "App":
        visit(node.fn);
        for (const a of node.positionalArgs) visit(a);
        for (const kw of node.kwargs) {
          bump(kw.id);
          visit(kw.value);
        }
        return;
      case "Dict":
        for (const e of node.entries) {
          bump(e.id);
          visit(e.value);
        }
        return;
      case "Ref":
      case "Lit":
      case "Quote":
      case "Require":
      case "Door":
        return;
    }
  };
  for (const f of forms) visit(f);
  return max;
}

// ── the whole-program shadowing guard (see module header) ────────────────────────────

/** Every name bound ANYWHERE in the program — params, let/letrec/named-let
 *  bindings, named-let loop names, defines. A flat over-approximation (no real
 *  scope nesting), mirroring gate1/measure.ts's `collectBoundNames` exactly —
 *  an independent copy, not an import: the two modules evolve for different
 *  reasons (site counting vs. rewrite soundness) and a private helper across
 *  that boundary is the wrong coupling. */
function collectBoundNames(forms: readonly CoreForm[]): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: CoreForm): void => {
    switch (node.kind) {
      case "Define":
        names.add(node.name);
        visit(node.value);
        if (node.overridableType !== undefined) visit(node.overridableType);
        return;
      case "DefineFn":
        names.add(node.name);
        for (const p of node.params) names.add(p.name);
        for (const f of node.body) visit(f);
        if (node.overridableType !== undefined) visit(node.overridableType);
        return;
      case "Lambda":
        for (const p of node.params) names.add(p.name);
        for (const f of node.body) visit(f);
        return;
      case "If":
        visit(node.cond);
        visit(node.then);
        visit(node.else);
        return;
      case "And":
      case "Or":
        for (const a of node.args) visit(a);
        return;
      case "Let":
        for (const b of node.bindings) {
          names.add(b.name);
          visit(b.init);
        }
        for (const f of node.body) visit(f);
        return;
      case "NamedLet":
        names.add(node.loopName);
        for (const b of node.bindings) {
          names.add(b.name);
          visit(b.init);
        }
        for (const f of node.body) visit(f);
        return;
      case "Begin":
        for (const f of node.body) visit(f);
        return;
      case "App":
        visit(node.fn);
        for (const a of node.positionalArgs) visit(a);
        for (const kw of node.kwargs) visit(kw.value);
        return;
      case "Dict":
        for (const e of node.entries) visit(e.value);
        return;
      case "Ref":
      case "Lit":
      case "Quote":
      case "Require":
      case "Door":
        return;
    }
  };
  for (const f of forms) visit(f);
  return names;
}

/** True iff the program ever locally binds a name either idiom keys its
 *  decision on — the whole-compile bail (see module header). Exported for
 *  direct testing (the driver's own soundness net deserves its own coverage,
 *  not just inference from end-to-end behavior). */
export function programShadowsPeepholeNames(forms: readonly CoreForm[]): boolean {
  const bound = collectBoundNames(forms);
  return INFER_PEEPHOLE_LOAD_BEARING_NAMES.some((n) => bound.has(n));
}

// ── the combined per-node decision — `sm.idiomAt`'s underlying machinery ─────────────

/** External state `idiomDecisionAt` needs but does not own — supplied by the
 *  caller (`model.ts`'s `sm.idiomAt`) per its own lazy/memoized lifecycle:
 *  the whole-program shadow verdict (computed once, not per query), a
 *  monotonically-increasing id-mint floor (seeded above every id `classify()`
 *  produced), and `recurse` — the SAME memoized `sm.idiomAt` entry point,
 *  fed back in so the inner-call composition (module header) never opens a
 *  second, private traversal. */
export interface IdiomDeps {
  readonly shadowed: boolean;
  readonly mintId: () => NodeId;
  readonly recurse: (inner: App) => App | undefined;
}

/** `sm.idiomAt(node)`'s pure decision, given the caller's own state (`deps`).
 *  Tries scalar-fold first, then cache-key-elide — order is documentation
 *  only (see infer.ts's own header: the two match on disjoint head shapes,
 *  `car` vs. `infer`/`infer/chat`, so at most one can ever fire for a given
 *  node — see this module's header for how the ONE real composition, scalar-
 *  fold consulting cache-key-elide on its OWN inner node, is threaded via
 *  `recurse`, not by trying both here at the SAME node). */
export function idiomDecisionAt(node: App, deps: IdiomDeps): App | undefined {
  if (deps.shadowed) return undefined;
  const scalarFold = inferScalarFoldAt(node, (inner) => deps.recurse(inner) ?? inner, deps.mintId);
  if (scalarFold !== undefined) return scalarFold;
  return cacheKeyElideAt(node);
}
