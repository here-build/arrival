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
import { parse } from "../eval/generator-exec";
import { sandboxedEnv } from "../sandbox-env";
import { SchemeVector } from "../values/SchemeVector";
import { Pair } from "../values/Pair";
import { AValue } from "../values/AValue";
import { LazySeq, is_lazy_seq } from "../values/LazySeq";
import { classify, fullCone, type Classifier } from "../values/lineage";
import { provOf } from "../values/lineage-shadow";
import { sStr, sNum, run, runRaw } from "./_lineage-test-helpers";

// `seq` numbers the BESPOKE per-`it` envs below (each builds its own env to install
// a `defineRosetta`/LazySeq fixture); the shared run/runRaw own a separate counter.
let seq = 0;

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

// ── CONFLUENCE — lazy must produce the SAME value as eager (no capability lost) ──
// The flip is only sound if `(op … (lazy-seq xs))` ≡ `(op … xs)` for every forcing
// op. These run each chain BOTH ways over the same source and assert equality —
// the real regression guard. The eager arm doubles as a baseline: if a chain ever
// breaks (e.g. reduce semantics), both arms move together and the eager value is
// pinned too. Numbers are provenance-stamped (id 0) so the lazy path exercises the
// real AValue arithmetic, not a bare-JS shortcut.
describe("CAPABILITY — lazy ≡ eager confluence (forcing yields identical results)", () => {
  const nums = () => Pair.fromArray([1, 2, 3, 4, 5].map((x) => sNum(x, 0)), false) as unknown as AValue;
  const jsVal = (r: unknown): unknown => (r instanceof AValue ? r.toJs() : r);

  // Run `chain` with the collection slot filled eager (xs) and lazy (lazy-seq xs).
  async function bothWays(chain: (coll: string) => string): Promise<{ eager: unknown; lazy: unknown }> {
    return { eager: jsVal(await runRaw(chain("xs"), { xs: nums() })), lazy: jsVal(await runRaw(chain("(lazy-seq xs)"), { xs: nums() })) };
  }

  it("map → reduce: (reduce + 0 (map (* x 2) …)) is identical eager and lazy", async () => {
    const { eager, lazy } = await bothWays((c) => `(reduce + 0 (map (lambda (x) (* x 2)) ${c}))`);
    expect({ eager, lazy }).toEqual({ eager: 30, lazy: 30 }); // 2+4+6+8+10
  });

  it("filter → length: the ASYNC pred path counts identically (the soundness risk I flagged)", async () => {
    const { eager, lazy } = await bothWays((c) => `(length (filter (lambda (x) (> x 2)) ${c}))`);
    expect({ eager, lazy }).toEqual({ eager: 3, lazy: 3 }); // {3,4,5}
  });

  it("map → filter → reduce: a full pipeline forces through iterate identically", async () => {
    // 1..5 → +1 → 2..6 → keep >2 → {3,4,5,6} → sum 18
    const { eager, lazy } = await bothWays((c) => `(reduce + 0 (filter (lambda (x) (> x 2)) (map (lambda (x) (+ x 1)) ${c})))`);
    expect({ eager, lazy }).toEqual({ eager: 18, lazy: 18 });
  });

  it("reduce matches eager fold DIRECTION under forcing — a non-commutative reducer agrees", async () => {
    // The base `reduce` is a RIGHT fold: (reduce - 100 '(1 2 3 4 5)) =
    // 1-(2-(3-(4-(5-100)))) = -97. Subtraction makes direction observable. This is
    // the probe that caught the original bug — a hand-rolled left-fold in
    // reduceLazySeq gave 85. The fix delegates to builtinReduce, so lazy now agrees.
    const { eager, lazy } = await bothWays((c) => `(reduce - 100 (map (lambda (x) x) ${c}))`);
    expect(lazy).toBe(eager);
    expect(eager).toBe(-97);
  });

  it("length over a pure-map chain matches eager COUNT (cone differs, value must not)", async () => {
    // A8-live proved f runs zero times + a minimal cone; here the COUNT itself must
    // still equal eager — laziness changes the provenance, never the answer.
    const { eager, lazy } = await bothWays((c) => `(length (map (lambda (x) (* x x)) ${c}))`);
    expect({ eager, lazy }).toEqual({ eager: 5, lazy: 5 });
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
  // Classifier gaps surfaced this session — now CLOSED by W1 (classify() handles
  // surface special forms by shape; lineage-spike + golden-prov-special-forms
  // carry the full proof). These pin the headline closure here in the ledger.
  it("A4-classifier: classify() handles `let`/`if` (special forms), not just applications", async () => {
    await initBridge();
    const C: Classifier = {
      isPure: (op) => ["+", "-", "*", "/", "<", ">", "=", "length"].includes(op),
      isRosettaIn: () => false,
      isFan: (op) => ["map", "filter"].includes(op),
      isOpaque: () => false,
    };
    const cone = async (src: string, b: Record<string, readonly number[]>): Promise<number[]> => {
      const [ast] = await parse(src, sandboxedEnv);
      return fullCone(classify(ast, C), b);
    };
    // `if` → a `mux` (not a mis-read application); predicate ∪ taken arm.
    const [ifAst] = await parse(`(if (< 0 x) v -1)`, sandboxedEnv);
    expect(classify(ifAst, C).kind).toBe("mux");
    expect(await cone(`(if (< 0 x) v -1)`, { x: [7], v: [5] })).toEqual([5, 7]);
    // `let` → transparent: same cone as the inlined form.
    expect(await cone(`(let ((foo (+ 1 v2))) (* v1 foo))`, { v1: [100], v2: [200] })).toEqual([100, 200]);
  });

  it("A21: classify() runs on the SURFACE ast — this engine dispatches special forms directly (no macro-expansion)", async () => {
    await initBridge();
    const C: Classifier = { isPure: (op) => ["*", "+"].includes(op), isRosettaIn: () => false, isFan: () => false, isOpaque: () => false };
    // The evaluator's SPECIAL_FORMS dispatches `let` directly, so the parsed AST
    // head is still the literal `let` symbol (NOT desugared to a lambda
    // application). classify() handles that surface shape rather than requiring a
    // macro-expanded input — so the original "must run on macro-expanded ast"
    // assumption is resolved by surface handling, not by adding an expander.
    const [ast] = await parse(`(let ((foo v1)) (* v1 foo))`, sandboxedEnv);
    expect((ast as { car?: { valueOf?: () => unknown } })?.car?.valueOf?.()).toBe("let"); // surface form, unexpanded
    expect(fullCone(classify(ast, C), { v1: [100] })).toEqual([100]); // transparent on the surface form
  });
});

// ── v0.1 FINALIZATION GATES (G1–G7) ──
// The acceptance ledger for retiring eager per-op provenance in favor of the
// static lineage TREE (lineage.ts: classify → leaf/source/pipe/merge/fan/opaque),
// behind a `--ir-lineage` flag with eager fallback. Design:
// docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md.
//
// The flag DOES NOT EXIST YET, so today's eager behavior IS the golden oracle:
// every gate's static-path assertion is "flag-on == eager golden". These are
// `it.todo` (intent pinned, path unbuilt). Where a gate is partially checkable
// under the eager engine TODAY, a runnable golden is captured alongside — it is
// the eager left-hand side the static path must reproduce byte-for-byte (G2).
// The test NAME states the acceptance condition (the repo law: name IS the gate).
describe("v0.1 FINALIZATION GATES (G1–G7)", () => {
  // G1 — provenance memory is O(program-structure), not O(execution-history).
  it.todo(
    "G1: a program that previously approached DEFAULT_TRACE_CAP (500k) runs with BOUNDED provenance memory under --ir-lineage — pruneChildProvenance + the trace caps become deletable",
  );

  // G2 — equivalence: the static path is provenance-identical to eager on real,
  // macro-expanded programs; flag-OFF stays byte-identical to today.
  it.todo(
    "G2: provenance(static, --ir-lineage on) == provenance(eager, flag off) on macro-expanded REAL programs (incl. if/let/cond and filter-fans); flag-off output is byte-identical to today",
  );

  // G3 — single representation: AValue carries ONE lineage-node reference; the
  // ~64 per-op accumulation sites are gone.
  it.todo(
    "G3: AValue carries a single lineage-node reference (not a flat ReadonlySet<number>) and the ~64 withInputProvenance / unionProvenance call sites are retired",
  );

  // G4 — no stranded consumer: every downstream reader works off the new rep.
  it.todo(
    "G4: handle-provenance (why/where/dag), the sift attestation seal, and the live studio trace-to-regions visualization all produce correct output read off the lineage-tree representation",
  );

  // G5 — confluence guard: the purity invariant is ENFORCED at runtime, not
  // honor-system — a reopened purity-door / secretly-mutating Rosetta is caught.
  it.todo(
    "G5: the purity invariant is ASSERTED at runtime — a reopened purity-door or a secretly-mutating Rosetta crossing is CAUGHT (thrown/flagged), not silently tolerated",
  );

  // G6 — carrier-coercion soundness: provenance survives the standard transforms
  // across ALL carriers; no coercion silently drops a provenance box.
  // Pair is pinned by A13 above; LazySeq by A8-live; the runnable golden below
  // pins the SchemeVector carrier (the remaining constructible one) under the
  // EAGER engine — the oracle the static path must reproduce. SchemeJSArray is a
  // membrane wrapper (no public constructor here) and is asserted only via the
  // todo, end-to-end through the flag.
  it.todo(
    "G6: provenance survives map/filter/length/sort across ALL carriers (Pair / SchemeVector / SchemeJSArray / LazySeq) under --ir-lineage — no coercion silently drops a provenance box; matches the eager golden per carrier",
  );

  it("G6-eager-golden(SchemeVector): a length-preserving vector-map PRESERVES the collection-level grouping fact; count/convert ops drop to the bare scalar/Pair exactly as eager does (this map IS the G2 oracle)", async () => {
    await initBridge();
    const mkVec = () => new SchemeVector([sStr("a", 100), sStr("b", 101)], new Set([7]));
    const summary = (r: unknown) => ({ ctor: (r as { constructor?: { name?: string } })?.constructor?.name ?? typeof r, prov: provOf(r) });
    const oneShot = async (src: string): Promise<unknown> => {
      const env = sandboxedEnv.inherit(`la-${seq++}`);
      env.set("xs", mkVec() as unknown as AValue);
      const [r] = await exec(src, { env });
      return summary(r);
    };
    const golden = {
      // A length-preserving transform must NOT drop the grouping box (id 7).
      vectorMap: await oneShot(`(vector-map (lambda (e) e) xs)`),
      // Stacked length-preserving fans: the box still survives.
      vectorMapTwice: await oneShot(`(vector-map (lambda (e) e) (vector-map (lambda (e) e) xs))`),
      // A cardinality observation reduces to a bare Number — the grouping box
      // is NOT carried onto the count today (the eager reality the static path
      // must match; G2 forbids "improving" it under the flag).
      vectorLength: await oneShot(`(vector-length xs)`),
      // Coercing a vector through the generic list `map`+`length` lands on the
      // same bare-Number shape — pinning that the coercion is lossy identically.
      mapLengthCoerce: await oneShot(`(length (map (lambda (e) e) xs))`),
      // vector->list converts the carrier; the collection-level box does not
      // ride onto the resulting Pair today.
      vectorToList: await oneShot(`(vector->list xs)`),
    };
    expect(golden).toMatchInlineSnapshot(`
      {
        "mapLengthCoerce": {
          "ctor": "Number",
          "prov": [],
        },
        "vectorLength": {
          "ctor": "Number",
          "prov": [],
        },
        "vectorMap": {
          "ctor": "SchemeVector",
          "prov": [
            7,
          ],
        },
        "vectorMapTwice": {
          "ctor": "SchemeVector",
          "prov": [
            7,
          ],
        },
        "vectorToList": {
          "ctor": "Pair",
          "prov": [],
        },
      }
    `);
  });

  // G7 — viz-readiness: the lineage tree carries the identity the v0.2 inhuman
  // flowchart needs (op-tag per node, call-id per source, a namer hook) so it
  // renders as infer-calls + transforms with no redesign. (Identity survives —
  // NOT a full render.)
  it.todo(
    "G7: the lineage tree carries a per-node op-tag + per-source call-id + a namer hook, so the v0.2 inhuman flowchart can render infer-calls + transforms off it WITHOUT a representation redesign",
  );
});
