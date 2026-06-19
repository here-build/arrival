/**
 * GOLDEN CAPTURE (gate G2 oracle) — special-form provenance: if / let / cond.
 *
 * WAVE R / RED-SPEC. These snapshots pin the CURRENT (eager) engine's provenance
 * for the three special forms the static lineage classifier currently
 * MISCLASSIFIES as plain applications (lineage.ts §SCOPE; lineage-assumptions
 * A4-classifier is `it.todo`). The `--ir-lineage` flag does not exist yet, so the
 * eager behavior captured here IS the golden oracle: when `classify()` learns
 * special forms, `provenance(static, flag-on)` must reproduce these exact sets
 * (gate G2 — equivalence on macro-expanded REAL programs incl. if/let/cond),
 * and `flag-off` must stay byte-identical to what is snapshotted below.
 *
 * Self-contained by design (inline helpers mirror lineage-assumptions.test.ts /
 * lineage-spike.test.ts) so the file never collides with a sibling under
 * concurrent authoring; the parent dedupes helpers at integration.
 *
 * THE LOAD-BEARING DISCOVERY these goldens lock (and where the spike's stated
 * assumption diverges from observed reality):
 *
 *   The spike claims "a pure predicate mints nothing" (lineage-spike.test.ts:44)
 *   and its `classify()` would DROP an `if`/`cond` predicate entirely. The eager
 *   engine does NOT: the predicate's provenance is consumed by the test and
 *   PROPAGATES into the result — even when the taken arm is a bare literal that
 *   carries nothing of its own (see `if — predicate provenance taints a literal
 *   arm`). So the result's cone today is (matched-predicate ∪ taken-arm), not
 *   just the taken arm. A subtlety the cond cases pin precisely: only the
 *   MATCHED clause's predicate contributes — a FAILED clause's predicate does
 *   NOT leak into a later arm (`cond — else arm: a failed predicate does not
 *   leak`). This is exactly the gap the `A4-classifier` todo must resolve: the
 *   classifier needs a `mux` node whose cone unions the selector-on-the-taken-
 *   path with the taken arm, NOT a node that discards the predicate.
 */
import { describe, it, expect } from "vitest";
import { initBridge } from "../bridge";
import { exec } from "../stdlib";
import { sandboxedEnv } from "../sandbox-env";
import { AValue } from "../values/AValue";

let seq = 0;
const provOf = (v: unknown): number[] => (v instanceof AValue ? [...v.provenance].sort((a, b) => a - b) : []);
/** A provenance-stamped number source — exercises the real AValue arithmetic path.
 *  (if/let/cond cones are all numeric here; the string source the assumptions
 *  ledger uses for per-element ids is unnecessary for the scalar control forms.) */
const sNum = (n: number, p: number) => AValue.fromJs(n, new Set([p]));

/** Provenance of the evaluated form, sorted ascending. */
async function run(src: string, binds: Record<string, unknown> = {}): Promise<number[]> {
  return provOf(await runRaw(src, binds));
}

async function runRaw(src: string, binds: Record<string, unknown> = {}): Promise<unknown> {
  await initBridge();
  const env = sandboxedEnv.inherit(`gpsf-${seq++}`);
  for (const [k, v] of Object.entries(binds)) env.set(k, v as AValue);
  const [r] = await exec(src, { env });
  return r;
}

