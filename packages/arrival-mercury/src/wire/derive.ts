/**
 * derive() — walk CoreForm BACKWARD from the program's output expression to
 * crossings or literals, producing the wire descriptor(s) for its leaf/leaves
 * (types.ts; docs/foundations/arrival-scheme/provenance-by-perturbation.md §3).
 *
 * "Crossing" here is exactly the semantic model's boundary-anchor half of the
 * anchor taxonomy (scheme-semantic-model.md §1: "the two boundary anchors: program
 * inputs … plus program output"): a reference this walk cannot resolve to any
 * local binding (a `let`, a top-level `define`, a function parameter) IS the
 * program's own input crossing — there is nothing more local to walk into, so the
 * name itself is the anchor. Registry-declared effect crossings (the other half —
 * "registry provenance ≠ pure") are a SEPARATE, harvestable fact this module does
 * not itself consult: nothing in the required corpus calls a registered capability,
 * and inventing an unverified impure-primitive allowlist would be exactly the
 * un-anchored guessing the design doc's registry-harvest module (../registry/) exists
 * to replace. A caller with an `EmitRegistry` in hand can extend the boundary rule
 * itself (a `Ref`/`App.fn` name present in the registry with a non-forwarding
 * `ProvenanceRole` is a crossing by the same "cannot walk past it" logic) — this
 * module's walk is the part that is truly static regardless of which registry is
 * assembled.
 */
import type { App, Binding, ClassifyResult, CoreForm, KwEntry } from "../coreform/types.js";

import type { LeafDescriptor, LeafPath, WireArg, WireDescriptor, WireStep } from "./types.js";

/** Local bindings this walk can see PAST — name → the expression that produces the
 *  bound value. Never mutated; each nested scope is its own map layered on the
 *  parent's entries at construction time (immutability's own discipline, applied to
 *  this walk's own state, not just arrival's). A name ABSENT here is exactly a free
 *  reference — the boundary-in anchor. */
type Scope = ReadonlyMap<string, CoreForm>;

const holeDescriptor = (reason: string): WireDescriptor => ({ source: { kind: "Hole", reason }, steps: [] });

const pathEquals = (a: LeafPath, b: LeafPath): boolean => a.length === b.length && a.every((seg, i) => seg === b[i]);

/** `fn`'s plain callee name when it's a bound reference (`(cons a b)`, `(filter …)`),
 *  else `undefined` — a computed/opaque callee (`((pick-fn) …)`, a literal head).
 *  Only a `Ref` counts: a keyword `Lit` head is accessor syntax (`deriveApp`
 *  handles it directly; it is never "cons"/"list"/"filter"). */
const calleeName = (fn: CoreForm): string | undefined => (fn.kind === "Ref" ? fn.name : undefined);

/**
 * Strip through everything that is transparent forwarding, not a value in its own
 * right: a resolved reference (an alias — identity, per the semantic model's
 * provenance-program table), a `let`/named-`let` (extends scope, forwards to the
 * body's last expression — Scheme's own "a body's value is its last form"), a
 * `begin` (same forwarding, no new scope), a top-level `define` reached as a bare
 * expression. Returns the first node that is an actual value shape to dispatch on,
 * plus the scope in effect at that point.
 *
 * `ok: false` only for shapes this walk cannot forward through safely (an empty
 * `let`/`begin` body — CoreForm's own grammar does not guarantee non-emptiness for
 * these, unlike `DefineFn`) — an honest `Hole`, never a crash.
 *
 * NOT modeled: a `NamedLet`'s own loop name, referenced recursively from its body,
 * falls through to the default (unresolved ⇒ boundary-in anchor) rather than being
 * unfolded — unfolding a loop is a fixpoint question (the semantic model's "loop
 * summarization", scheme-semantic-model.md §1), a different and larger mechanism
 * than this walk.
 */
