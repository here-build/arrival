/**
 * SPIKE proof for the static lineage classifier (design note §5, build-step 1).
 * Parses real source, classifies it STATICALLY (no eval), and shows:
 *  - pipe vs merge falls out of operand-arity, from the parsed AST;
 *  - provenance is born only at Rosetta crossings; pure control adds nothing;
 *  - ONE tree answers both the full-cone (teleological seal) and the count-cone
 *    (minimal demand) — the reconciliation the probe conflict demanded.
 */
import { describe, it, expect } from "vitest";
import { initBridge } from "../bridge";
import { parse } from "../eval/generator-exec";
import { sandboxedEnv } from "../sandbox-env";
import { classify, fullCone, countCone, type Classifier, type LineageNode } from "../values/lineage";

const C: Classifier = {
  isPure: (op) => ["+", "-", "*", "/", "<", ">", "=", "car", "cdr", "cons", "list"].includes(op),
  isRosettaIn: (op) => ["infer", "fetch", "db-read"].includes(op),
  isFan: (op) => ["map", "filter"].includes(op),
  isOpaque: (op) => ["ext-call"].includes(op),
};

async function skeleton(src: string): Promise<LineageNode> {
  await initBridge();
  const [ast] = await parse(src, sandboxedEnv);
  return classify(ast, C); // STATIC — no execution
}

describe("lineage spike — static skeleton + pipe/merge/fan from the parsed AST", () => {
  it("(* val1 (+ 1 val2)) → Merge(*) over Leaf(val1) and Pipe(+) → Leaf(val2)", async () => {
    const n = await skeleton(`(* val1 (+ 1 val2))`);
    expect(n.kind).toBe("merge"); // two provenance-bearing operands
    if (n.kind !== "merge") return;
    expect(n.op).toBe("*");
    expect(n.children[0]).toEqual({ kind: "leaf", slot: "val1" });
    // the literal 1 contributes nothing, so (+ 1 val2) is a PIPE, not a merge
    expect(n.children[1]).toEqual({ kind: "pipe", op: "+", child: { kind: "leaf", slot: "val2" } });
  });

  it("full-cone aggregates every leaf (teleological 'provenance everything')", async () => {
    const n = await skeleton(`(* val1 (+ 1 val2))`);
    expect(fullCone(n, { val1: [100], val2: [200] })).toEqual([100, 200]);
  });

  it("a pure predicate mints nothing: (if (< 0 (* x x)) x -1) — the comparison is not a source", async () => {
    // classify the predicate alone: (< 0 (* x x)) — 0 literal, (* x x) over one
    // variable → pipe; the whole thing carries only x's lineage, no new mint.
    const pred = await skeleton(`(< 0 (* x x))`);
    expect(pred.kind).toBe("pipe"); // one prov-bearing operand (the (* x x) subtree)
    expect(fullCone(pred, { x: [7] })).toEqual([7]); // just x; `<` and `*` added nothing
  });
});

describe("lineage spike — one tree, two cone queries (the reconciliation)", () => {
  it("(map infer xs): full-cone includes the fan's mint, count-cone prunes it", async () => {
    const n = await skeleton(`(map infer xs)`);
    expect(n.kind).toBe("fan");
    if (n.kind !== "fan") return;
    expect(n.introduces).toBe(true); // infer is Rosetta-in → the per-element transform mints
    // value depends on what each element BECAME (xs + the infer mint)…
    expect(fullCone(n, { xs: [10], infer: [20] })).toEqual([10, 20]);
    // …but the COUNT depends only on the source cardinality — the map is length-
    // preserving, so the infer mint is pruned. Same tree, different query.
    expect(countCone(n, { xs: [10], infer: [20] })).toEqual([10]);
  });
});

describe("lineage spike — Rosetta-in mints, opaque is holistic", () => {
  it("(infer p) is a source mint", async () => {
    const n = await skeleton(`(infer p)`);
    expect(n.kind).toBe("source");
    if (n.kind !== "source") return;
    expect(n.op).toBe("infer");
    expect(fullCone(n, { infer: [42] })).toEqual([42]);
  });

  it("(ext-call a b) is an opaque (black-box) holistic merge of its inputs", async () => {
    const n = await skeleton(`(ext-call a b)`);
    expect(n.kind).toBe("opaque");
    expect(fullCone(n, { a: [1], b: [2] })).toEqual([1, 2]);
  });
});
