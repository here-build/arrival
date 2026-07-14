/**
 * PEEPHOLES — the named cross-node idiom rewrite pass over CoreForm (constitution
 * §3.1/§3.5, Law C; docs/working-proposals/arrival-mercury/ — this is the opening
 * pair, landed at Phase-2 opening per §9's migration plan).
 *
 * `peephole(classified)` runs a SINGLE bottom-up (post-order) pass: every node's
 * children are rewritten first, then each registered peephole's `match` is tried
 * against the (already children-rewritten) node, in table order; the first match
 * wins and its `rewrite` replaces the node — no re-checking the REWRITTEN result
 * against the table at that same tree position. Single-pass, not fixpoint (the
 * mission's own allowance: "single-pass is fine for the pair"): the two shipped
 * peepholes never need a second look at their own output because they match on
 * DISJOINT head shapes (`car`-headed vs. `infer`/`infer/chat`-headed) — a
 * cache-key-elide result stays `infer`/`infer/chat`-headed (cache-key-elide never
 * touches `fn`), which is exactly the shape scalar-fold's OWN match still
 * recognizes one level up, so the pair composes correctly across ONE bottom-up
 * walk with no repeated visits:
 *
 *   (car (infer m p schema #f))
 *     ▸ bottom-up reaches the INNER App(infer, [m,p,schema,#f]) first
 *       → cache-key-elide matches (4 args, last is #f) → App(infer, [m,p,schema])
 *     ▸ THEN the OUTER App(car, [inner]) is tried
 *       → scalar-fold matches (car of an infer-headed App) → uses the ALREADY
 *         trimmed inner args → App(infer/scalar, [m,p,schema])
 *
 * If a future peephole genuinely needs fixpoint (its own output can match a
 * DIFFERENT registered peephole, or itself again), loop `applyPeepholes` to a
 * fixpoint over `classified` at the call site — nothing here forecloses that;
 * this pass simply does not need it for the shipped pair, and looping
 * unconditionally would cost a full extra tree rebuild on every compile for zero
 * benefit today.
 *
 * SOUNDNESS — the shadowing guard. A peephole matches on bare SYMBOL NAMES
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
 * corpus), this pass instead SKIPS (constitution's own Law F stance: "the
 * failure mode of this design is always 'uglier output', never 'wrong output'"
 * — declining an optimization is always safe; hard-failing an otherwise-valid
 * compile over an unrelated local rebind is not). The over-approximation is
 * deliberately coarse — one flat, whole-program name census, no real scope
 * nesting (porting the walker's full `schemeFrames` stack just to answer "is
 * `car` ever shadowed" would cost as much machinery as `walk()` itself, exactly
 * gate1/measure.ts's own reasoning) — so a shadow ANYWHERE in the program (even
 * in a function that never touches `infer`) disables BOTH peepholes for the
 * WHOLE compile. Cheap, sound, and conservative; a future peephole keying on
 * different names should extend `INFER_PEEPHOLE_LOAD_BEARING_NAMES` (or, if the
 * table grows enough that a shared name touches unrelated peepholes, revisit
 * this as a per-peephole guard).
 */
import type { App, Binding, ClassifyResult, CoreForm, KwEntry, NodeId } from "../coreform/types.js";
import { cacheKeyElide, inferScalarFold, INFER_PEEPHOLE_LOAD_BEARING_NAMES } from "./infer.js";
import type { Peephole, PeepholeCtx } from "./types.js";

export type { Peephole, PeepholeCtx } from "./types.js";
export { cacheKeyElide, inferScalarFold, INFER_PEEPHOLE_LOAD_BEARING_NAMES } from "./infer.js";

/** The shipped registry, in match-priority order. Table order only matters
 *  when two peepholes could BOTH match the same (already-children-rewritten)
 *  node — the shipped pair never does (disjoint head shapes; see this
 *  module's header), so the order here is documentation, not load-bearing. */
export const PEEPHOLES: readonly Peephole[] = [inferScalarFold, cacheKeyElide];

// ── max-id scan — the fresh-id floor for this pass's PeepholeCtx ─────────────────────

/** The highest NodeId anywhere in `forms` — every Base-carrying record classify()
 *  can mint (CoreForm nodes, Param, Binding, KwEntry), not just CoreForm nodes
 *  themselves (classify()'s own counter is shared across all of them, so this is
 *  the only way to get a floor no real id can collide with). -1 if `forms` is
 *  empty (an empty program) — `maxNodeId(...) + 1 === 0`, matching classify()'s
 *  own counter start. */
