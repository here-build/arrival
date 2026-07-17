/**
 * CONSTANT / COPY PROPAGATION — the unconditionally-sound floor of structural
 * optimization (arrival-mercury engine campaign, structural-optimization lane;
 * `docs/working-proposals/arrival-mercury/gate3-human-grade-rulings.md`'s
 * governing principle: behavioral equivalence is the floor, optimal shape is
 * the goal). Composes WITH `../prevalue/index.ts` (R-G6 static prevaluation,
 * landed): this module runs FIRST, so a propagated constant becomes a literal
 * guard `../prevalue/index.ts` can then fold —
 * `(let ((flag #t)) (if flag A B))` → propagate `flag` → `(if #t A B)` →
 * prevalue folds → `A` — two small, independently-sound passes composing into
 * a result neither could reach alone.
 *
 * THE INSIGHT (arrival is immutable — no `set!`, no dynamics): a binding IS
 * its init, permanently. There is no alias/mutation analysis to do — the
 * question every other optimizer's constant/copy propagation has to answer
 * ("could this binding have been reassigned between its definition and this
 * use?") is answered by construction: no. So propagating a LITERAL init, or
 * COPYING a bare-Ref init, is unconditionally sound, gated by exactly one
 * thing:
 *
 * THE ONE GATE — PURITY: only a binding whose init is a LITERAL/quoted-datum
 * or a bare `Ref` (a copy of another binding) is ever propagated —
 * `isTriviallyPure`, below. A binding to `(infer …)` or any other `App` is
 * NEVER propagated: this module does not know which registry symbols are
 * effectful/crossing (that needs the `cacheClass`/`provenance` gate
 * `../naming/shared-bindings.ts`'s CSE reads off the registry — deliberately
 * NOT read here). Scope is the trivially-pure floor only; general
 * pure-expression inlining (any registry call proven side-effect-free) is
 * deferred to whoever eventually widens this lane with that same gate.
 *
 * SCOPE: `let`/`let*` bindings (this module never touches `letrec`/
 * `letrec*` — those allow forward/mutual self-reference among sibling
 * bindings, which needs a fixpoint to propagate safely and isn't attempted
 * here) and top-level `define` VALUE bindings (`propagateTopLevelDefines`) —
 * LITERAL-only there, deliberately narrower than `let`/`let*` (see that
 * function's own header for why copy-propagation across top-level defines
 * needs an ordering analysis this module does not build).
 *
 * WHY NO SHADOW GUARD IS NEEDED (unlike `../peepholes/`'s registry-symbol
 * idioms): propagation never keys on a symbol NAME across the whole program
 * the way `idiomAt`'s `car`/`infer` folds do. It reads a `Let` node's OWN
 * `bindings` (a real, un-shadowable structural fact — nothing can make a
 * `Binding` record mean something other than what `classify()` built) and
 * substitutes within that SAME node's own body, correctly stopping at any
 * NESTED rebinding of the same name (`substitute`'s shadow-awareness, below)
 * — the soundness argument is scope-local, not whole-program.
 */
import type { Begin, Binding, CoreForm, If, Let, LitValue, QuoteDatum, Ref } from "../coreform/types.js";

// ── the purity gate ────────────────────────────────────────────────────────────────

/**
 * TRUE iff `node`'s value is knowable with zero runtime information AND
 * reading it can never itself be an effect: a literal, a quoted datum, or a
 * bare `Ref` (a copy — reading a variable is never effectful in a
 * `set!`-free language; the variable's OWN init is whatever THIS module or
 * nothing already proved about it). Nothing else — in particular, no `App`
 * (a call could be `(infer …)`), no `Let`/`Lambda`/`If`/`And`/`Or` (each
 * would need its own recursive purity argument this module doesn't build).
 * This is the SAME floor named in the module header; every propagation
 * decision below is gated by it.
 */
export function isTriviallyPure(node: CoreForm): boolean {
  return node.kind === "Lit" || node.kind === "Quote" || node.kind === "Ref";
}

// ── shadow-aware substitution ──────────────────────────────────────────────────────

/** `subst` with every key in `names` removed — reference-preserving (returns
 *  `subst` itself, not a copy) when none of `names` is actually present, so a
 *  substitution walk that never crosses a shadowing scope never allocates. */
