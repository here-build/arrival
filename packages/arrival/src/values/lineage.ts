/**
 * SPIKE — the lineage data model + STATIC chunk classifier.
 * Build-step 1 of docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md §5.
 *
 * Proves the centerpiece: provenance is a static lineage TREE — pipe / merge /
 * fan nodes — *minted only at Rosetta crossings*, with the SHAPE derivable from
 * the parsed AST BEFORE execution (operand-arity over non-literal operands).
 * Runtime only stamps Rosetta leaf-ids into the skeleton's slots. One tree then
 * answers BOTH the teleological full-cone (seal: walk to every leaf) and the
 * minimal demand-cone (e.g. a count, which prunes a length-preserving fan).
 *
 * Standalone + throwaway, like LazySeq.ts — NOT wired into the interpreter. It
 * operates on real AST nodes (Pair / SchemeSymbol from the reader); classify()
 * runs no evaluation. We claim none of the lineage; see the design note §11/§12
 * (how-provenance, Galois slicing, SSA def-use, why/how/where).
 */
import { is_pair, is_nil } from "./value-guards.js";
import { SchemeSymbol } from "./SchemeSymbol.js";
import type { Pair } from "./Pair.js";
import type { SchemeValue } from "./types.js";

/** A node of the static lineage skeleton. `slot`/`op` names are filled with the
 *  actual provenance set at runtime (the leaf-stamping step). */
export type LineageNode =
  | { readonly kind: "literal" } // self-evaluating datum — never carries provenance
  | { readonly kind: "leaf"; readonly slot: string } // variable ref — runtime fills from its binding
  | { readonly kind: "source"; readonly op: string } // a Rosetta-in mint (infer/fetch/db-read/…)
  | { readonly kind: "pipe"; readonly op: string; readonly child: LineageNode } // ≤1 prov input → pass-through
  | { readonly kind: "merge"; readonly op: string; readonly children: readonly LineageNode[] } // ≥2 → fan-in
  | { readonly kind: "fan"; readonly op: string; readonly introduces: boolean; readonly source: LineageNode } // map/filter
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

/**
 * Build the lineage skeleton from a parsed AST — STATIC, no evaluation. The
 * pipe-vs-merge cut is just the count of provenance-bearing (non-literal)
 * operands: ≤1 → pipe (pass-through), ≥2 → merge (the tree branches).
 *
 * SCOPE (spike) — handles APPLICATIONS only. Special forms (`if`/`let`/`lambda`/
 * `quote`/`cond`) are Pairs too and are WRONGLY treated as applications here: the
 * design's own `(if (< 0 (* x x)) x -1)` example needs a `mux` node this union
 * lacks (so it is proven only on the hand-sliced predicate, not end-to-end); a
 * computed operator `((f a) b)` stringifies via `opName`; an n-ary `(map f xs ys)`
 * keeps only `xs`; a lambda/computed fan-fn mis-reads `introduces` (the HOF hole).
 * All are step-2+ work, tracked as `it.todo`s in lineage-assumptions.test.ts
 * (A4-classifier, A21, HOF). Until then: pass macro-expanded, application-shaped ASTs.
 */
export function classify(ast: SchemeValue, c: Classifier): LineageNode {
  if (isLiteral(ast)) return { kind: "literal" };
  if (ast instanceof SchemeSymbol) return { kind: "leaf", slot: opName(ast) };
  // application: (op . args)
  const op = opName((ast as Pair).car);
  const args = operands(ast as Pair);

  if (c.isRosettaIn(op)) return { kind: "source", op }; // provenance is BORN here

  if (c.isOpaque(op)) {
    const children = args.map((a) => classify(a, c)).filter(isProvBearing);
    return { kind: "opaque", op, children };
  }

  if (c.isFan(op)) {
    // (map f xs) — f introduces provenance iff it is itself a Rosetta-in source.
    const fanOp = opName(args[0]);
    return { kind: "fan", op: fanOp, introduces: c.isRosettaIn(fanOp), source: classify(args[1], c) };
  }

  // pure op: classify operands, keep the provenance-bearing ones, cut by arity.
  const children = args.map((a) => classify(a, c)).filter(isProvBearing);
  if (children.length === 0) return { kind: "literal" };
  if (children.length === 1) return { kind: "pipe", op, child: children[0] };
  return { kind: "merge", op, children };
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
    case "fan":
      // The value depends on the per-element transform; the COUNT does not (map
      // preserves length), so a count-query prunes the fan op — the same tree,
      // two answers. (filter is length-changing and would NOT prune; the spike
      // models the length-preserving map fan.)
      walk(n.source, b, out, countOnly);
      if (!countOnly && n.introduces) (b[n.op] ?? []).forEach((x) => out.add(x));
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
