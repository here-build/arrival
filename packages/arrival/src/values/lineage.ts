/**
 * SPIKE — the lineage data model + STATIC chunk classifier.
 * Build-step 1 of docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md §5.
 *
 * Proves the centerpiece: provenance is a static lineage TREE — pipe / merge /
 * fan / mux nodes — *minted only at Rosetta crossings*, with the SHAPE derivable
 * from the parsed AST BEFORE execution (operand-arity over non-literal operands).
 * Runtime only stamps Rosetta leaf-ids into the skeleton's slots. One tree then
 * answers BOTH the teleological full-cone (seal: walk to every leaf) and the
 * minimal demand-cone (e.g. a count, which prunes a length-preserving fan).
 *
 * Standalone + throwaway, like LazySeq.ts — NOT wired into the interpreter. It
 * operates on real AST nodes (Pair / SchemeSymbol from the reader); classify()
 * runs no evaluation. We claim none of the lineage; see the design note §11/§12
 * (how-provenance, Galois slicing, SSA def-use, why/how/where).
 *
 * SPECIAL FORMS. This engine dispatches `if`/`cond`/`let`/`let*`/`letrec`/`begin`/
 * `and`/`or`/`lambda` DIRECTLY from `SPECIAL_FORMS` (eval/evaluator.ts) — they are
 * never macro-expanded to applications — so classify() handles the surface Pairs:
 *   - `if`   → mux(selector=test, arms=[then, else?])
 *   - `cond` → mux over clauses (else is an arm; a `=>` clause threads the test
 *     cone into its arm)
 *   - `let` / `let*` / `letrec` → TRANSPARENT: the body is classified with each
 *     bound symbol's leaf-slot SUBSTITUTED by classify(its RHS). The result equals
 *     the inlined form (golden-prov-special-forms.test.ts:121-163). `let*`/`letrec`
 *     thread substitutions left-to-right; a named let is recursive and stays opaque.
 *   - `begin` → pass-through of the LAST expression
 *   - `and` / `or` → selector-free value-select: cone = union of operand cones,
 *     with NO predicate-taint (a static over-approximation of the short-circuit;
 *     DR7: the runtime stays sequential short-circuit, never parallel-or)
 *   - `lambda` literal → contributes NO provenance at its definition site
 *
 * Per DR3 of the finalization plan the `mux` is FORWARD-COMPAT ONLY in v0.1: the
 * static cone is the conservative selector ∪ arms (it cannot know the taken arm),
 * and the byte-identical control-flow "why" (predicate-taint, failed-clause
 * non-leak) stays eager-sourced via the evaluator's control-flow wrappers. We owe
 * the *shape*, not a runtime taken-arm protocol.
 *
 * On the Const-applicative option (research update / Build-Systems-à-la-Carte):
 * rebuilding classify() as a second Fantasy-Land interpretation (Applicative =
 * static structure, Monad = runtime) is the right frame for the v0.2 per-op
 * ADJOINT rule table, where ops already live in the fl-interop tagless algebra.
 * But classify() runs on SURFACE reader Pairs whose special forms never enter
 * that algebra; a Const reinterpretation would first need a full surface→tagless
 * compiler duplicating the evaluator's own special-form dispatch — strictly more
 * code than matching the Pairs directly. So v0.1 does the direct AST handling; the
 * Const-applicative cut is filed as the v0.2 follow-up (our `walk()` is already
 * the backward pass — v0.2 is "populate the adjoint table," not "flip a mode").
 */
import { is_pair } from "./value-guards.js";
import { SchemeSymbol } from "./SchemeSymbol.js";
import type { Pair } from "./Pair.js";
import type { SchemeValue } from "./types.js";

/** A CANONICAL member-read step — the *where* of where-provenance. The field node
 *  is normalized to ONE of these regardless of the surface accessor syntax
 *  (`(:foo x)` / `(@ x :foo)` / `(car x)` / `(vector-ref x i)`), so a lineage
 *  chunk's `uneval` targets minimal scheme with no polyglot sugar; re-sugaring
 *  (`(@ obj :foo)` → `obj.foo`) is an optional later display layer, not the
 *  carrier's concern. Mirrors `trace.ts`'s runtime `FieldPointMeta = {origin,key}`
 *  (v0.2 §"The carrier"). */