function withoutNames(subst: ReadonlyMap<string, CoreForm>, names: Iterable<string>): ReadonlyMap<string, CoreForm> {
  let next: Map<string, CoreForm> | undefined;
  for (const n of names) {
    if (subst.has(n)) {
      next ??= new Map(subst);
      next.delete(n);
    }
  }
  return next ?? subst;
}

/**
 * Every `Define`/`DefineFn` name directly visible to a body-list — i.e. every
 * name `walker/walk.ts`'s own `preRegisterDefines` would pre-register for
 * THIS body, recursing only through a nested `Begin` (which SPLICES into the
 * enclosing body, introducing no scope of its own — same "begin introduces
 * no bindings" fact `walk.ts`'s `lowerStmts` comments on its own `Begin`
 * case) — never through a `Let`/`Lambda`/`If`/etc, each of which is its own
 * scope. Bodies are letrec*-flavored (`walk.ts`'s own module header): a
 * local define's name shadows an outer propagated name for the WHOLE body,
 * not merely "from this point forward" — over-approximating the (rarer,
 * more permissive) sequential-registration case `walk.ts` notes for a define
 * buried inside a nested `begin` is safe (Law F: declining an opportunity is
 * never wrong), so one flat collection suffices for both cases.
 */
function collectBodyShadowNames(forms: readonly CoreForm[]): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (f: CoreForm): void => {
    if (f.kind === "Define" || f.kind === "DefineFn") names.add(f.name);
    else if (f.kind === "Begin") for (const g of f.body) visit(g);
  };
  for (const f of forms) visit(f);
  return names;
}

/** A body-list's own substitution entry point: shadow-aware over its own
 *  directly-visible defines (see `collectBodyShadowNames`), then a plain
 *  per-form `substitute`. Used at every CoreForm site that carries a
 *  `readonly CoreForm[]` body (`Let`/`NamedLet`/`Lambda`/`DefineFn`/`Begin`). */
function substituteBody(forms: readonly CoreForm[], subst: ReadonlyMap<string, CoreForm>): readonly CoreForm[] {
  if (subst.size === 0) return forms;
  const inner = withoutNames(subst, collectBodyShadowNames(forms));
  return forms.map((f) => substitute(f, inner));
}

/**
 * Every name bound ANYWHERE within `forms`, at ANY nesting depth —
 * `Define`/`DefineFn` names, `Lambda`/`DefineFn` params, `Let`/`NamedLet`
 * bindings (+ loop name) — recursing through every CoreForm shape. A flat,
 * whole-subtree over-approximation (no real scope-nesting distinction),
 * mirroring `../peepholes/index.ts`'s own `collectBoundNames` (an
 * independent copy, not an import — that module's own header explains why:
 * "the two modules evolve for different reasons… a private helper across
 * that boundary is the wrong coupling").
 *
 * Purpose (`propagationDecisionAt`'s capture-avoidance, below): a copy-init
 * `Ref(name)` is only safe to splice into a subtree if NOTHING inside that
 * subtree — at ANY depth, not merely its immediate children — rebinds
 * `name`. `collectBodyShadowNames` (above) answers a DIFFERENT, narrower
 * question (which names are directly, top-level visible to a body-list,
 * for `preRegisterDefines`-style letrec* shadowing) and is not sufficient
 * here: a deeply nested `Let`/`Lambda` several levels down can rebind
 * `name` too, and `collectBodyShadowNames` does not see past the first
 * non-`Begin` boundary.
 */
