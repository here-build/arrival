import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
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
import { initBridge } from "../index.js";
import { parse } from "../eval/generator-exec.js";
import { execState } from "../eval/generator-exec.js";
import { inferenceEnv } from "../inference-env.js";
import { APair } from "../values/primitives/APair.js";
import { classify, fullCone, type Classifier, type LineageNode } from "../values/lineage.js";
import { provOf } from "../values/lineage-shadow.js";
import { sStr } from "./_lineage-test-helpers.js";
import { requireEagerOracle } from "./_require-eager-oracle.js";
// In-package test: the module-internal storage write (hermetic-Environment ruling — no public set).
import { bindValue } from "../Environment.js";

// Q20b: this file's local helpers (`eagerProvSize` et al.) call execState
// directly — force the oracle ON for the file's lifetime.
requireEagerOracle();

const C: Classifier = {
  roleOf: (op) =>
    ["infer", "fetch", "db-read"].includes(op)
      ? "source"
      : ["map", "filter"].includes(op)
        ? "fan"
        : ["ext-call"].includes(op)
          ? "opaque"
          : undefined,
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
    case "transparent":
      return 1 + countNodes(n.child);
    case "merge":
    case "opaque":
    case "sink":
    case "binder":
      return 1 + n.children.reduce((a, ch) => a + countNodes(ch), 0);
  }
}

describe("lineage checkpoint — runtime stamping derives the SAME cone (correctness)", () => {
  it("lineage full-cone == the eager interpreter's provenance, for (length (list a b c))", async () => {
    await initBridge();
    const env = inferenceEnv.inherit("lin-correct");
    bindValue(env, "a", sStr("a", 100));
    bindValue(env, "b", sStr("b", 101));
    bindValue(env, "c", sStr("c", 102));

    // execState (COMPLEX tier): `provOf` reads BOXED provenance (RULINGS.md R1).
    const [r] = (await execState(`(length (list a b c))`, { env })).values;
    const eager = provOf(r);

    // Static skeleton (no eval) + leaf provenances read from the env = "runtime stamping".
    const [ast] = await parse(`(length (list a b c))`);
    const skel = classify(ast, C);
    const bindings = { a: provOf(env.get("a")), b: provOf(env.get("b")), c: provOf(env.get("c")) };

    expect(eager).toEqual([100, 101, 102]); // the eager baseline
    expect(fullCone(skel, bindings)).toEqual(eager); // lineage derives it structurally, no loss
  });
});

describe("lineage checkpoint — the static skeleton is constant in N (eager retained set is O(N) for a MINTED container)", () => {
  // HONEST SCOPE (audit C1), UPDATED post-C4 (docs/test-suite-v2/RULINGS.md R2,
  // docs/REWORK-DAG.md C1/C2/C4): `length` no longer deep-unions every element it
  // touched — it reads the CONTAINER's own flat grouping-fact stamp. For a MINTED
  // container (built via the real `list` verb, env/r7rs/lists.ts), that stamp is
  // STILL the union of all N args' own provenance (the naive R2 strategy: named
  // fields, not a symbolic fact-wire yet) — so the eager retained set is still
  // genuinely O(N) here, same shape as before, just for a different mechanistic
  // reason (the container's own stamp, not a deep element walk). This remains the
  // real "pain" motivating the wireframe (Track C3): the naive MINTED stamp still
  // materializes O(N) ids; only the wireframe's symbolic fact-wire makes it O(1)
  // for the general case. The UNMINTED case (a bare fan over a plain
  // `APair.fromArray` source, no Rosetta-IN crossing) is the one C4 already makes
  // O(1) today — that's the next describe block below, the it.todo this checkpoint
  // used to leave open.
  async function eagerProvSize(n: number): Promise<number> {
    await initBridge();
    const env = inferenceEnv.inherit(`lin-scale-${n}`);
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
      const name = `e${i}`;
      bindValue(env, name, sStr(name, 1000 + i));
      names.push(name);
    }
    // MINTED (R2's constructor verb): `list` unions all N args' own provenance onto the
    // produced head (env/r7rs/lists.ts) — genuinely O(N) container-level provenance.
    const [r] = (await execState(`(length (list ${names.join(" ")}))`, { env })).values;
    return provOf(r).length; // the count's retained provenance set size
  }

  it("eager retained provenance scales O(N) with a MINTED collection's size — the remaining pain", async () => {
    expect(await eagerProvSize(3)).toBe(3);
    expect(await eagerProvSize(50)).toBe(50); // a count over a MINTED N-element list retains N ids
  });

  it("the static lineage skeleton node-count is CONSTANT — independent of N", async () => {
    await initBridge();
    const [ast] = await parse(`(length (map f xs))`);
    const nodes = countNodes(classify(ast, C)); // Pipe(length) -> Fan(f) -> Leaf(xs)
    expect(nodes).toBeLessThanOrEqual(4); // O(AST), constant in N (NOT a total-memory claim — see scope note)
  });
});

describe("lineage checkpoint — C4 ALREADY achieves O(1) for the UNMINTED fan-over-source case", () => {
  // FLIPPED from `it.todo` (was: "like-for-like: a minimal count-cone over an N-element fan
  // source stays O(1) — needs the collection-grouping vs element provenance split"). C4's
  // interim fix (RULINGS.md R2) delivers exactly this split for the case that matters most
  // cheaply: a bare source with NO container-level grouping fact minted (no Rosetta-IN
  // crossing for the LIST ITSELF — only its elements are individually stamped). `length`
  // over a length-preserving `map` fan now reads the container's own (empty) stamp — O(1),
  // independent of N — instead of deep-unioning N element ids. The MINTED case above still
  // needs the wireframe's symbolic fact-wire for the like-for-like win; this is the naive
  // strategy's own free win.
  async function unmintedFanProvSize(n: number): Promise<number> {
    await initBridge();
    const env = inferenceEnv.inherit(`lin-scale-unminted-${n}`);
    const xs = APair.fromArray(
      CONSTANT_CTX,
      Array.from({ length: n }, (_, i) => sStr(`e${i}`, 1000 + i)),
      false,
    );
    bindValue(env, "xs", xs);
    const [r] = (await execState(`(length (map (lambda (e) e) xs))`, { env })).values;
    return provOf(r).length;
  }

  it("eager retained provenance stays O(1) — ZERO — over an unminted fan source, independent of N", async () => {
    expect(await unmintedFanProvSize(3)).toBe(0);
    expect(await unmintedFanProvSize(50)).toBe(0); // still 0 at N=50 — no growth with size
  });
});
