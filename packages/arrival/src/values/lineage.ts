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

/** A node of the static lineage skeleton. `slot`/`op` names are filled with the
 *  actual provenance set at runtime (the leaf-stamping step). */
export type LineageNode =
  | { readonly kind: "literal" } // self-evaluating datum / lambda literal — never carries provenance
  | { readonly kind: "leaf"; readonly slot: string } // variable ref — runtime fills from its binding
  | { readonly kind: "source"; readonly op: string } // a Rosetta-in mint (infer/fetch/db-read/…)
  | { readonly kind: "pipe"; readonly op: string; readonly child: LineageNode } // ≤1 prov input → pass-through
  | { readonly kind: "merge"; readonly op: string; readonly children: readonly LineageNode[] } // ≥2 → fan-in
  // map/filter: a uniform per-element pipe template. `lengthPreserving` (map=true,
  // filter=false) gates the count-cone prune — see walk()/countCone.
  | {
      readonly kind: "fan";
      readonly op: string;
      readonly introduces: boolean;
      readonly lengthPreserving: boolean;
      readonly source: LineageNode;
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

  if (c.isRosettaIn(op)) return { kind: "source", op }; // provenance is BORN here

  if (c.isOpaque(op)) {
    const children = args.map((a) => classifyWith(a, c, subst)).filter(isProvBearing);
    return { kind: "opaque", op, children };
  }

  if (c.isFan(op)) {
    // (map f xs) / (filter p xs) — f introduces provenance iff it is itself a
    // Rosetta-in source. `lengthPreserving` distinguishes map (true) from filter
    // (false) for the count-cone prune in walk().
    const fanOp = opName(args[0]);
    const lengthPreserving = op === "map" || op === "vector-map";
    return {
      kind: "fan",
      op: fanOp,
      introduces: c.isRosettaIn(fanOp),
      lengthPreserving,
      source: classifyWith(args[1], c, subst),
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
      // predicate and the inspected elements, so it is NOT pruned (confluent-IR
      // §5; the lineage.ts:127-129 own admission this fixes).
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