function reduceToValue(expr: CoreForm, scope: Scope): { readonly ok: true; readonly expr: CoreForm; readonly scope: Scope } | { readonly ok: false; readonly reason: string } {
  let cur = expr;
  let sc = scope;
  // Cycle guard: a `Ref` chain that resolves back to a node it already followed is a
  // cyclic binding (`(define x x)`, mutual `(define a b) (define b a)`, a `letrec`
  // self-knot). This walk has NO fuel bound (the probe's `budgetMs` is the dynamic
  // plane; this is static), and the threat model is "the model writes the program" —
  // so a degenerate-but-classifiable input must terminate as an honest Hole, never
  // hang the analyzer. Object identity: a bound value is one stored node, revisited.
  const seen = new Set<CoreForm>();
  for (;;) {
    if (cur.kind === "Ref") {
      const bound = sc.get(cur.name);
      if (bound === undefined) return { ok: true, expr: cur, scope: sc }; // free — the boundary
      if (seen.has(bound)) return { ok: false, reason: "cyclic-binding" };
      seen.add(bound);
      cur = bound;
      continue;
    }
    if (cur.kind === "Let" || cur.kind === "NamedLet") {
      if (cur.body.length === 0) return { ok: false, reason: "empty-body" };
      const extended = new Map(sc);
      for (const b of cur.bindings as readonly Binding[]) extended.set(b.name, b.init);
      sc = extended;
      cur = cur.body[cur.body.length - 1]!;
      continue;
    }
    if (cur.kind === "Begin") {
      if (cur.body.length === 0) return { ok: false, reason: "empty-body" };
      cur = cur.body[cur.body.length - 1]!;
      continue;
    }
    if (cur.kind === "Define") {
      cur = cur.value;
      continue;
    }
    return { ok: true, expr: cur, scope: sc };
  }
}

/** The generic `App` case: an ordinary (or accessor) call. Accessor syntax
 *  (`(:field obj)`, classified per classify.ts's universal atom rule to
 *  `fn: Lit(keyword "field")`) traces `obj` and appends one step named by the
 *  colon-stripped field name — arity exactly 1, the accessor shape; a keyword head
 *  with other arities is not part of the surface this walks specially and falls
 *  through to the generic heuristic below, which still produces an honest (if
 *  unremarkable) descriptor.
 *
 *  For a plain named call, the traced argument is the FIRST position whose own
 *  derivation is not a bare program constant — a call with any vertex-derived
 *  argument is tracing that dependency forward; an all-literal call has nothing
 *  to trace, and defaulting to argument 0 correctly reports the whole call as
 *  ungrounded (its source is `Literal`, same as any of its arguments). Every other
 *  argument position is recorded as `otherArgs`, each with its OWN descriptor — the
 *  residue policy.ts checks for is exactly a `Literal`-sourced entry there. */
function deriveApp(expr: App, scope: Scope): WireDescriptor {
  if (expr.fn.kind === "Lit" && expr.fn.value.kind === "keyword" && expr.positionalArgs.length === 1 && expr.kwargs.length === 0) {
    const inner = deriveScalar(expr.positionalArgs[0]!, scope);
    const step: WireStep = { op: expr.fn.value.name, argIndex: 0, otherArgs: [] };
    return { source: inner.source, steps: [...inner.steps, step] };
  }

  const head = calleeName(expr.fn);
  if (head === undefined) return holeDescriptor("computed-callee");
  // `filter`'s survivor set is a runtime fact (which elements passed `pred`) — no
  // static shape names it (scheme-semantic-model.md §1's `route` provenance program:
  // "driven by the value plane's already-computed selection outcome"). Named
  // explicitly per the design doc's own list ("computed key, filter survivor,
  // computed callee").
  if (head === "filter") return holeDescriptor("filter-survivor");

  // kwargs (`App.kwargs`, spec §4.7 — value-bearing, engine-walker collapses them
  // into the trailing object at runtime) are SIBLING arguments exactly like extra
  // positionals: a literal passed as `:suffix "FAKE"` reaches the output value, so
  // it MUST enter `otherArgs` or `isCleanContent`'s "every reachable sub-descriptor"
  // contract is a lie and the residue channel is invisible to BOTH planes (the
  // static walk skips it; the probe checks marks, not residue). Numbered after the
  // positionals; the residue policy is key-agnostic (it reads the descriptor, not
  // the arg's name), so a synthetic index is enough.
  const kwArgs: readonly WireArg[] = expr.kwargs.map((kw, i) => ({ argIndex: expr.positionalArgs.length + i, descriptor: deriveScalar(kw.value, scope) }));

  if (expr.positionalArgs.length === 0) {
    // No positional value to trace forward. A bare nullary call is an opaque source;
    // a kwargs-only call is the same (its kwargs have no traced position to sit
    // beside) — either way an honest Hole, fail closed. The kwargs cannot be
    // silently lost because the whole call is un-anchored regardless.
    return holeDescriptor(expr.kwargs.length > 0 ? "kwargs-only-call" : "nullary-call");
  }

  const argDescs = expr.positionalArgs.map((a) => deriveScalar(a, scope));
  let mainIdx = argDescs.findIndex((d) => d.source.kind !== "Literal");
  if (mainIdx === -1) mainIdx = 0;
  const inner = argDescs[mainIdx]!;
  const otherArgs: WireArg[] = [
    ...argDescs.map((descriptor, argIndex): WireArg => ({ argIndex, descriptor })).filter((arg) => arg.argIndex !== mainIdx),
    ...kwArgs,
  ];
  const step: WireStep = { op: head, argIndex: mainIdx, otherArgs };
  return { source: inner.source, steps: [...inner.steps, step] };
}