function collectAllBoundNames(forms: readonly CoreForm[]): Set<string> {
  const names = new Set<string>();
  const visit = (f: CoreForm): void => {
    switch (f.kind) {
      case "Define":
        names.add(f.name);
        visit(f.value);
        if (f.overridableType !== undefined) visit(f.overridableType);
        return;
      case "DefineFn":
        names.add(f.name);
        for (const p of f.params) names.add(p.name);
        for (const g of f.body) visit(g);
        if (f.overridableType !== undefined) visit(f.overridableType);
        return;
      case "Lambda":
        for (const p of f.params) names.add(p.name);
        for (const g of f.body) visit(g);
        return;
      case "If":
        visit(f.cond);
        visit(f.then);
        visit(f.else);
        return;
      case "And":
      case "Or":
        for (const a of f.args) visit(a);
        return;
      case "Let":
        for (const b of f.bindings) {
          names.add(b.name);
          visit(b.init);
        }
        for (const g of f.body) visit(g);
        return;
      case "NamedLet":
        names.add(f.loopName);
        for (const b of f.bindings) {
          names.add(b.name);
          visit(b.init);
        }
        for (const g of f.body) visit(g);
        return;
      case "Begin":
        for (const g of f.body) visit(g);
        return;
      case "App":
        visit(f.fn);
        for (const a of f.positionalArgs) visit(a);
        for (const kw of f.kwargs) visit(kw.value);
        return;
      case "Dict":
        for (const e of f.entries) visit(e.value);
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

/**
 * The general shadow-aware substitution: replace every free `Ref(name)` in
 * `node` whose `name` is a key of `subst` with the mapped CoreForm value —
 * REUSING that value's own node object (never re-minting an id; matches
 * `../prevalue/index.ts`'s own "still a real node with its own id" precedent
 * for `If`'s branch-fold). This is semantically sound, not merely
 * convenient: arrival's immutability means a variable's static type/fact
 * doesn't change between read sites, so a `TypeFacts` lookup keyed by the
 * reused node's original id remains correct at the new position too (a
 * literal's fact is position-independent; a copy's fact is the SAME
 * variable's fact at any read site).
 *
 * Stops at any nested binding site that REBINDS one of `subst`'s names
 * (`Let`/`NamedLet`'s own `bindings`, a `Lambda`/`DefineFn`'s own `params`,
 * or a body-visible `Define`/`DefineFn` name — `collectBodyShadowNames`) —
 * within that shadowed subtree, occurrences of the name refer to the NEW
 * binding, never the outer propagated one.
 */
function substitute(node: CoreForm, subst: ReadonlyMap<string, CoreForm>): CoreForm {
  if (subst.size === 0) return node;
  switch (node.kind) {
    case "Ref":
      return subst.get(node.name) ?? node;
    case "Lit":
    case "Quote":
    case "Door":
    case "Require":
      return node; // leaves — nothing to substitute
    case "If": {
      const cond = substitute(node.cond, subst);
      const then = substitute(node.then, subst);
      const els = substitute(node.else, subst);
      return cond === node.cond && then === node.then && els === node.else ? node : { ...node, cond, then, else: els };
    }
    case "And":
    case "Or": {
      const args = node.args.map((a) => substitute(a, subst));
      return args.every((a, i) => a === node.args[i]) ? node : { ...node, args };
    }
    case "Begin": {
      const body = substituteBody(node.body, subst);
      return body === node.body ? node : { ...node, body };
    }
    case "App": {
      const fn = substitute(node.fn, subst);
      const positionalArgs = node.positionalArgs.map((a) => substitute(a, subst));
      const kwargs = node.kwargs.map((e) => ({ ...e, value: substitute(e.value, subst) }));
      const unchanged =
        fn === node.fn &&
        positionalArgs.every((a, i) => a === node.positionalArgs[i]) &&
        kwargs.every((e, i) => e.value === node.kwargs[i]!.value);
      return unchanged ? node : { ...node, fn, positionalArgs, kwargs };
    }
    case "Dict": {
      const entries = node.entries.map((e) => ({ ...e, value: substitute(e.value, subst) }));
      return entries.every((e, i) => e.value === node.entries[i]!.value) ? node : { ...node, entries };
    }
    case "Define": {
      const value = substitute(node.value, subst);
      const overridableType = node.overridableType && substitute(node.overridableType, subst);
      return value === node.value && overridableType === node.overridableType ? node : { ...node, value, overridableType };
    }
    case "DefineFn": {
      const inner = withoutNames(subst, node.params.map((p) => p.name));
      const body = substituteBody(node.body, inner);
      const overridableType = node.overridableType && substitute(node.overridableType, subst);
      return body === node.body && overridableType === node.overridableType ? node : { ...node, body, overridableType };
    }
    case "Lambda": {
      const inner = withoutNames(subst, node.params.map((p) => p.name));
      const body = substituteBody(node.body, inner);
      return body === node.body ? node : { ...node, body };
    }
    case "Let": {
      // "let": every init sees the OUTER scope only — siblings never shadow
      // each other, so inits substitute with `subst` UNCHANGED. "let*"/
      // "letrec"/"letrec*": conservatively treat ALL of this Let's own
      // binding names as shadowing EVERY init (over-approximates let*'s
      // real prefix-only visibility — safe per Law F, just occasionally
      // declines an init substitution a sharper analysis could allow).
      const ownNames = node.bindings.map((b) => b.name);
      const initSubst = node.letKind === "let" ? subst : withoutNames(subst, ownNames);
      const bindings = node.bindings.map((b) => {
        const init = substitute(b.init, initSubst);
        return init === b.init ? b : { ...b, init };
      });
      const bodySubst = withoutNames(subst, ownNames);
      const body = substituteBody(node.body, bodySubst);
      return bindings.every((b, i) => b === node.bindings[i]) && body === node.body ? node : { ...node, bindings, body };
    }
    case "NamedLet": {
      // Inits lower in the OUTER scope for named-let too (`walk.ts`'s own
      // `namedLetStmts`: "Inits lower in the OUTER scope for both shapes") —
      // neither the loop name nor any binding shadows a sibling init.
      const bindings = node.bindings.map((b) => {
        const init = substitute(b.init, subst);
        return init === b.init ? b : { ...b, init };
      });
      const shadow = [node.loopName, ...node.bindings.map((b) => b.name)];
      const body = substituteBody(node.body, withoutNames(subst, shadow));
      return bindings.every((b, i) => b === node.bindings[i]) && body === node.body ? node : { ...node, bindings, body };
    }
  }
}

// ── let / let* propagation decision ────────────────────────────────────────────────

/**
 * `sm.propagationOf`'s underlying decision (`../model/model.ts`) — the
 * WALKER consults it at the top of `../walker/walk.ts`'s `letStmts` (the
 * single function every `Let`-lowering site — statement, tail, and
 * TCO-loop position — routes through), exactly where `sm.idiomAt`/
 * `sm.prevalueOf` are consulted at the top of their own lowering sites.
 * Returns a REPLACEMENT `Let` (fewer bindings, body substituted) to lower
 * INSTEAD of `node`, or `undefined` to decline (lower `node` normally —
 * always safe, per Law F).
 *
 * SCOPE: `letKind` "let"/"let*" only — `letrec`/`letrec*` decline
 * unconditionally (module header). Within scope, a binding propagates iff
 * its (already-substituted, for "let*") init is `isTriviallyPure`:
 *   - "let": every binding's init is checked against the RAW init (siblings
 *     never see each other) — propagatable ones are dropped from
 *     `bindings`, contributing `name → init` (verbatim) to the body's
 *     substitution map.
 *   - "let*": processed left to right, threading an accumulating map so a
 *     chain (`(let* ((a 5) (b a)) (f b))`) resolves fully — `b`'s init
 *     substitutes through the map FIRST (`a` → `5`), THEN is checked for
 *     purity (still a literal) before deciding whether `b` itself
 *     propagates. A binding that re-shadows an earlier same-named entry
 *     (`(let* ((x 1) (x (f x))) x)`) correctly drops the stale entry from
 *     the map (`substitute` runs before the purity re-check, so `x`'s
 *     SECOND binding sees `1`, and — being an `App`, not trivially pure —
 *     survives, evicting the map entry so the body's own `x` resolves to
 *     the SURVIVING binding, never the stale literal).
 *
 * Id discipline (matching `prevalueDecisionAt`'s And/Or trim): the
 * returned `Let` REUSES `node`'s own id/span — same node, fewer bindings,
 * substituted body — never a fresh mint (nothing is fused; every dropped
 * binding's init is either reused verbatim at its new site(s) or chained
 * through unchanged).
 *
 * "No remaining reference" (the soundness argument `materializeSharedBindings`-
 * style dropping needs): a `let`/`let*` binding's ENTIRE visible scope is
 * `node.body` (Scheme lexical scoping — nowhere else in the program can
 * name it) [and, for "let*", the LATER sibling inits, also covered above].
 * `substitute`/`substituteBody` walk every reachable subtree of `body`,
 * replacing every occurrence unless a nested scope shadows the name first —
 * so once a name is dropped from `bindings`, no reachable reference to it
 * survives anywhere in the returned tree.
 */
export function propagationDecisionAt(node: Let): Let | undefined {
  if (node.letKind !== "let" && node.letKind !== "let*") return undefined;

  // Capture-avoidance (the one hazard a bare-Ref COPY uniquely has — a
  // literal init has no analog, since it names nothing): a copy-init
  // `Ref(name)` means "whatever `name` resolves to OUTSIDE this Let." A
  // propagated copy gets spliced somewhere inside `node.bindings`' own
  // inits (`let*` substitutes every subsequent sibling's init, not merely
  // the body) or `node.body` — so it is only safe when `name` is NOT bound
  // ANYWHERE reachable from either, at ANY depth: an immediate sibling
  // (`(let ((a 5) (b a)) (list a b))`'s `b` copies the OUTER `a`, but the
  // body sits inside local `a=5`'s scope), OR a rebinding several levels
  // down a sibling's own init or the body (`(let* ((a x) (b (let ((x 10)) a)))
  // …)` — splicing `a`'s copy of the OUTER `x` into `b`'s init would
  // capture the INNER `x=10` instead). `collectAllBoundNames` is the
  // whole-subtree (not merely top-level) census this needs; a plain set of
  // this Let's own immediate binding names would miss the second case.
  // Computed ONCE, checked in both branches.
  const ownNames = node.bindings.map((b) => b.name);
  const unsafeNames = collectAllBoundNames([...node.bindings.map((b) => b.init), ...node.body]);
  for (const n of ownNames) unsafeNames.add(n);
  const eligible = (init: CoreForm): boolean => isTriviallyPure(init) && !(init.kind === "Ref" && unsafeNames.has(init.name));

  const survivors: Binding[] = [];
  const map = new Map<string, CoreForm>();
  let changed = false;

  if (node.letKind === "let") {
    // Malformed/duplicate-bound source (illegal per R7RS for PLAIN `let` —
    // "It is an error for a <variable> to appear more than once…") — decline
    // entirely rather than guess which occurrence a later reference means.
    // `let*` legitimately re-binds the same name (progressive shadowing,
    // `(let* ((x 1) (x (f x))) x)`) — handled correctly by the sequential
    // map below, never rejected as malformed.
    if (new Set(ownNames).size !== ownNames.length) return undefined;
    for (const b of node.bindings) {
      if (eligible(b.init)) {
        map.set(b.name, b.init);
        changed = true;
      } else {
        survivors.push(b);
      }
    }
  } else {
    // let*: each binding's init is substituted through the ACCUMULATED map
    // FIRST — a multi-hop copy chain (`(let* ((a x) (b a)) …)`, `x` free
    // outside) resolves down to its ultimate non-map-key name before
    // `eligible` ever inspects it, so the `unsafeNames` guard above only
    // ever fires on a genuinely same-node-owned target, never a fully-
    // chained-through outer one.
    for (const b of node.bindings) {
      const init = substitute(b.init, map);
      if (init !== b.init) changed = true;
      if (eligible(init)) {
        map.set(b.name, init);
        changed = true;
      } else {
        map.delete(b.name); // this binding shadows any earlier same-named entry
        survivors.push(init === b.init ? b : { ...b, init });
      }
    }
  }

  if (!changed) return undefined;
  const body = substituteBody(node.body, map);
  return { ...node, bindings: survivors, body };
}

// ── top-level define propagation ───────────────────────────────────────────────────

/**
 * Whole-program pass for top-level `define` VALUE bindings (`Define`, never
 * `DefineFn`) — called directly by `../walker/walk.ts` (no per-model state
 * needed, so no `SchemeSemanticModel` view mediates it, mirroring how
 * `walk.ts` already calls its own `flattenTopBegins` directly), UNCONDITIONALLY
 * (no opt-in gate — see "never deletes", below). Applied to the
 * ALREADY-FLATTENED top-level forms (after `flattenTopBegins`, before
 * `preRegisterDefines`), so there is no top-level `Begin` left to consider.
 *
 * NEVER DELETES A BINDING (WALKER-NAMING audit finding #2's fix): an earlier
 * version of this pass both substituted a folded define's value into every
 * use site AND removed the define itself from the returned forms. That is
 * unsound the moment a caller's face treats every top-level define as a
 * named export (`../build/scm-module.ts`'s module face) — deleting the
 * binding drops the export even though nothing about its VALUE changed.
 * Whether a now-unreferenced define is safe to physically remove depends on
 * rootedness knowledge (is this name exported? effectful?) this module does
 * not have — that is exclusively `../shake/index.ts`'s `shakeTopLevel`
 * decision, which runs immediately after this pass in `walk.ts` and DOES
 * carry that knowledge, opt-in, per caller. This pass ONLY ever substitutes
 * a literal value at its read sites; the origin `define` always survives,
 * verbatim, for shake (or nothing, if the caller never wires shake in) to
 * decide. Because nothing is ever deleted, running this pass is
 * unconditionally SOUND for every caller — there is no on/off gate here,
 * matching `propagationDecisionAt`'s own "not itself optional" default in
 * `walk.ts`'s `propagationFor`.
 *
 * LITERAL/QUOTE ONLY — deliberately narrower than `propagationDecisionAt`'s
 * `let`/`let*` floor, which also allows a bare-`Ref` copy. Top level is
 * letrec*-flavored (every name visible everywhere, forward references
 * resolve for mutual recursion — `walk.ts`'s own module header): a
 * `(define a b) (define b 5)` program has `a`'s copy-init referring to a
 * name defined LATER in program order. Chaining copy-propagation soundly
 * across that order needs a fixpoint (or a dependency-ordered pass) this
 * module does not build — a naive single left-to-right scan would need to
 * resolve `a`'s copy through `b` before `b`'s own literal is even reached,
 * which one linear scan cannot do soundly regardless of whether the origin
 * define is ever deleted. A literal's value has no such dependency (it
 * never refers to another binding), so collecting every single-definition,
 * literal-valued top-level `define` in one order-independent scan and
 * substituting them all at once is unconditionally safe regardless of
 * declaration order. Copy-propagation across top-level defines is
 * deferred, not attempted unsound.
 *
 * A name defined more than once at top level (redefinition) is never
 * propagated — declines rather than guess which definition a reference
 * means. Identity fast path: returns `forms` itself, unchanged, when
 * nothing propagates (mirrors `materializeSharedBindings`'s own "no groups
 * ⇒ unit unchanged" convention).
 *
 * IMPLEMENTATION NOTE — substituted PER FORM (`forms.map((f) => substitute(f,
 * map))`), never through `substituteBody(forms, map)`: `substituteBody`'s own
 * shadow guard (`collectBodyShadowNames`) treats every name `forms` itself
 * defines as a local shadow of that SAME body — correct when `forms` is a
 * NESTED body and `map` came from an OUTER scope, but wrong here, where
 * `map`'s keys are drawn from `forms`' OWN top-level defines: the guard
 * would see each folded name "shadowing itself" and strip it from `map`
 * before anything substitutes, silently defeating every fold. Calling
 * `substitute` directly, per top-level form, skips only that outermost,
 * self-referential shadow check; `substitute`'s own recursive dispatch still
 * calls `substituteBody` (with correct shadow-protection) for every NESTED
 * body a deeper `Lambda`/`DefineFn`/`Let` introduces, so a local same-named
 * rebinding several scopes down still shadows correctly.
 */
export function propagateTopLevelDefines(forms: readonly CoreForm[]): readonly CoreForm[] {
  const counts = new Map<string, number>();
  for (const f of forms) {
    if (f.kind === "Define" || f.kind === "DefineFn") counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
  }

  const map = new Map<string, CoreForm>();
  for (const f of forms) {
    if (
      f.kind === "Define" &&
      counts.get(f.name) === 1 &&
      (f.value.kind === "Lit" || f.value.kind === "Quote")
    ) {
      map.set(f.name, f.value);
    }
  }

  if (map.size === 0) return forms;
  return forms.map((f) => substitute(f, map));
}

// ── structural identity: same-branch `if` ──────────────────────────────────────────

/** Narrow structural equality — ONLY ever called on two nodes already proven
 *  `isTriviallyPure` (see `sameBranchDecisionAt`, below): a `Lit`/`Quote`/
 *  `Ref` carries no sub-expression that could itself need a purity/effect
 *  argument, so a plain value comparison is the whole story. */
function triviallyPureEqual(a: CoreForm, b: CoreForm): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "Ref":
      return a.name === (b as Ref).name;
    case "Lit":
      return litValueEqual(a.value, (b as Extract<CoreForm, { kind: "Lit" }>).value);
    case "Quote":
      return quoteDatumEqual(a.datum, (b as Extract<CoreForm, { kind: "Quote" }>).datum);
    default:
      return false; // unreachable given the isTriviallyPure precondition
  }
}

function litValueEqual(a: LitValue, b: LitValue): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "number":
      return a.text === (b as Extract<LitValue, { kind: "number" }>).text;
    case "string":
      return a.value === (b as Extract<LitValue, { kind: "string" }>).value;
    case "boolean":
      return a.value === (b as Extract<LitValue, { kind: "boolean" }>).value;
    case "keyword":
      return a.name === (b as Extract<LitValue, { kind: "keyword" }>).name;
    case "undefined":
      return true;
  }
}

