/**
 * COPY-AS-CHUNK (constitution §4.5 — greenfield package, never shared imports).
 * Source: inhuman/public-packages/mercury/src/desugar.ts.
 *
 * Macro-expansion pre-pass: rewrite the authoring-surface forms that are really sugar for
 * core forms (`lambda`, `let`, `if`, calls) BEFORE classification runs — so classify()
 * sees only the core language and handles these forms for free (coreform-ir.md §4.1:
 * "desugar ends, classification begins").
 *
 * Currently expands: SRFI-26 `cut`; the threading family `->`/`~>` (thread-first),
 * `->>`/`~>>` (thread-last); `compose`/`comp` (right-to-left) + `pipe`/`flow`
 * (left-to-right); and `when`/`unless`/`cond` → `if`. Semantics match the
 * arrival-scheme bootstrap macros EXACTLY — the view must agree with execution.
 * `and`/`or` deliberately do NOT desugar (constitution §3.2): they become dedicated
 * CoreForm nodes so Law T's narrowing-form grammar sees them intact.
 *
 * Adaptations from the source chunk (coreform-ir.md §9 item 3's sentinel proposal,
 * resolved in-package — desugar() is now TOTAL, classify() doors what it leaves):
 *   - `case` no longer throws: the form is left unexpanded (children still expand)
 *     and classify() doors it as `unsupported-form/case`.
 *   - a `cond` containing a `=>` / bare-`(test)` clause no longer throws: the whole
 *     `cond` is left unexpanded and classify() doors it as `unsupported-form/cond-clause`.
 */
import { type Atom, isAtom, isList, type ListNode, type Node } from "./nodes.js";

/** Expand every sugar form in a parse forest. Pure: returns a new forest, leaves input alone. */
export function desugar(forest: Node[]): Node[] {
  return forest.map(expand);
}

/** Bottom-up: expand children first (so a nested sugar form's own slots/threads are consumed
 *  by ITS expansion), then expand this node if it is itself a sugar form. `{ ...n, list }`
 *  PRESERVES every other property the parser attached (notably `span`, which the classifier
 *  carries onto CoreForm nodes) — rebuilding as a bare `{ list }` would strip comments and
 *  positions. */
function expand(n: Node): Node {
  if (!isList(n)) return n;
  const list = n.list.map(expand);
  const h = isAtom(n.list[0]) && !n.list[0].str ? n.list[0].atom : undefined;
  switch (h) {
    case "cut":
      return { ...n, list: cutLambda(list) }; // keep the form's span on the synthetic node
    case "->":
    case "~>":
      return withSpan(n, thread(list[1], list.slice(2), "first"));
    case "->>":
    case "~>>":
      return withSpan(n, thread(list[1], list.slice(2), "last"));
    case "compose":
    case "comp":
      return { ...n, list: composeLambda(list.slice(1), "right-to-left") };
    case "pipe":
    case "flow":
      return { ...n, list: composeLambda(list.slice(1), "left-to-right") };
    case "when":
      return withSpan(n, { list: [SYM.if, list[1]!, body(list.slice(2))] });
    case "unless":
      return withSpan(n, { list: [SYM.if, { list: [SYM.not, list[1]!] }, body(list.slice(2))] });
    case "cond": {
      // Unexpandable clause shapes (`=>` receivers, bare `(test)`) leave the whole form
      // for classify() to door — a loud door beats a possibly-divergent expansion.
      const expanded = expandCond(list.slice(1));
      return expanded === undefined ? { ...n, list } : withSpan(n, expanded);
    }
    case "case":
      // Unused by any example; its datum eqv/quoting semantics are subtle enough that a
      // clean door beats a possibly-divergent expansion. Left unexpanded for classify()
      // to door (`unsupported-form/case`). Desugar to `cond` (or-of-`equal?`) if needed.
      return { ...n, list };
  }
  return { ...n, list };
}

/** Reused atom heads for synthesized forms. */
const SYM = { if: { atom: "if" } as Atom, not: { atom: "not" } as Atom, begin: { atom: "begin" } as Atom };

/** A clause/`when` body: one expr stays bare; many wrap in `begin` (an IIFE/block downstream). */
function body(forms: Node[]): Node {
  return forms.length === 1 ? forms[0]! : { list: [SYM.begin, ...forms] };
}

const isElse = (n: Node): boolean => isAtom(n) && !n.str && n.atom === "else";