export type PathStep =
  | { readonly field: string } // a named key — (:foo x) / (@ x :foo): step = {field:"foo"}
  | { readonly car: true } // the head of a pair — (car x)
  | { readonly index: number }; // a positional index — (vector-ref x i) / (list-ref x i), i a LITERAL int

/** A node of the static lineage skeleton. `slot`/`op` names are filled with the
 *  actual provenance set at runtime (the leaf-stamping step). */
export type LineageNode =
  | { readonly kind: "literal" } // self-evaluating datum / lambda literal — never carries provenance
  | { readonly kind: "leaf"; readonly slot: string } // variable ref — runtime fills from its binding
  | { readonly kind: "source"; readonly op: string } // a Rosetta-in mint (infer/fetch/db-read/…)
  | { readonly kind: "pipe"; readonly op: string; readonly child: LineageNode } // ≤1 prov input → pass-through
  | { readonly kind: "merge"; readonly op: string; readonly children: readonly LineageNode[] } // ≥2 → fan-in
  // A WHERE-PROVENANCE lens step: a canonical member-read (`step`) focused on
  // `child`. walk() descends the focused child ONLY — siblings are pruned
  // STRUCTURALLY (never built as branches), so the hole-placement and the
  // addressing are the same act. The static form of trace.ts's runtime field-point
  // (v0.2 §"The carrier"). `op` records the surface head for the viz / debug.
  | { readonly kind: "field"; readonly op: string; readonly step: PathStep; readonly child: LineageNode }
  // map/filter: a uniform per-element pipe template. `lengthPreserving` (map=true,
  // filter=false) gates the count-cone prune — see walk()/countCone. `template`
  // (present iff the fan function is a lambda) carries the per-element body — the
  // z-stack axis preserved PARAMETRIC so a field projected through a fan composes
  // without unrolling (the fan×lens product, v0.2 §"The viz constraint"). It is a
  // carrier-/viz-shaping structure, NOT a cone contributor: walk() never descends
  // it (the source+introduces over-approximation already bounds the per-element
  // cone), so fullCone/countCone stay byte-identical to a template-less fan.
  | {
      readonly kind: "fan";
      readonly op: string;
      readonly introduces: boolean;
      readonly lengthPreserving: boolean;
      readonly source: LineageNode;
      readonly template?: LineageNode;
    }
  // if/cond — a value-SELECT over arms gated by a selector (the test cone). The
  // static cone is selector ∪ arms (conservative; the taken arm is a runtime fact).
  | { readonly kind: "mux"; readonly op: string; readonly selector: LineageNode; readonly arms: readonly LineageNode[] }
  | { readonly kind: "opaque"; readonly op: string; readonly children: readonly LineageNode[] }; // black-box: holistic

/** Static classification of operators — read from the env's binding table in a
 *  real build; passed explicitly here so the spike is deterministic. */
export interface Classifier {
  isPure(op: string): boolean; // +, *, <, car, list … — propagate, never mint
  isRosettaIn(op: string): boolean; // infer, fetch, db-read … — MINT a leaf
  isFan(op: string): boolean; // map, filter — a uniform per-element pipe template
  isOpaque(op: string): boolean; // membrane / foreign call — irreducible black box
}

function opName(x: SchemeValue): string {
  const v = (x as { valueOf?: () => unknown })?.valueOf?.();
  return typeof v === "string" || typeof v === "symbol" ? String(v) : String(x);
}

/**
 * The special-form heads `classify()` models BY SHAPE (the switch in classifyWith
 * below). These resolve to `Macro` instances in the live env — the evaluator
 * dispatches them from SPECIAL_FORMS, not by macro expansion — so a consumer that
 * skips "macro heads" (e.g. the shadow assert) must EXCLUDE these: classify handles
 * them, they are in scope, not opaque macros. SINGLE SOURCE OF TRUTH — keep in lock
 * step with the switch (adding a case here without the switch over-asserts; the
 * reverse over-skips). `quote`/`lambda` produce a literal but are still "handled". */
export const CLASSIFIED_SPECIAL_FORMS: ReadonlySet<string> = new Set([
  "if",
  "cond",
  "let",
  "let*",
  "letrec",
  "letrec*",
  "begin",
  "when",
  "unless",
  "and",
  "or",
  "lambda",
  "quote",
]);