/** Dispatch on an ALREADY-`reduceToValue`-d expression — never re-reduces (callers
 *  that already hold a reduced `{expr, scope}` pair call this directly; everyone
 *  else goes through `deriveScalar`). */
function deriveReduced(expr: CoreForm, scope: Scope): WireDescriptor {
  switch (expr.kind) {
    case "Ref":
      // reduceToValue only returns a bare Ref when it is unresolved.
      return { source: { kind: "PVertice", anchorName: expr.name }, steps: [] };
    case "Lit":
      return { source: { kind: "Literal", lit: expr }, steps: [] };
    case "If":
      return {
        source: {
          kind: "Case",
          cond: deriveScalar(expr.cond, scope),
          alts: [deriveScalar(expr.then, scope), deriveScalar(expr.else, scope)],
        },
        steps: [],
      };
    case "App":
      return deriveApp(expr, scope);
    // `and`/`or` are value-returning CONTROL, so they are `Case`s, not holes —
    // the same selection-vs-content distinction `if` draws. `(or a b)` returns
    // `a` when `a` is truthy else `b` ⇒ Case(cond=a, alts=[a, rest]); `(and a b)`
    // returns `a` (=#f) when `a` is falsy else `b` ⇒ Case(cond=a, alts=[rest, a]).
    // Modelling them keeps the static wire from abstaining on the short-circuit
    // control that real programs use constantly — `(or (:cached e) "DEFAULT")` is
    // exactly a selection between a vertex value and a literal, which the seal
    // must see. n-ary folds right.
    case "Or":
      return deriveOrOr(expr.args, scope);
    case "And":
      return deriveAndAnd(expr.args, scope);
    default:
      return holeDescriptor(`unsupported-form:${expr.kind}`);
  }
}

/** `(or a b c…)` ≡ `(if a a (or b c…))` — a right fold of `Case(cond=a, alts=[a, rest])`.
 *  Empty `(or)` ≡ `#f` is a constant with no source node; hole it (never reached
 *  in real programs — the classifier folds it to a boolean literal upstream). */
function deriveOrOr(args: readonly CoreForm[], scope: Scope): WireDescriptor {
  if (args.length === 0) return holeDescriptor("empty-or");
  const [first, ...rest] = args;
  const firstDesc = deriveScalar(first!, scope);
  if (rest.length === 0) return firstDesc;
  return { source: { kind: "Case", cond: firstDesc, alts: [firstDesc, deriveOrOr(rest, scope)] }, steps: [] };
}

/** `(and a b c…)` ≡ `(if a (and b c…) a)` — a right fold of `Case(cond=a, alts=[rest, a])`. */
function deriveAndAnd(args: readonly CoreForm[], scope: Scope): WireDescriptor {
  if (args.length === 0) return holeDescriptor("empty-and");
  const [first, ...rest] = args;
  const firstDesc = deriveScalar(first!, scope);
  if (rest.length === 0) return firstDesc;
  return { source: { kind: "Case", cond: firstDesc, alts: [deriveAndAnd(rest, scope), firstDesc] }, steps: [] };
}