// ── if ──────────────────────────────────────────────────────────────────────
describe("GOLDEN — `if` provenance (gate G2 oracle)", () => {
  it("positive arm taken: (if (< 0 v) v -1) carries the chosen value's provenance", async () => {
    // v=10 (id 5): predicate true, returns v. Both predicate and arm reference v,
    // so the cone is just {5} — no fan-out to distinguish here.
    expect(await run(`(if (< 0 v) v -1)`, { v: sNum(10, 5) })).toMatchInlineSnapshot(`
      [
        5,
      ]
    `);
  });

  it("predicate provenance TAINTS a literal arm: (if (< 0 v) v -1), v negative → still carries v", async () => {
    // v=-3 (id 5): predicate FALSE, so the engine returns the literal -1, which
    // carries nothing of its own. Yet the result is {5}: the predicate `(< 0 v)`
    // consumed v's provenance and it propagated to the chosen arm. THIS is the
    // fact the spike's "pure predicate mints nothing" assumption misses — the
    // predicate is NOT pure control in the eager engine; its lineage flows out.
    expect(await run(`(if (< 0 v) v -1)`, { v: sNum(-3, 5) })).toMatchInlineSnapshot(`
      [
        5,
      ]
    `);
  });

  it("predicate-only source, pure-literal arms: (if (< 0 (* x x)) 99 -1) carries the predicate's source", async () => {
    // x=3 (id 7): both arms are bare literals (no provenance). The result is {7}
    // SOLELY because the predicate `(* x x)` carried x. A classifier that drops
    // the predicate would wrongly compute {} here — the equivalence gate G2 fails.
    expect(await run(`(if (< 0 (* x x)) 99 -1)`, { x: sNum(3, 7) })).toMatchInlineSnapshot(`
      [
        7,
      ]
    `);
  });

  it("predicate source UNION arm source: (if (< 0 x) v -1) merges both cones", async () => {
    // x=3 (id 7) drives the predicate; v=10 (id 5) is the taken arm. The result
    // carries BOTH — the cone is the predicate's source ∪ the taken arm's source.
    expect(await run(`(if (< 0 x) v -1)`, { x: sNum(3, 7), v: sNum(10, 5) })).toMatchInlineSnapshot(`
      [
        5,
        7,
      ]
    `);
  });

  it("two-armed merge in the taken branch: (if (< 0 x) (* v1 v2) -1)", async () => {
    // Predicate x=id7; taken arm is an arithmetic merge of v1=id100, v2=id200.
    // Cone = predicate ∪ both arm operands → {7,100,200}.
    expect(await run(`(if (< 0 x) (* v1 v2) -1)`, { x: sNum(3, 7), v1: sNum(5, 100), v2: sNum(7, 200) })).toMatchInlineSnapshot(`
      [
        7,
        100,
        200,
      ]
    `);
  });
});