function quoteDatumEqual(a: QuoteDatum, b: QuoteDatum): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "number":
      return a.text === (b as Extract<QuoteDatum, { kind: "number" }>).text;
    case "string":
      return a.value === (b as Extract<QuoteDatum, { kind: "string" }>).value;
    case "boolean":
      return a.value === (b as Extract<QuoteDatum, { kind: "boolean" }>).value;
    case "symbol":
      return a.name === (b as Extract<QuoteDatum, { kind: "symbol" }>).name;
    case "list": {
      const bl = (b as Extract<QuoteDatum, { kind: "list" }>).items;
      return a.items.length === bl.length && a.items.every((x, i) => quoteDatumEqual(x, bl[i]!));
    }
  }
}

/**
 * `sm.sameBranchOf`'s underlying decision — a SEPARATE structural identity
 * from static prevaluation (which folds on `cond`'s own provable value; this
 * folds when `cond` is UNKNOWN but `then`/`else` turn out to be the same
 * value regardless). Consulted AFTER `prevalueOf` declines (mirrors
 * `../walker/walk.ts`'s existing `prevalueOf`-then-lower-normally order —
 * `sameBranchOf` is a second, independent fallback at the same site).
 *
 * DELIBERATELY NARROW: both `then` and `else` must be `isTriviallyPure`
 * (Lit/Quote/Ref) and equal by value — NOT general structural equality over
 * arbitrary `App`s. A broader version (`(if c (infer m p) (infer m p))` →
 * "collapse to one call") is tempting but is NOT free the way this module's
 * name promises: proving that dropping one of two textually-identical
 * `App`s never changes crossing/provenance COUNTING (as opposed to VALUE)
 * needs the same `cacheClass`/`provenance` purity gate `../naming/
 * shared-bindings.ts`'s CSE reads off the registry — exactly the general
 * pure-expression-inlining case this lane's own charter defers. Restricting
 * to the trivially-pure floor sidesteps the question entirely: a literal or
 * a variable read has no crossing to double-count.
 *
 * `cond`'s own purity gates whether it is dropped or kept:
 *   - `isTriviallyPure(cond)` (Lit/Quote/Ref — no possible effect, not even
 *     a lookup that could observe anything): drop it, return `then` alone.
 *   - anything else (an `App`, possibly `(infer …)`): `cond` MUST still be
 *     evaluated for its effect — returns `Begin({[cond, then]})`, which
 *     `../walker/walk.ts` already knows how to lower in every position this
 *     fold's two call sites need (`lowerExpr`'s "Begin" arm, `tailLoopForm`'s
 *     "Begin" arm) — never silently dropping `cond`'s evaluation.
 *
 * `Door`/`Let`/`NamedLet`/`Lambda`/`Define`/`DefineFn` branches are never
 * considered equal (`triviallyPureEqual`'s `default: false` is unreachable
 * for those since they fail `isTriviallyPure` first) — moot here since only
 * trivially-pure branches ever reach the comparison at all.
 */
export function sameBranchDecisionAt(node: If): CoreForm | undefined {
  if (!isTriviallyPure(node.then) || !isTriviallyPure(node.else)) return undefined;
  if (!triviallyPureEqual(node.then, node.else)) return undefined;
  if (isTriviallyPure(node.cond)) return node.then;
  const begin: Begin = { kind: "Begin", id: node.id, span: node.span, body: [node.cond, node.then] };
  return begin;
}