/** The recursive entry for a SCALAR position (a position that is not, itself,
 *  being split into further leaves — see `enumerateLeaves` for the compound
 *  case). Reduces transparent forwarding first, then dispatches. */
function deriveScalar(expr: CoreForm, scope: Scope): WireDescriptor {
  const r = reduceToValue(expr, scope);
  return r.ok ? deriveReduced(r.expr, r.scope) : holeDescriptor(r.reason);
}

/**
 * The leaf-splitting walk: recognizes the compound constructors whose OUTPUT is
 * not one scalar leaf but several independently-provenanced ones — `(cons a b)`
 * (`car`/`cdr`), `(list a b …)` (index leaves), a `Dict` literal (key leaves) — and
 * recurses per element, extending `path`. Anything else is one scalar leaf at the
 * current `path`, derived by `deriveReduced`.
 *
 * A resolved `Ref`/`let`/`begin` alias to a compound is followed THROUGH
 * `reduceToValue` before this check, so `(let ((p (cons a b))) p)` still splits
 * into `car`/`cdr` leaves — the alias is transparent, exactly as it is for a
 * scalar position.
 */
function enumerateLeaves(expr: CoreForm, scope: Scope, path: LeafPath): readonly LeafDescriptor[] {
  const r = reduceToValue(expr, scope);
  if (!r.ok) return [{ path, descriptor: holeDescriptor(r.reason) }];
  const { expr: e, scope: sc } = r;

  if (e.kind === "App") {
    const head = calleeName(e.fn);
    if (head === "cons" && e.positionalArgs.length === 2) {
      return [
        ...enumerateLeaves(e.positionalArgs[0]!, sc, [...path, "car"]),
        ...enumerateLeaves(e.positionalArgs[1]!, sc, [...path, "cdr"]),
      ];
    }
    if (head === "list") {
      return e.positionalArgs.flatMap((a, i) => enumerateLeaves(a, sc, [...path, i]));
    }
  }
  if (e.kind === "Dict") {
    return (e.entries as readonly KwEntry[]).flatMap((entry) => enumerateLeaves(entry.value, sc, [...path, entry.key]));
  }

  return [{ path, descriptor: deriveReduced(e, sc) }];
}

/** Every top-level `define` in `classified.forms`, as a name → value scope layer —
 *  the outermost scope a later top-level form (or the output expression itself)
 *  resolves against. Last-write-wins on a repeated name, mirroring ordinary
 *  top-level re-`define` shadowing. */
function topLevelScope(classified: ClassifyResult): Scope {
  const scope = new Map<string, CoreForm>();
  for (const form of classified.forms) {
    if (form.kind === "Define") scope.set(form.name, form.value);
  }
  return scope;
}

/**
 * derive() — the module's entry point. `classified.forms`' LAST top-level form is
 * the program's output expression (a bare top-level `define` there is unwrapped to
 * its value; everything earlier is available as scope, per `topLevelScope`).
 *
 * With no `leafPath`, returns every leaf reachable by splitting compound
 * constructors (`enumerateLeaves`) — one entry for a scalar output. With a
 * `leafPath`, returns just the matching entry (empty if the path does not address
 * an actual leaf of this output's shape — not a throw: an invalid path is a
 * caller-supplied fact to check, not a program-shape defect).
 *
 * Throws only when there is no program at all (`classified.forms` empty) — that is
 * a construction misuse of this function, not a data-shape question the three-way
 * verdict is meant to answer.
 */
export function derive(classified: ClassifyResult, leafPath?: LeafPath): readonly LeafDescriptor[] {
  if (classified.forms.length === 0) {
    throw new Error("derive: classified.forms is empty — there is no output expression to derive a wire descriptor from.");
  }
  const scope = topLevelScope(classified);
  const last = classified.forms[classified.forms.length - 1]!;
  const output = last.kind === "Define" ? last.value : last;
  const leaves = enumerateLeaves(output, scope, []);
  return leafPath === undefined ? leaves : leaves.filter((leaf) => pathEquals(leaf.path, leafPath));
}