function maxNodeId(forms: readonly CoreForm[]): number {
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

/** True iff the program ever locally binds a name either shipped peephole keys
 *  its `match` on — the whole-compile bail (see module header). Exported for
 *  direct testing (the driver's own soundness net deserves its own coverage,
 *  not just inference from end-to-end behavior). */
export function programShadowsPeepholeNames(forms: readonly CoreForm[]): boolean {
  const bound = collectBoundNames(forms);
  return INFER_PEEPHOLE_LOAD_BEARING_NAMES.some((n) => bound.has(n));
}

// ── the bottom-up rewrite traversal ───────────────────────────────────────────────────

function rewriteBindings(bindings: readonly Binding[], table: readonly Peephole[], ctx: PeepholeCtx): readonly Binding[] {
  return bindings.map((b) => ({ ...b, init: rewriteForm(b.init, table, ctx) }));
}

function rewriteKwEntries(entries: readonly KwEntry[], table: readonly Peephole[], ctx: PeepholeCtx): readonly KwEntry[] {
  return entries.map((e) => ({ ...e, value: rewriteForm(e.value, table, ctx) }));
}

/** Reconstruct `node` with every CoreForm-valued CHILD rewritten (one level of
 *  structural recursion via `rewriteForm`); `node`'s own Base fields (id/span/
 *  lead/trail) and non-CoreForm fields (letKind, loopName, rest, …) pass
 *  through untouched. Quoted data (`Quote.datum`) is a mirror datatype, never
 *  CoreForm (coreform/types.ts's own invariant) — never re-entered here. */
function rewriteChildren(node: CoreForm, table: readonly Peephole[], ctx: PeepholeCtx): CoreForm {
  switch (node.kind) {
    case "Define":
      return {
        ...node,
        value: rewriteForm(node.value, table, ctx),
        overridableType: node.overridableType === undefined ? undefined : rewriteForm(node.overridableType, table, ctx),
      };
    case "DefineFn":
      return {
        ...node,
        body: node.body.map((f) => rewriteForm(f, table, ctx)),
        overridableType: node.overridableType === undefined ? undefined : rewriteForm(node.overridableType, table, ctx),
      };
    case "Lambda":
      return { ...node, body: node.body.map((f) => rewriteForm(f, table, ctx)) };
    case "If":
      return {
        ...node,
        cond: rewriteForm(node.cond, table, ctx),
        then: rewriteForm(node.then, table, ctx),
        else: rewriteForm(node.else, table, ctx),
      };
    case "And":
      return { ...node, args: node.args.map((a) => rewriteForm(a, table, ctx)) };
    case "Or":
      return { ...node, args: node.args.map((a) => rewriteForm(a, table, ctx)) };
    case "Let":
      return {
        ...node,
        bindings: rewriteBindings(node.bindings, table, ctx),
        body: node.body.map((f) => rewriteForm(f, table, ctx)),
      };
    case "NamedLet":
      return {
        ...node,
        bindings: rewriteBindings(node.bindings, table, ctx),
        body: node.body.map((f) => rewriteForm(f, table, ctx)),
      };
    case "Begin":
      return { ...node, body: node.body.map((f) => rewriteForm(f, table, ctx)) };
    case "App": {
      const rewritten: App = {
        ...node,
        fn: rewriteForm(node.fn, table, ctx),
        positionalArgs: node.positionalArgs.map((a) => rewriteForm(a, table, ctx)),
        kwargs: rewriteKwEntries(node.kwargs, table, ctx),
      };
      return rewritten;
    }
    case "Dict":
      return { ...node, entries: rewriteKwEntries(node.entries, table, ctx) };
    case "Ref":
    case "Lit":
    case "Quote":
    case "Require":
    case "Door":
      return node;
  }
}

/** Post-order: rewrite `node`'s children first, THEN try the table against the
 *  (already children-rewritten) node itself — see module header for why this
 *  order is what lets cache-key-elide's result already be in place by the time
 *  scalar-fold examines the enclosing `car`. Single-pass: the winning
 *  `rewrite`'s OWN output is never re-checked against `table` at this same
 *  position. */
function rewriteForm(node: CoreForm, table: readonly Peephole[], ctx: PeepholeCtx): CoreForm {
  const children = rewriteChildren(node, table, ctx);
  for (const p of table) {
    if (p.match(children)) return p.rewrite(children, ctx);
  }
  return children;
}

/** Run `table` over `classified` once (see module header for pass shape).
 *  `originAtom`/`parentOf`/`doors` pass through BY REFERENCE, unrewritten —
 *  documented, not a bug: they describe the PRE-peephole tree, which stays
 *  100% valid for every untouched node (same id, same object shape) and is
 *  simply silent-by-absence for a peephole-minted id (nothing downstream reads
 *  either table for a peephole-minted node today; `originAtom` is `walk()`'s
 *  own doc-cited seam for a FUTURE full lexical-namer, not consulted by this
 *  wave's walker at all, and `parentOf` exists FOR a peephole pass like this
 *  one to consult before rewriting, not as a promise to stay in sync after).
 *  A future consumer of either table on a POST-peephole tree needs its own
 *  incremental-update pass — out of scope for the opening pair. */
export function applyPeepholes(classified: ClassifyResult, table: readonly Peephole[]): ClassifyResult {
  if (programShadowsPeepholeNames(classified.forms)) return classified;
  let counter = maxNodeId(classified.forms) + 1;
  const ctx: PeepholeCtx = { mintId: () => counter++ as NodeId };
  const forms = classified.forms.map((f) => rewriteForm(f, table, ctx));
  return { ...classified, forms };
}

/** The mission's own top-level shape: `peephole(classified) → ClassifyResult`,
 *  defaulting to the shipped registry. */
export function peephole(classified: ClassifyResult): ClassifyResult {
  return applyPeepholes(classified, PEEPHOLES);
}
