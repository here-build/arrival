/**
 * ASSUMPTIONS LEDGER for the dataflow-IR design (confluent-dataflow-graph-ir).
 * The test names ARE the assumptions; green = verified against the real
 * interpreter, `it.fails` = a documented gap/target, `it.todo` = a next-step
 * assumption whose check is designed but not yet buildable (waits on a slice).
 *
 * Measured first, then locked — snapshots record observed reality.
 */
import { describe, it, expect } from "vitest";
import { initBridge } from "../bridge";
import { exec } from "../stdlib";
import { sandboxedEnv } from "../sandbox-env";
import { SchemeString } from "../values/SchemeString";
import { Pair } from "../values/Pair";
import { AValue } from "../values/AValue";
import { LazySeq, is_lazy_seq } from "../values/LazySeq";

let seq = 0;
const provOf = (v: unknown): number[] => (v instanceof AValue ? [...v.provenance].sort((a, b) => a - b) : []);
const sStr = (s: string, p: number) => new SchemeString(s, new Set([p]));
const sNum = (n: number, p: number) => AValue.fromJs(n, new Set([p]));

async function run(src: string, binds: Record<string, AValue> = {}): Promise<number[]> {
  return provOf(await runRaw(src, binds));
}

async function runRaw(src: string, binds: Record<string, unknown> = {}): Promise<unknown> {
  await initBridge();
  const env = sandboxedEnv.inherit(`la-${seq++}`);
  for (const [k, v] of Object.entries(binds)) env.set(k, v as AValue);
  const [r] = await exec(src, { env });
  return r;
}

describe("ASSUMPTION — provenance is minted only at Rosetta crossings (§5)", () => {
  it("A11a: pure op over literals mints NOTHING — (+ 1 2) has empty provenance", async () => {
    expect(await run(`(+ 1 2)`)).toEqual([]);
  });

  it("A11b: pure op PROPAGATES, never mints — (* x x) over one source carries just it", async () => {
    expect(await run(`(* x x)`, { x: sNum(3, 200) })).toMatchInlineSnapshot(`
      [
        200,
      ]
    `);
  });

  it("A12: arithmetic merge propagates both sources — (* val1 (+ 1 val2))", async () => {
    expect(await run(`(* val1 (+ 1 val2))`, { val1: sNum(5, 100), val2: sNum(7, 200) })).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });
});

describe("ASSUMPTION — let is transparent (the graph is the object, not syntax) (§2)", () => {
  it("A4: (let ((foo (+ 1 val2))) (* val1 foo)) has the SAME provenance as the inlined form", async () => {
    const inlined = await run(`(* val1 (+ 1 val2))`, { val1: sNum(5, 100), val2: sNum(7, 200) });
    const letform = await run(`(let ((foo (+ 1 val2))) (* val1 foo))`, { val1: sNum(5, 100), val2: sNum(7, 200) });
    expect({ inlined, letform }).toMatchInlineSnapshot(`
      {
        "inlined": [
          100,
          200,
        ],
        "letform": [
          100,
          200,
        ],
      }
    `);
  });
});

describe("ASSUMPTION — a count is identity-entangled today (teleological); the tree must serve both queries (§5)", () => {
  it("A13: (length (map identity xs)) carries every element's provenance (over-attributes through map)", async () => {
    const xs = Pair.fromArray([sStr("a", 100), sStr("b", 101), sStr("c", 102)], false);
    expect(await run(`(length (map (lambda (e) e) xs))`, { xs: xs as unknown as AValue })).toMatchInlineSnapshot(`
      [
        100,
        101,
        102,
      ]
    `);
  });
});

