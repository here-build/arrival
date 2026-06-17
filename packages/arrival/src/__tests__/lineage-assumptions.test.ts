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

let seq = 0;
const provOf = (v: unknown): number[] => (v instanceof AValue ? [...v.provenance].sort((a, b) => a - b) : []);
const sStr = (s: string, p: number) => new SchemeString(s, new Set([p]));
const sNum = (n: number, p: number) => AValue.fromJs(n, new Set([p]));

async function run(src: string, binds: Record<string, AValue> = {}): Promise<number[]> {
  await initBridge();
  const env = sandboxedEnv.inherit(`la-${seq++}`);
  for (const [k, v] of Object.entries(binds)) env.set(k, v);
  const [r] = await exec(src, { env });
  return provOf(r);
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

// ── NEXT-STEP assumptions — checks designed, not yet buildable (wait on a slice) ──
describe("NEXT-STEP assumptions (designed; unblock as the slices land)", () => {
  // Step 2 — the Fantasy Land flip:
  it.todo("A18: a lazy node hits the is_lazy_seq fast-path BEFORE fl-interop's eager asyncFL collect");
  it.todo("A18b: with the lazy flag OFF, results+provenance are byte-identical to eager (speculate discipline)");
  it.todo("A8-live: (length (map f xs)) through the REAL builtins runs f ZERO times");
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
