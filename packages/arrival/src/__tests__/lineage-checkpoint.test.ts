/**
 * CHECKPOINT for build-step 1 (design note §10) — the go/no-go for the IR.
 *
 * Two claims, measured against the REAL interpreter:
 *  1. Correctness — the static lineage skeleton + runtime leaf provenances
 *     derives the SAME cone the eager interpreter computes today (no loss).
 *  2. Memory — the lineage representation is O(program), not O(data): the static
 *     skeleton's node count is constant in the collection size, while the eager
 *     retained provenance scales O(N) (the pruneChildProvenance / 500k-cap pain).
 *
 * If (2) failed — if lineage didn't shrink the representation — the design says
 * STOP before building the IR. It doesn't fail.
 */
import { describe, it, expect } from "vitest";
import { initBridge } from "../bridge";
import { parse } from "../eval/generator-exec";
import { exec } from "../stdlib";
import { sandboxedEnv } from "../sandbox-env";
import { Pair } from "../values/Pair";
import { classify, fullCone, type Classifier, type LineageNode } from "../values/lineage";
import { provOf } from "../values/lineage-shadow";
import { sStr } from "./_lineage-test-helpers";

const C: Classifier = {
  isPure: (op) => ["+", "-", "*", "/", "<", ">", "=", "car", "cdr", "cons", "list", "length"].includes(op),
  isRosettaIn: (op) => ["infer", "fetch", "db-read"].includes(op),
  isFan: (op) => ["map", "filter"].includes(op),
  isOpaque: (op) => ["ext-call"].includes(op),
};

function countNodes(n: LineageNode): number {
  switch (n.kind) {
    case "literal":
    case "leaf":
    case "source":
      return 1;
    case "pipe":
      return 1 + countNodes(n.child);
    case "field":
      return 1 + countNodes(n.child);
    case "fan":
      return 1 + countNodes(n.source);
    case "mux":
      return 1 + countNodes(n.selector) + n.arms.reduce((a, arm) => a + countNodes(arm), 0);
    case "merge":
    case "opaque":
      return 1 + n.children.reduce((a, ch) => a + countNodes(ch), 0);
  }
}

describe("lineage checkpoint — runtime stamping derives the SAME cone (correctness)", () => {
  it("lineage full-cone == the eager interpreter's provenance, for (length (list a b c))", async () => {
    await initBridge();
    const env = sandboxedEnv.inherit("lin-correct");
    env.set("a", sStr("a", 100));
    env.set("b", sStr("b", 101));
    env.set("c", sStr("c", 102));

    const [r] = await exec(`(length (list a b c))`, { env });
    const eager = provOf(r);

    // Static skeleton (no eval) + leaf provenances read from the env = "runtime stamping".
    const [ast] = await parse(`(length (list a b c))`, env);
    const skel = classify(ast, C);
    const bindings = { a: provOf(env.get("a")), b: provOf(env.get("b")), c: provOf(env.get("c")) };

    expect(eager).toEqual([100, 101, 102]); // the eager baseline
    expect(fullCone(skel, bindings)).toEqual(eager); // lineage derives it structurally, no loss
  });
});

describe("lineage checkpoint — the static skeleton is constant in N (eager retained set is O(N))", () => {
  // HONEST SCOPE (audit C1): this proves the *skeleton* is O(program) and the
  // *eager retained* provenance is O(N) — suggestive, but NOT yet a like-for-like
  // total-memory proof: a fullCone over N elements still materializes O(N). The
  // real win — a minimal count-cone over a big fan staying O(1) — needs the
  // collection-grouping vs element provenance split, which is not modeled yet.
  async function eagerProvSize(n: number): Promise<number> {
    await initBridge();
    const env = sandboxedEnv.inherit(`lin-scale-${n}`);
    const xs = Pair.fromArray(
      Array.from({ length: n }, (_, i) => sStr(`e${i}`, 1000 + i)),
      false,
    );
    env.set("xs", xs);
    const [r] = await exec(`(length xs)`, { env });
    return provOf(r).length; // the count's retained provenance set size
  }

  it("eager retained provenance scales O(N) with collection size — the pain", async () => {
    expect(await eagerProvSize(3)).toBe(3);
    expect(await eagerProvSize(50)).toBe(50); // a count over N elements retains N provenance ids
  });

  it("the static lineage skeleton node-count is CONSTANT — independent of N", async () => {
    await initBridge();
    const [ast] = await parse(`(length (map f xs))`, sandboxedEnv);
    const nodes = countNodes(classify(ast, C)); // Pipe(length) -> Fan(f) -> Leaf(xs)
    expect(nodes).toBeLessThanOrEqual(4); // O(AST), constant in N (NOT a total-memory claim — see scope note)
  });

  // The like-for-like memory win this checkpoint does NOT yet prove (audit C1):
  it.todo(
    "like-for-like: a minimal count-cone over an N-element fan source stays O(1) — needs the collection-grouping vs element provenance split",
  );
});