/** Surface-form heads dispatched by SPECIAL_FORMS, recognised by name. */
const isSym = (x: SchemeValue, name: string): boolean => x instanceof SchemeSymbol && opName(x) === name;

/** A datum that is neither a variable (SchemeSymbol) nor an application (Pair). */
function isLiteral(x: SchemeValue): boolean {
  return !(x instanceof SchemeSymbol) && !is_pair(x);
}

function operands(app: Pair): SchemeValue[] {
  const out: SchemeValue[] = [];
  let n: SchemeValue = app.cdr;
  while (is_pair(n)) {
    out.push(n.car);
    n = n.cdr;
  }
  return out;
}

const isProvBearing = (n: LineageNode): boolean => n.kind !== "literal";

/** A LITERAL integer datum's value (`(vector-ref x 1)` → `1`), else null. The
 *  index must be a self-evaluating exact integer; a variable index (`(vector-ref
 *  x n)`) leaves the form a plain op (no static field — the key isn't known). */
function literalIndex(x: SchemeValue): number | null {
  if (x instanceof SchemeSymbol || is_pair(x)) return null;
  const v = (x as { valueOf?: () => unknown })?.valueOf?.();
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/**
 * Recognize a member-read across its SURFACE syntaxes and return the CANONICAL
 * step + the projected argument expression — else null. Mirrors trace.ts's
 * `accessorField` (65-70) for the keyword head, generalized to the four accessor
 * shapes consumers pin (v0.2 §"The carrier"):
 *   - `(:foo x)`        keyword head — a SchemeSymbol `__name__` ":foo" (len>1) → {field:"foo"}
 *   - `(@ x :foo)`      membrane.readMember — key is the 2nd operand (`:foo` symbol or "foo" string)
 *   - `(car x)`         pair head → {car:true}
 *   - `(vector-ref x i)` / `(list-ref x i)` with a LITERAL int i → {index:i}
 * The emitted node is uniform regardless of which surface produced it; the
 * no-lookahead property the sampler relies on lives at this canonical level.
 */
function memberRead(head: SchemeValue, args: SchemeValue[]): { step: PathStep; argExpr: SchemeValue } | null {
  if (!(head instanceof SchemeSymbol)) return null;
  const name = opName(head);

  // (:foo x) — keyword accessor. Head is `:foo`; a bare `:` (no field) is not one.
  if (name.length > 1 && name.startsWith(":") && args.length >= 1) {
    return { step: { field: name.slice(1) }, argExpr: args[0] };
  }

  // (@ x :foo) / (@ x "foo") — membrane member-read; same canonical step. The key
  // is the SECOND operand: a `:foo` keyword symbol, a "foo" string, or a literal int.
  if (name === "@" && args.length >= 2) {
    const key = args[1];
    const keyName = key instanceof SchemeSymbol ? opName(key) : null;
    if (keyName !== null && keyName.length > 1 && keyName.startsWith(":")) {
      return { step: { field: keyName.slice(1) }, argExpr: args[0] };
    }
    if (!(key instanceof SchemeSymbol) && !is_pair(key)) {
      const kv = (key as { valueOf?: () => unknown })?.valueOf?.();
      if (typeof kv === "string") return { step: { field: kv }, argExpr: args[0] };
      const ki = literalIndex(key);
      if (ki !== null) return { step: { index: ki }, argExpr: args[0] };
    }
    return null; // computed key (`(@ x k)`) — not a static field
  }

  // (car x) — the head of a pair.
  if (name === "car" && args.length >= 1) return { step: { car: true }, argExpr: args[0] };

  // (vector-ref x i) / (list-ref x i) — a positional index, i a LITERAL integer.
  if ((name === "vector-ref" || name === "list-ref") && args.length >= 2) {
    const i = literalIndex(args[1]);
    if (i !== null) return { step: { index: i }, argExpr: args[0] };
  }

  return null;
}

/** Pull the parameter symbols out of a lambda's formal list — `(it)` → ["it"],
 *  `(a b)` → ["a","b"]. A variadic/rest tail (`(a . r)`, or a bare symbol formal)
 *  is ignored for binding (the element flows in via the leading positionals only).*/
function lambdaParams(formals: SchemeValue): string[] {
  const out: string[] = [];
  let n: SchemeValue = formals;
  while (is_pair(n)) {
    if (n.car instanceof SchemeSymbol) out.push(opName(n.car));
    n = n.cdr;
  }
  return out;
}

/**
 * Build a fan's per-element TEMPLATE when its function is a `(lambda (p…) body)`:
 * classify the body with each param bound to an ELEMENT leaf (`leaf{slot: p}`), so
 * a field projected inside the body nests under the fan (the fan×lens parametric
 * path). Returns undefined for a bare function symbol / non-lambda — those keep the
 * template-less fan, byte-identical to before. The template is a viz-/carrier-
 * shaping structure; walk() never descends it (cone neutrality).
 */
function classifyFanTemplate(fn: SchemeValue, c: Classifier, subst: Subst): LineageNode | undefined {
  if (!is_pair(fn) || !isSym(fn.car, "lambda")) return undefined;
  const afterKw = fn.cdr;
  if (!is_pair(afterKw)) return undefined;
  const params = lambdaParams(afterKw.car);
  const bodyForms = afterKw.cdr; // (body…) — classify the LAST (begin pass-through)
  // The element binds the params as leaves; the surrounding subst still applies to
  // free vars captured from the enclosing scope (e.g. an outer `let`-bound source).
  const extended = new Map(subst);
  for (const p of params) extended.set(p, { kind: "leaf", slot: p });
  return classifyBegin(bodyForms, c, extended);
}

/** The pipe-vs-merge arity cut, shared by pure ops and synthetic combinations
 *  (cond's selector, a `=>` arm). Mirrors `unionProvenance` (AValue.ts:104-120):
 *  drop empties, FORWARD a singleton (pipe), UNION ≥2 (merge). `op` tags the
 *  synthetic node honestly (the form/op that combines the children). */
function combine(op: string, nodes: readonly LineageNode[]): LineageNode {
  const bearing = nodes.filter(isProvBearing);
  if (bearing.length === 0) return { kind: "literal" };
  if (bearing.length === 1) return { kind: "pipe", op, child: bearing[0] };
  return { kind: "merge", op, children: bearing };
}

/** Substitution carried through `let`-family transparency: a bound symbol's
 *  leaf-slot resolves to classify(its RHS), making `(let ((x e)) … x …)` equal
 *  the inlined `… e …`. */
type Subst = ReadonlyMap<string, LineageNode>;
const NO_SUBST: Subst = new Map();

/**
 * Build the lineage skeleton from a parsed AST — STATIC, no evaluation. The
 * pipe-vs-merge cut is just the count of provenance-bearing (non-literal)
 * operands: ≤1 → pipe (pass-through), ≥2 → merge (the tree branches). Special
 * forms (if, cond, let-family, begin, and, or, lambda) are handled by shape —
 * see the file header.
 */
export function classify(ast: SchemeValue, c: Classifier): LineageNode {
  return classifyWith(ast, c, NO_SUBST);
}

function classifyWith(ast: SchemeValue, c: Classifier, subst: Subst): LineageNode {
  if (isLiteral(ast)) return { kind: "literal" };
  if (ast instanceof SchemeSymbol) {
    const slot = opName(ast);
    return subst.get(slot) ?? { kind: "leaf", slot };
  }

  const head = (ast as Pair).car;

  // ── Special forms (dispatched directly by the evaluator; surface Pairs) ──
  if (head instanceof SchemeSymbol) {
    const form = opName(head);
    const rest = (ast as Pair).cdr;
    switch (form) {
      case "if":
        return classifyIf(rest, c, subst);
      case "cond":
        return classifyCond(rest, c, subst);
      case "let":
      case "let*":
      case "letrec":
      case "letrec*":
        return classifyLet(rest, c, subst, form !== "let");
      case "begin":
        return classifyBegin(rest, c, subst);
      case "when": // (when test body…) ≡ (if test (begin body…))
      case "unless": // (unless test body…) ≡ (if (not test) (begin body…))
        return classifyGuardedBody(rest, c, subst, form);
      case "and":
      case "or":
        // Value-select over operands, NO predicate-taint. The result is one of
        // the operands (or #t/#f), so the cone is the union of operand cones.
        return combine(
          form,
          operands(ast as Pair).map((a) => classifyWith(a, c, subst)),
        );
      case "lambda":
        // A lambda literal is a value that carries no provenance at its
        // definition site (the body's lineage is realised only when applied).
        return { kind: "literal" };
      case "quote":
        return { kind: "literal" }; // (quote datum) is a self-evaluating constant
      default:
        break; // not a special form → fall through to application
    }
  }

  // application: (op . args). A computed operator `((f a) b)` stringifies via
  // opName — a step-2+ HOF hole (tracked in lineage-assumptions A21).
  const op = opName(head);
  const args = operands(ast as Pair);

  // ── WHERE-PROVENANCE: a member-read, NORMALIZED to a canonical field node ──
  // Recognized across all its surface syntaxes (keyword/`@`/`car`/`vector-ref`);
  // the EMITTED node is uniform regardless (the `uneval` targets minimal scheme,
  // so the chunk is one canonical primitive shape — v0.2 §"The carrier"). Placed
  // before the source/fan/opaque cuts so a projection head is never mis-read as a
  // pure op. cdr/cadr/rest stay PIPES (a sound over-approximation — consumers only
  // ever pin keyword/car/index fields).
  const projected = memberRead(head, args);
  if (projected !== null) {
    const child = classifyWith(projected.argExpr, c, subst);
    // D-v02-1 ABSORPTION (mirrors trace.ts:351-352): a field directly under another
    // field is a deeper pluck within the SAME producer pin — keep base + INNERMOST
    // step (return the inner field unchanged), do NOT compose nested keys into a
    // path. The viz reconstructs the path from the tree's nesting, not a stored one.
    if (child.kind === "field") return child;
    return { kind: "field", op, step: projected.step, child };
  }

  if (c.isRosettaIn(op)) return { kind: "source", op }; // provenance is BORN here

  if (c.isOpaque(op)) {
    const children = args.map((a) => classifyWith(a, c, subst)).filter(isProvBearing);
    return { kind: "opaque", op, children };
  }

  if (c.isFan(op)) {
    // (map f xs) / (filter p xs) — f introduces provenance iff it is itself a
    // Rosetta-in source. `lengthPreserving` distinguishes map (true) from filter
    // (false) for the count-cone prune in walk().
    const fn = args[0];
    const fanOp = opName(fn);
    const lengthPreserving = op === "map" || op === "vector-map";
    // FAN×LENS (v0.2 §"The viz constraint"): when the function is a lambda, classify
    // its body with each param bound to an ELEMENT leaf, nesting the per-element
    // template under the fan. A field projected inside the body (`(:bar it)`) then
    // becomes a field node UNDER the fan template — the z-stack axis stays parametric,
    // so a field-in-fan composes with a field-over-fan WITHOUT unrolling. A bare
    // function symbol (`(map infer xs)`) builds NO template — byte-identical to before.
    const template = classifyFanTemplate(fn, c, subst);
    return {
      kind: "fan",
      op: fanOp,
      introduces: c.isRosettaIn(fanOp),
      lengthPreserving,
      source: classifyWith(args[1], c, subst),
      ...(template !== undefined ? { template } : {}),
    };
  }

  // pure op: classify operands, keep the provenance-bearing ones, cut by arity.
  return combine(
    op,
    args.map((a) => classifyWith(a, c, subst)),
  );
}

/** `(if test then else?)` → mux(selector=test, arms=[then, else?]). */
function classifyIf(rest: SchemeValue, c: Classifier, subst: Subst): LineageNode {
  if (!is_pair(rest)) return { kind: "literal" };
  const test = rest.car;
  const afterTest = rest.cdr;
  const then_ = is_pair(afterTest) ? afterTest.car : undefined;
  const elseRest = is_pair(afterTest) ? afterTest.cdr : undefined;
  const else_ = is_pair(elseRest) ? elseRest.car : undefined;
  const arms = [then_, else_].filter((a): a is SchemeValue => a !== undefined).map((a) => classifyWith(a, c, subst));
  return { kind: "mux", op: "if", selector: classifyWith(test, c, subst), arms };
}

/** `(when/unless test body…)` ≡ a one-armed `if` over `(begin body…)`. */
function classifyGuardedBody(rest: SchemeValue, c: Classifier, subst: Subst, op: string): LineageNode {
  if (!is_pair(rest)) return { kind: "literal" };
  const test = rest.car;
  const body = classifyBegin(rest.cdr, c, subst);
  return { kind: "mux", op, selector: classifyWith(test, c, subst), arms: [body] };
}

/**
 * `(cond clause…)` → a mux whose selector is the union of all clause tests and
 * whose arms are the clause bodies. An `else` clause is a plain arm. A `=>`
 * clause `(test => proc)` threads the test cone into its arm (the arm value is
 * `(proc test)`). The static cone is selector ∪ arms (conservative — the
 * matched-clause-only "why" stays eager per DR3).
 */
function classifyCond(rest: SchemeValue, c: Classifier, subst: Subst): LineageNode {
  const tests: LineageNode[] = [];
  const arms: LineageNode[] = [];
  let node: SchemeValue = rest;
  while (is_pair(node)) {
    const clause = node.car;
    node = node.cdr;
    if (!is_pair(clause)) continue;
    const test = clause.car;
    const body = clause.cdr;

    if (isSym(test, "else")) {
      arms.push(classifyBegin(body, c, subst)); // else: no selector, the body is the value
      continue;
    }

    const testNode = classifyWith(test, c, subst);
    tests.push(testNode);

    if (is_pair(body) && isSym(body.car, "=>")) {
      // (test => proc): arm value is (proc test) — proc's operand cone unioned
      // with the test cone (the test value flows into the arm).
      const procRest = body.cdr;
      const procNode = is_pair(procRest) ? classifyWith(procRest.car, c, subst) : ({ kind: "literal" } as LineageNode);
      arms.push(combine("=>", [procNode, testNode]));
    } else if (is_pair(body)) {
      arms.push(classifyBegin(body, c, subst)); // normal clause body
    } else {
      arms.push(testNode); // `(test)` with no body returns the test value itself
    }
  }
  return { kind: "mux", op: "cond", selector: combine("cond", tests), arms };
}

/**
 * `(let ((x e)…) body…)` and friends — TRANSPARENT. Classify the body under a
 * substitution mapping each bound symbol to classify(its RHS); the result equals
 * the inlined form. `let*`/`letrec` (sequential=true) thread substitutions
 * left-to-right (later RHSs see earlier bindings). A *named* let is recursive —
 * not transparently inlineable — so it stays opaque over its RHSs + body.
 */
function classifyLet(rest: SchemeValue, c: Classifier, subst: Subst, sequential: boolean): LineageNode {
  if (!is_pair(rest)) return { kind: "literal" };

  // Named let: (let name (bindings) body…) — recursion ⇒ opaque (not inlineable).
  if (rest.car instanceof SchemeSymbol) {
    const afterName = rest.cdr;
    if (!is_pair(afterName)) return { kind: "literal" };
    const rhss = letBindingValues(afterName.car).map((v) => classifyWith(v, c, subst));
    const body = classifyBegin(afterName.cdr, c, subst);
    return { kind: "opaque", op: "named-let", children: [...rhss, body].filter(isProvBearing) };
  }

  const bindings = rest.car;
  const body = rest.cdr;

  // Build the substitution: leaf-slot ← classify(RHS). `let` classifies every
  // RHS in the OUTER subst (parallel); `let*`/`letrec` extend as they go.
  const extended = new Map(subst);
  let bindNode: SchemeValue = bindings;
  while (is_pair(bindNode)) {
    const binding = bindNode.car;
    bindNode = bindNode.cdr;
    if (!is_pair(binding) || !(binding.car instanceof SchemeSymbol)) continue;
    const name = opName(binding.car);
    const rhsExpr = is_pair(binding.cdr) ? binding.cdr.car : undefined;
    const rhsSubst = sequential ? extended : subst; // let* sees prior bindings; let does not
    const rhsNode = rhsExpr === undefined ? ({ kind: "literal" } as LineageNode) : classifyWith(rhsExpr, c, rhsSubst);
    extended.set(name, rhsNode);
  }

  return classifyBegin(body, c, extended);
}

/** Pull the RHS expressions out of a `let` binding list (named-let helper). */
function letBindingValues(bindings: SchemeValue): SchemeValue[] {
  const out: SchemeValue[] = [];
  let n: SchemeValue = bindings;
  while (is_pair(n)) {
    const b = n.car;
    if (is_pair(b) && is_pair(b.cdr)) out.push(b.cdr.car);
    n = n.cdr;
  }
  return out;
}

/** `(begin e…)` — pass-through of the LAST expression (earlier values dropped). */
function classifyBegin(body: SchemeValue, c: Classifier, subst: Subst): LineageNode {
  let last: SchemeValue | undefined;
  let n: SchemeValue = body;
  while (is_pair(n)) {
    last = n.car;
    n = n.cdr;
  }
  return last === undefined ? { kind: "literal" } : classifyWith(last, c, subst);
}

/** Runtime bindings: a slot/source name → the provenance ids it carries. */
export type Bindings = Record<string, readonly number[]>;

function walk(n: LineageNode, b: Bindings, out: Set<number>, countOnly: boolean): void {
  switch (n.kind) {
    case "literal":
      return;
    case "leaf":
      (b[n.slot] ?? []).forEach((x) => out.add(x));
      return;
    case "source":
      (b[n.op] ?? []).forEach((x) => out.add(x));
      return;
    case "pipe":
      walk(n.child, b, out, countOnly); // a pure pipe adds nothing of its own
      return;
    case "field":
      // Descend the FOCUSED child only — the siblings (the other fields of the
      // projected value) were pruned STRUCTURALLY at classify time (never built as
      // branches), so there is no ⊥ to propagate. This keeps fullCone NEUTRAL vs the
      // pre-v0.2 pipe classification of a member-read: a field over x still yields
      // x's cone (the teleological query is unchanged). The where-provenance KEY is
      // carried in the node for the consumer queries (basePoint / (basePoint,key)),
      // it does not change the set walk.
      walk(n.child, b, out, countOnly);
      return;
    case "merge":
    case "opaque":
      n.children.forEach((ch) => walk(ch, b, out, countOnly));
      return;
    case "mux":
      // Static over-approximation: the value is the selector-gated choice of one
      // arm, so the cone is selector ∪ every arm (the taken arm is a runtime
      // fact the static tree cannot know — DR3). Pruning is selector-agnostic:
      // a cardinality query still depends on whichever arm is chosen.
      walk(n.selector, b, out, countOnly);
      n.arms.forEach((arm) => walk(arm, b, out, countOnly));
      return;
    case "fan":
      // The value depends on the per-element transform; for a LENGTH-PRESERVING
      // fan (map) the COUNT does not, so a count-query prunes it — the same tree,
      // two answers. A FILTER is length-CHANGING: the count depends on the
      // predicate and the inspected elements, so it is NOT pruned (the §5
      // confluent-IR filter-fan admission — the prune is gated on `lengthPreserving`,
      // not on "is it a fan"; see the W1 filter-fan tests in lineage-spike.test.ts).
      walk(n.source, b, out, countOnly);
      if (countOnly && n.lengthPreserving) return; // map: prune the per-element transform
      if (n.introduces) (b[n.op] ?? []).forEach((x) => out.add(x));
      return;
  }
}

/** Teleological "provenance everything": every source the value derives from. */
export function fullCone(n: LineageNode, b: Bindings): number[] {
  const out = new Set<number>();
  walk(n, b, out, false);
  return [...out].sort((a, z) => a - z);
}

/** Minimal demand-cone for a cardinality observation (a count): prunes the
 *  length-preserving transforms a count cannot depend on. */
export function countCone(n: LineageNode, b: Bindings): number[] {
  const out = new Set<number>();
  walk(n, b, out, true);
  return [...out].sort((a, z) => a - z);
}

/** Two `PathStep`s address the same member. */
export function sameStep(a: PathStep, z: PathStep): boolean {
  if ("field" in a) return "field" in z && a.field === z.field;
  if ("car" in a) return "car" in z;
  return "index" in z && a.index === z.index;
}

/**
 * DEMAND-AS-PROJECTION (D-v02-2): the cone needed when only ONE field of the value
 * is demanded — the per-node hole-lattice element pushed backward. A field node is
 * followed IFF its step matches the demand; a NON-matching field node is a pruned
 * SIBLING (contributes nothing — the lens complement as set-difference). Every
 * other node propagates the same field demand to where the value is produced.
 *
 * This is the projection-parameterized `walk`: the explicit-optic machinery
 * (profunctor lenses / StyleLens) collapses to this single parameter because
 * arrival has ONE interpreter (`walk`) — the multi-interpreter uniformity a
 * profunctor buys is not needed (v0.2 §"Test demand-as-projection FIRST").
 */
export function fieldCone(n: LineageNode, b: Bindings, step: PathStep): number[] {
  const out = new Set<number>();
  walkField(n, b, step, out);
  return [...out].sort((a, z) => a - z);
}

/** The plucked key of a `PathStep` in the SAME shape the runtime field-point stores
 *  it (`FieldPointMeta.key`, trace.ts:57-60): a named member → its bare name string
 *  (`(:verdict x)` / `(@ x :verdict)` → `"verdict"`), a positional index → its number
 *  (`(vector-ref x 1)` → `1`), `car` → `null` (the head of a pair has no key — the
 *  runtime never mints a field-point for it, so there is no key to correspond to). */
export function stepKey(step: PathStep): string | number | null {
  if ("field" in step) return step.field;
  if ("index" in step) return step.index;
  return null; // car — no plucked key
}

/** What a field-projection chain bottoms out at, in the SHAPE the two JOIN consumers
 *  read today (v0.2 §"The consumer-equivalence contract"):
 *   - `base`  — the source-leaf ids the value derives from (the producer points). This
 *     is the carrier's static analogue of the sift seal's `resolveReadIds`
 *     (slice.ts:169-181): walk to the BASE producer, **key discarded**. Computed as the
 *     `fullCone` of the field node's focused CHILD (the source the projection reads).
 *   - `key`   — the INNERMOST projected step (D-v02-1 ABSORPTION), the dag's
 *     `resolvePoint` pin (statechart.ts:126-138) surfaced as `FlowGraphEdge.fields`.
 *     The field node's `step` is ALREADY the innermost: `classify` returns the inner
 *     field unchanged for a field-under-field (lineage.ts:347), exactly as the runtime
 *     `fieldPoint` absorbs `fieldPoint(fieldPoint(P,inner),outer) = {origin:P,key:inner}`
 *     (trace.ts:341-359). So the carrier and the trace pin the SAME key with no path.
 *
 *  For a NON-field node (a plain source / pipe / merge — the value was not produced by
 *  a member-read) there is no projected key: `key = null`, `base = fullCone(node)`. The
 *  runtime mints no field-point in that case either (the producer's own point flows
 *  unprojected), so the correspondence still holds — `base` = the producer set, no pin.
 *
 *  READ-ONLY (v02-G1): this is the static reproduction of the live field-point queries,
 *  proven by the tapped shadow before `computeProvenance`'s field-point minting is
 *  retired (a LATER phase). It does NOT mutate the tree or touch the runtime mint. */
export interface FieldResolution {
  readonly base: number[];
  readonly key: string | number | null;
}

export function fieldResolve(n: LineageNode, b: Bindings): FieldResolution {
  if (n.kind === "field") {
    // base = the source the projection reads (its focused child's full cone — the
    // siblings were pruned structurally at classify time, so this is the producer set);
    // key = this node's step, which absorption already collapsed to the innermost.
    return { base: fullCone(n.child, b), key: stepKey(n.step) };
  }
  // Not a member-read: the whole value's cone is the base, with no projected key.
  return { base: fullCone(n, b), key: null };
}

function walkField(n: LineageNode, b: Bindings, step: PathStep, out: Set<number>): void {
  switch (n.kind) {
    case "literal":
      return;
    case "leaf":
      (b[n.slot] ?? []).forEach((x) => out.add(x)); // the demanded field of an input leaf is the leaf's lineage
      return;
    case "source":
      (b[n.op] ?? []).forEach((x) => out.add(x)); // a source mint carries its whole lineage
      return;
    case "field":
      // The focused projection: follow it IFF it is the field we demand; otherwise
      // this node is a SIBLING of the focus and contributes nothing (the structural
      // complement). Once matched, the demand is SATISFIED — its child's FULL cone
      // is the projection's lineage.
      if (sameStep(n.step, step)) walk(n.child, b, out, false);
      return;
    case "pipe":
      walkField(n.child, b, step, out); // a pass-through preserves the demanded field
      return;
    case "merge":
    case "opaque":
      n.children.forEach((ch) => walkField(ch, b, step, out));
      return;
    case "mux":
      walkField(n.selector, b, step, out);
      n.arms.forEach((arm) => walkField(arm, b, step, out));
      return;
    case "fan":
      // A field demand on a fan result threads to the source (the z-axis is
      // preserved; the per-element field lives in the template, read by the viz).
      walkField(n.source, b, step, out);
      if (n.introduces) (b[n.op] ?? []).forEach((x) => out.add(x));
      return;
  }
}