/**
 * `(cond (t1 e1…) (t2 e2…) (else e…))` → nested `(if t1 e1 (if t2 e2 e))`, built right-to-left.
 * Nested `if` lowers to a chained ternary downstream, so a `cond` is an expression — no
 * statement-position needed. Matches the bootstrap `cond` macro for the `(test body…)` +
 * `else` clause forms; the rarer `=>` / bare-`(test)` clauses (used by no example) return
 * `undefined` so the caller leaves the form intact for classify() to door — never a silent
 * mis-expansion (adaptation; the source chunk threw here).
 */
function expandCond(clauses: Node[]): Node | undefined {
  let acc: Node | undefined;
  for (let i = clauses.length - 1; i >= 0; i--) {
    const c = clauses[i];
    if (!isList(c) || c.list.length === 0) continue;
    const test = c.list[0]!;
    if (isElse(test)) {
      acc = body(c.list.slice(1));
      continue;
    }
    if (c.list.length === 1 || (isAtom(c.list[1]) && !(c.list[1] as Atom).str && (c.list[1] as Atom).atom === "=>")) {
      return undefined; // `=>` / bare-test clause — unexpandable, classify() doors the form
    }
    const e = body(c.list.slice(1));
    acc = acc === undefined ? { list: [SYM.if, test, e] } : { list: [SYM.if, test, e, acc] };
  }
  return acc ?? { atom: "undefined" };
}

/** Keep `n`'s span on a replacement node when the replacement is a list; pass atoms through. */
function withSpan(n: ListNode, replacement: Node): Node {
  return isList(replacement) ? { ...n, list: replacement.list } : replacement;
}

/**
 * Threading macros (Clojure/Racket positional — NOT a `_` placeholder). Thread `x` through
 * each step, inserting it as the FIRST arg (`->`/`~>`) or LAST arg (`->>`/`~>>`). A bare
 * symbol step `f` becomes `(f x)`; a call step `(f a b)` becomes `(f x a b)` / `(f a b x)`.
 * The result is an inline nested call — exactly what the bootstrap macro produces, so the
 * view matches execution.
 */
function thread(x: Node | undefined, forms: Node[], where: "first" | "last"): Node {
  if (x === undefined) return { list: [] };
  return forms.reduce<Node>((acc, form) => {
    if (!isList(form)) return { list: [form, acc] }; // bare `f` / `:kw` → (f acc)
    return where === "first"
      ? { list: [form.list[0]!, acc, ...form.list.slice(1)] } // (f a b) → (f acc a b)
      : { list: [...form.list, acc] }; // (f a b) → (f a b acc)
  }, x);
}

/**
 * `(compose f g h)` / `(pipe f g h)` → `(lambda (it) (f (g (h it))))` (compose, right-to-left)
 * or `(lambda (it) (h (g (f it))))` (pipe, left-to-right). Returns the lambda node's `.list`.
 * NESTING (rather than calling a runtime `compose`) keeps every function — including keyword
 * accessors — in head position, so `(compose :state last :versions)` lowers cleanly to
 * `(it) => last(it.versions).state` instead of erroring on a bare `:versions`. Faithful for
 * the unary pipelines `compose` is always used for here.
 */
function composeLambda(fns: Node[], dir: "right-to-left" | "left-to-right"): Node[] {
  const param: Atom = { atom: "it" };
  const ref: Atom = { atom: "it" };
  const wrap = (acc: Node, fn: Node): Node => ({ list: [fn, acc] });
  const body = dir === "left-to-right" ? fns.reduce(wrap, ref as Node) : fns.reduceRight(wrap, ref as Node);
  return [{ atom: "lambda" }, { list: [param] }, body];
}

/**
 * `(cut proc a <> b <>)` → `(lambda (a-slot b-slot) (proc a a-slot b b-slot))` — the `.list`
 * of a lambda node. One param per `<>` hole, filled left-to-right; non-slot items (already
 * expanded) pass through untouched. Slot naming matches the former emit-time lowerers exactly
 * (`it` for a single hole, then `a b c d e f`), so the projected output is byte-identical —
 * `cut` is just visible to the earlier passes now.
 */
function cutLambda(expandedCutList: Node[]): Node[] {
  const items = expandedCutList.slice(1);
  const isSlot = (x: Node): boolean => isAtom(x) && !x.str && x.atom === "<>";
  const names = items.filter(isSlot).length === 1 ? ["it"] : ["a", "b", "c", "d", "e", "f"];
  const slots: Atom[] = [];
  const fill = (x: Node): Node => {
    if (!isSlot(x)) return x;
    const g: Atom = { atom: names[slots.length] ?? `arg${slots.length + 1}` };
    slots.push(g);
    return g;
  };
  const call: ListNode = { list: items.map(fill) };
  return [{ atom: "lambda" }, { list: slots }, call];
}