// ── let (transparency — must equal the inlined form) ──────────────────────────
describe("GOLDEN — `let` transparency (gate G2 oracle)", () => {
  it("(let ((foo (+ 1 v2))) (* v1 foo)) has the SAME cone as the inlined (* v1 (+ 1 v2))", async () => {
    // The binding is pure substitution: the graph is the object, not the syntax.
    // A classifier that treats `let` as an application would read `let` as the
    // operator and mis-shape the tree; G2 requires these two cones identical.
    const inlined = await run(`(* v1 (+ 1 v2))`, { v1: sNum(5, 100), v2: sNum(7, 200) });
    const letform = await run(`(let ((foo (+ 1 v2))) (* v1 foo))`, { v1: sNum(5, 100), v2: sNum(7, 200) });
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

  it("nested let threads provenance through both bindings: (let ((a v1)) (let ((b v2)) (+ a b)))", async () => {
    expect(await run(`(let ((a v1)) (let ((b v2)) (+ a b)))`, { v1: sNum(5, 100), v2: sNum(7, 200) })).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it("let* sequential binding is equally transparent: (let* ((a v1) (b (+ a v2))) b)", async () => {
    expect(await run(`(let* ((a v1) (b (+ a v2))) b)`, { v1: sNum(5, 100), v2: sNum(7, 200) })).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it("a let body that returns a pure literal carries NOTHING: (let ((foo v1)) 42)", async () => {
    // foo is bound but unused; the body is a bare literal. No source reaches the
    // result, so the cone is empty — the binding's provenance does not leak in.
    expect(await run(`(let ((foo v1)) 42)`, { v1: sNum(5, 100) })).toMatchInlineSnapshot(`[]`);
  });
});

// ── cond (matched-predicate ∪ matched-arm; failed predicates do not leak) ──────
describe("GOLDEN — `cond` provenance (gate G2 oracle)", () => {
  it("matched clause: predicate provenance UNIONs the arm — (cond ((< v 0) a) (else b)) → {pred, a}", async () => {
    // v=-1 (id 5): clause 1 matches. predicate `(< v 0)` carries v=id5, arm `a`
    // carries id11 → result {5,11}. Same predicate-taint as `if`.
    expect(await run(`(cond ((< v 0) a) (else b))`, { v: sNum(-1, 5), a: sNum(11, 11), b: sNum(22, 22) })).toMatchInlineSnapshot(`
      [
        5,
        11,
      ]
    `);
  });

  it("else arm: a FAILED predicate does NOT leak into the else branch — only {b}", async () => {
    // v=9 (id 5): clause 1's predicate is tested and FAILS; the else arm `b`
    // (id 22) is returned. Crucially the result is {22}, NOT {5,22} — the failed
    // predicate's provenance is discarded. Contrast the matched case above: ONLY
    // the matched clause's selector contributes. This asymmetry is exactly what a
    // `mux` lineage node must model (selector-on-the-taken-path ∪ taken-arm).
    expect(await run(`(cond ((< v 0) a) (else b))`, { v: sNum(9, 5), a: sNum(11, 11), b: sNum(22, 22) })).toMatchInlineSnapshot(`
      [
        22,
      ]
    `);
  });

  it("matched clause with a merge arm: (cond ((< v 0) (* p q)) (else 0)) → {pred, p, q}", async () => {
    // v=-1 (id 5) matches; arm `(* p q)` merges p=id9, q=id13. Cone = {5,9,13}.
    expect(await run(`(cond ((< v 0) (* p q)) (else 0))`, { v: sNum(-1, 5), p: sNum(4, 9), q: sNum(2, 13) })).toMatchInlineSnapshot(`
      [
        5,
        9,
        13,
      ]
    `);
  });

  it("second clause matches: the FIRST clause's failed predicate does not contribute", async () => {
    // v=5 (id 5): clause 1 `(< v 0)` fails, clause 2 `(> v 0)` matches → arm `a`
    // (id 11). Both predicates reference the SAME v=id5; the result is {5,11}.
    // (Here the matched predicate happens to share v's id with the failed one, so
    // the snapshot alone can't separate them — `else arm` above is the clean
    // discriminator. This case pins the multi-clause shape.)
    expect(await run(`(cond ((< v 0) z) ((> v 0) a) (else b))`, { v: sNum(5, 5), z: sNum(99, 99), a: sNum(11, 11), b: sNum(22, 22) })).toMatchInlineSnapshot(`
      [
        5,
        11,
      ]
    `);
  });

  it("multi-clause with DISTINCT selector source: only the matched selector's id appears", async () => {
    // Predicates test different sources: clause 1 on `w` (id 50, fails), clause 2
    // on `v` (id 5, matches) → arm `a` (id 11). The result must be {5,11} and must
    // NOT contain 50 — proving the failed clause's distinct selector is dropped.
    // This is the sharpest G2 oracle for the cond mux: a classifier that unions
    // ALL selectors would wrongly include 50.
    expect(await run(`(cond ((< w 0) z) ((> v 0) a) (else b))`, { w: sNum(7, 50), v: sNum(5, 5), z: sNum(99, 99), a: sNum(11, 11), b: sNum(22, 22) })).toMatchInlineSnapshot(`
      [
        5,
        11,
      ]
    `);
  });
});

// ── GATE TODO — the static path must reproduce the goldens above ──────────────
describe("GATE G2 (static lineage == eager golden on special forms) — TODO until --ir-lineage lands", () => {
  // classify() currently treats if/let/cond as plain applications (lineage.ts
  // §SCOPE) and has no `mux` node, so it cannot yet reproduce the goldens above.
  // When the classifier learns special forms, assert: for each program here,
  // fullCone(classify(macroExpand(ast)), bindings) === <the eager snapshot>.
  it.todo("A4-classifier: classify() handles if/let/cond (special forms) — fullCone == eager golden");
  // The cond asymmetry (matched selector contributes, failed selectors do not)
  // and the if predicate-taint require a selector-aware `mux` node, not the
  // pure-control `mux` the spike's SCOPE note sketched (which would DROP the
  // predicate and fail the `if (< 0 v) v -1 → {5}` literal-arm golden).
  it.todo("A4-mux: the `mux` node's cone = matched-selector ∪ taken-arm (NOT a dropped predicate)");
  // G2 demands the comparison run on macro-expanded ASTs (cond desugars to nested
  // if; let to a lambda application) — the classifier input is post-expansion.
  it.todo("A21: classify() runs on the MACRO-EXPANDED ast (cond→if, let→lambda), not raw reader output");
});