// ── Step 2 — the Fantasy Land flip (LIVE: a LazySeq flows through the REAL builtins) ──
describe("ASSUMPTION — the demand cone is the provenance cone, through the live builtins (§5, Step 2)", () => {
  // A bare JS source value carries no provenance; the GROUPING fact (id 7) is the
  // collection-level provenance — the only thing a pure-map length should depend on.
  const lazy = (els: AValue[], groupId: number) => new LazySeq(els, [], new Set([groupId]));

  it("A18: (map f xs) over a LazySeq hits the fast-path — returns a LazySeq (extend), NOT an eager collect", async () => {
    const xs = lazy([sStr("a", 100), sStr("b", 101)], 7);
    const r = await runRaw(`(map (lambda (e) e) xs)`, { xs });
    expect(is_lazy_seq(r)).toBe(true); // the plan was extended; nothing ran
  });

  it("A8-live: (length (map f xs)) runs f ZERO times — `f` THROWS, yet length resolves to the source count", async () => {
    await initBridge();
    const env = sandboxedEnv.inherit(`la-${seq++}`);
    // If the map were eager, this fn runs and the whole exec rejects. It does not.
    env.defineRosetta("boom", { fn: () => { throw new Error("f ran — laziness broke"); } });
    env.set("xs", lazy([sStr("a", 100), sStr("b", 101), sStr("c", 102)], 7) as unknown as AValue);
    const [r] = await exec(`(length (map boom xs))`, { env });
    expect(r instanceof AValue ? r.toJs() : r).toBe(3); // f never touched → count is the source length
    // The cone is the GROUPING fact alone (id 7) — NOT the elements (100,101,102),
    // NOT boom's op. A pure-map length depends on none of them. (Contrast A13's
    // eager over-attribution: every element id leaks into the count.)
    expect(provOf(r)).toEqual([7]);
  });

  it("A18b: with NO LazySeq, the eager path is byte-identical — (length (map id ys)) over a Pair still over-attributes", async () => {
    // The fast-paths are guarded on `is_lazy_seq`; a plain Pair is untouched, so
    // the pre-flip behavior (A13) is preserved exactly. This is the speculate
    // discipline: laziness changes nothing it doesn't explicitly touch.
    const ys = Pair.fromArray([sStr("a", 100), sStr("b", 101), sStr("c", 102)], false);
    expect(await run(`(length (map (lambda (e) e) ys))`, { ys: ys as unknown as AValue })).toEqual([100, 101, 102]);
  });

  it("A18c: `(lazy-seq ys)` introduces laziness from PURE scheme — (length (map boom (lazy-seq ys))) runs boom ZERO times", async () => {
    await initBridge();
    const env = sandboxedEnv.inherit(`la-${seq++}`);
    env.defineRosetta("boom", { fn: () => { throw new Error("f ran — laziness broke"); } });
    // The Pair's OWN provenance (id 7) is the grouping fact lazy-seq lifts to the
    // collection level; the elements carry their own per-element provenance.
    const ys = (Pair.fromArray([sStr("a", 100), sStr("b", 101), sStr("c", 102)], false) as unknown as AValue).withProvenance(new Set([7]));
    env.set("ys", ys);

    // (map boom (lazy-seq ys)) over a plain Pair, lifted lazy from user code, EXTENDS
    // a plan — boom is stored, not run; the result is a LazySeq.
    const [lazyResult] = await exec(`(map boom (lazy-seq ys))`, { env });
    expect(is_lazy_seq(lazyResult)).toBe(true);

    // length forces it — and boom STILL never runs (pure-map length cone excludes f).
    const [len] = await exec(`(length (map boom (lazy-seq ys)))`, { env });
    expect(len instanceof AValue ? len.toJs() : len).toBe(3);
    expect(provOf(len)).toEqual([7]); // grouping fact only — boom & elements outside the cone
  });

  it("A18d: an un-forced lazy-seq at a non-recognizing egress FAILS LOUD — never a silent nil/empty", async () => {
    await initBridge();
    const env = sandboxedEnv.inherit(`la-${seq++}`);
    const ys = Pair.fromArray([sStr("a", 100), sStr("b", 101)], false);
    env.set("ys", ys as unknown as AValue);
    // Without the guard, `first` returns nil and `sort` returns '() — both silent
    // wrong answers. The first cut hasn't taught these to force, so they throw.
    await expect(exec(`(first (lazy-seq ys))`, { env })).rejects.toThrow(/lazy-seq/);
    await expect(exec(`(sort (lazy-seq ys))`, { env })).rejects.toThrow(/lazy-seq/);
  });
});

// ── NEXT-STEP assumptions — checks designed, not yet buildable (wait on a slice) ──
describe("NEXT-STEP assumptions (designed; unblock as the slices land)", () => {
  // Step 3 — auto-abort:
  it.todo("A10: a lost race over a PURE fan is cancelled with no observable effect");
  it.todo("A10-hazard: a loser that already crossed the membrane (fired an effect) is NOT silently un-fired");
  // Step 4/5 — graph + ligatures:
  it.todo("A3: a fold carries an acc back-edge (sequential); a fan does not (parallel) — read off the graph");
  it.todo("A9: a reduce parallelizes (tree-reduce) iff its reducer has a Fantasy Land Monoid (associativity)");
  it.todo("A19: each ligature fusion preserves BOTH result and lineage cone — cone(fuse) == cone(stack)");
  // Step 6 — self-explaining values:
  it.todo("A-uneval: eval(uneval(chunk)) === chunk — a lineage chunk round-trips to readable source");
  // Step 7 — effects:
  it.todo("A16: write-set ∩ later read-set != ∅ is a detectable back-edge through the membrane (reject/warn)");
  // Classifier gaps surfaced this session:
  it.todo("A4-classifier: classify() handles `let`/`if` (special forms), not just applications — currently only apps");
  it.todo("A21: classify() runs on the MACRO-EXPANDED ast, not the raw reader output");
});
