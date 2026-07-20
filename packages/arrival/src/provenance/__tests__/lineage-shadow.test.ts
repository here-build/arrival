/**
 * SHADOW MODE (W3 slices 2–3) — the static lineage `fullCone` reproduces the
 * UNTAPPED eager `result.provenance`, asserted INSIDE `exec` behind the `irLineage`
 * flag. Design: the static-lineage finalization design (private monorepo docs)
 * §8 "W3 wiring design — SHADOW MODE".
 *
 * WHAT THIS LOCKS. The golden-prov-{arithmetic,fan,special-forms}.test.ts froze the
 * eager engine's provenance with inline snapshots (the G2 oracle). Those goldens
 * read `provOf(result)` directly. Here we run the SAME program shapes with
 * `irLineage: true`, which makes `exec` itself assert `fullCone(skeleton, bindings)
 * == provOf(result)` per form — so a green run here is a machine-checked agreement
 * between the static classifier and what those goldens froze. (We additionally
 * recompute the cone out-of-band and assert it equals the golden ids, so the
 * agreement is visible at the call site, not only as "exec didn't throw".)
 *
 * THE TWO PROVENANCE MECHANISMS (the doc's load-bearing correction): shadow compares
 * `fullCone` against mechanism (1) — the per-op EAGER STAMP that `exec` returns on
 * `result.provenance`, NO trace tap installed — never mechanism (2)'s tap-only
 * `computeProvenance`. The proven `lineage-checkpoint.test.ts:60-69` shape,
 * generalized over the golden program families.
 *
 * THE PROVABLE SCOPE (empirically determined, see lineage-shadow.ts "BOUNDARIES"):
 * SOURCE-FREE programs over input-leaf bindings, in the VALUE-position shapes where
 * the static cone coincides with the eager stamp — literals, pure pipe/merge
 * arithmetic, the string-collapse path, `cons`/`append` union, and `if`/`let`/`cond`
 * whose conservative selector∪arms superset equals the taken-arm eager cone. The
 * by-design divergences (element-projection car/cdr, cardinality-drop string-length,
 * control-flow cond superset, filter's fresh container stamp) are deliberately NOT
 * run under the flag — `exec` would throw on them, which is the correct shadow
 * signal that they lie outside the provable set (they are covered as eager goldens
 * in golden-prov-*, and as the v0.1/v0.2 boundary in the design doc). `append` MOVED
 * out of this divergence set (conservation repair, docs/RULINGS.md
 * R2): the rebuilt spine's head now carries the deep-collapsed union of both
 * operands' elements, matching the static classifier's pure-op union exactly — see
 * the agreement test below, not the boundary describe. `length`-over-`map` ALSO
 * MOVED out (C1/C2/C4 batch, same ruling): the A13 leak is closed — `length` reads
 * the container's own (now-correct) stamp, agreeing with the static spine. `filter`
 * MOVED IN as the new boundary case: R2/C2's PROVENANCED fresh stamp is exactly the
 * "grouping/element split" the v0.1 static fan model doesn't represent yet.
 */
import { describe, it, expect } from "vitest";
import invariant from "tiny-invariant";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { initBridge } from "../../index.js";
import { exec, execState, parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../inference-env.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { fromJs } from "../../membrane/boxing.js";
import { APair } from "../../values/primitives/APair.js";
import { ANil } from "../../values/primitives/ANil.js";
import type { SchemeValue } from "../../values/types.js";
import { classify, fullCone } from "../../provenance/lineage.js";
import { classifierFromEnv } from "../../provenance/lineage-classifier-from-env.js";
import { provOf, bindingsForSkeleton } from "../../provenance/lineage-shadow.js";
import { requireEagerOracle } from "../../__tests__/_require-eager-oracle.js";
// In-package test: the module-internal storage write (hermetic-Environment ruling — no public set).
import { bindValue, mintFrame } from "../../AmbientRuntime.js";

// Q20b: shadow mode compares the static classifier against the UNTAPPED EAGER
// stamp (mechanism 1) — the whole point of this file. Force the oracle ON for its
// lifetime, or every eager cone below comes back empty and every "agrees with the
// golden" assertion silently degrades into "both sides are []".
requireEagerOracle();

let seq = 0;

/** A provenance-stamped string / number source (mirrors golden-prov-* fixtures). */
const sStr = (s: string, p: number): AString => new AString(CONSTANT_CTX, s, new Set([p]));
/** Box a JS number into its concrete numeric leaf — `fromJs` is typed to the abstract
 *  `AValue` base, but boxing a `number` always mints an `AExact`/`AInexact` at runtime;
 *  narrow honestly with a guard (the boxing.ts:38 idiom) so the binding maps stay
 *  `SchemeValue`-typed and flow into `env.set` without a cast. */
const sNum = (n: number, p: number): AExact | AInexact => {
  const boxed = fromJs(CONSTANT_CTX, n, new Set([p]));
  invariant(boxed instanceof AExact || boxed instanceof AInexact, "sNum: a boxed JS number must be AExact/AInexact");
  return boxed;
};

const nums = () => ({ a: sNum(10, 100), b: sNum(20, 200), c: sNum(30, 300) });
const strs = () => ({ a: sStr("a", 100), b: sStr("b", 200), c: sStr("c", 300) });

/**
 * Run `src` under SHADOW MODE and return both cones. `exec({irLineage:true})`
 * asserts `fullCone == provOf(result)` internally (throws on in-scope divergence);
 * we ALSO recompute the static cone out-of-band so the agreement is asserted at the
 * call site against the golden ids. Source-free by default (empty sources).
 */
async function shadow(src: string, binds: Record<string, SchemeValue>): Promise<{ staticCone: number[]; eager: number[] }> {
  await initBridge();
  const env = mintFrame(inferenceEnv, `shadow-${seq++}`);
  for (const [k, v] of Object.entries(binds)) bindValue(env, k, v);

  // exec under the flag: this is the in-engine shadow assert (slices 2+3). If the
  // static cone diverged from the eager stamp on any form, exec would throw here.
  // execState (COMPLEX tier): `provOf` reads BOXED provenance (RULINGS.md R1).
  const [result] = (await execState(src, { env, irLineage: true })).values;
  const eager = provOf(result);

  // Out-of-band recompute for a call-site-visible assertion against the golden ids.
  const [ast] = await parse(src);
  const skel = classify(ast, classifierFromEnv(env));
  const staticCone = fullCone(skel, bindingsForSkeleton(skel, env));
  return { staticCone, eager };
}

/** Assert the static cone, the eager stamp, AND the frozen golden are all equal. */
async function expectCone(src: string, binds: Record<string, SchemeValue>, golden: number[]): Promise<void> {
  const { staticCone, eager } = await shadow(src, binds);
  expect(eager).toEqual(golden); // the eager stamp matches what golden-prov-* froze
  expect(staticCone).toEqual(golden); // and the static fullCone reproduces it (no divergence)
}

// Shared it.each row shapes. Explicit (not inferred) because the tables below mix rows
// whose `binds` bind different variable names — left to inference, TS widens each row to
// its own literal interface and unions them, which no longer satisfies `Record<string,
// SchemeValue>`. Naming the type once keeps every `binds: {...}` cell a plain object literal.
type ConeRow = { name: string; src: string; binds: Record<string, SchemeValue>; golden: number[] };
type DivergenceRow = { name: string; src: string; binds: Record<string, SchemeValue> };

// ─────────────────────────────────────────────────────────────────────────────
// ARITHMETIC — literals (mint nothing), pipes (1 source), merges (≥2 sources).
// Oracle: golden-prov-arithmetic.test.ts §§1–3.
// ─────────────────────────────────────────────────────────────────────────────
describe("SHADOW — arithmetic: literals / pipes / merges == eager golden", () => {
  it.each<ConeRow>([
    { name: "(+ 1 2) — all-literal mints nothing", src: `(+ 1 2)`, binds: {}, golden: [] },
    { name: "(- 10 (* 2 3)) — nested all-literal tree", src: `(- 10 (* 2 3))`, binds: {}, golden: [] },
    { name: "(* x x) — one source used twice (pipe)", src: `(* x x)`, binds: { x: sNum(7, 200) }, golden: [200] },
    { name: "(+ a 5) — source + literal carries only the source (pipe)", src: `(+ a 5)`, binds: nums(), golden: [100] },
    { name: "(< 0 (* x x)) — predicate over a single source (pipe)", src: `(< 0 (* x x))`, binds: { x: sNum(7, 200) }, golden: [200] },
    { name: "(+ a b) — two sources fan in (merge)", src: `(+ a b)`, binds: nums(), golden: [100, 200] },
    { name: "(max a b) — n-ary numeric merge", src: `(max a b)`, binds: nums(), golden: [100, 200] },
    { name: "(* a (+ 1 b)) — merge over a source and a one-source pipe", src: `(* a (+ 1 b))`, binds: nums(), golden: [100, 200] },
    { name: "(+ a (* b c)) — three sources fan in across two levels", src: `(+ a (* b c))`, binds: nums(), golden: [100, 200, 300] },
  ])("$name", async ({ src, binds, golden }) => {
    await expectCone(src, binds, golden);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STRING COLLAPSE + cons union. Oracle: golden-prov-arithmetic.test.ts §§4–5.
// (Only the union-shaped list ops match; car/cdr element-projection diverge by
// design and are covered as eager goldens + boundary below.)
// ─────────────────────────────────────────────────────────────────────────────
describe("SHADOW — string-collapse & cons-union == eager golden", () => {
  it.each<ConeRow>([
    { name: "(string-length a) — cardinality propagates its one source (DR2/B1 resolved: fullCone)", src: `(string-length a)`, binds: strs(), golden: [100] },
    { name: "(string-append a b) — two stamped strings union", src: `(string-append a b)`, binds: strs(), golden: [100, 200] },
    { name: "(string-append a b c) — three-way collapse", src: `(string-append a b c)`, binds: strs(), golden: [100, 200, 300] },
    { name: '(join "," (list a b)) — join over a list of stamped strings', src: `(join "," (list a b))`, binds: strs(), golden: [100, 200] },
    { name: '(string-append "x:" (join "," (list a b))) — nested collapse', src: `(string-append "x:" (join "," (list a b)))`, binds: strs(), golden: [100, 200] },
    { name: "(cons a b) — the cons cell carries the UNION of both elements", src: `(cons a b)`, binds: strs(), golden: [100, 200] },
    { name: "(append (list a) (list b)) — the rebuilt spine's head unions both operands (conservation repair)", src: `(append (list a) (list b))`, binds: strs(), golden: [100, 200] },
  ])("$name", async ({ src, binds, golden }) => {
    await expectCone(src, binds, golden);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPECIAL FORMS — if / let / cond, in the cases where the conservative static
// superset (selector ∪ arms / transparent substitution) coincides with the eager
// taken-arm cone. Oracle: golden-prov-special-forms.test.ts.
// ─────────────────────────────────────────────────────────────────────────────
describe("SHADOW — `if` mux (selector ∪ arms) == eager golden", () => {
  it.each<ConeRow>([
    { name: "positive arm: (if (< 0 v) v -1), v>0", src: `(if (< 0 v) v -1)`, binds: { v: sNum(10, 5) }, golden: [5] },
    { name: "predicate taints a literal arm: (if (< 0 v) v -1), v<0 → still {5}", src: `(if (< 0 v) v -1)`, binds: { v: sNum(-3, 5) }, golden: [5] },
    { name: "predicate-only source, literal arms: (if (< 0 (* x x)) 99 -1) → {7}", src: `(if (< 0 (* x x)) 99 -1)`, binds: { x: sNum(3, 7) }, golden: [7] },
    { name: "predicate source UNION arm source: (if (< 0 x) v -1) → {5,7}", src: `(if (< 0 x) v -1)`, binds: { x: sNum(3, 7), v: sNum(10, 5) }, golden: [5, 7] },
    {
      name: "two-armed merge in the taken branch: (if (< 0 x) (* v1 v2) -1) → {7,100,200}",
      src: `(if (< 0 x) (* v1 v2) -1)`,
      binds: { x: sNum(3, 7), v1: sNum(5, 100), v2: sNum(7, 200) },
      golden: [7, 100, 200],
    },
  ])("$name", async ({ src, binds, golden }) => {
    await expectCone(src, binds, golden);
  });
});

describe("SHADOW — `let` transparency == eager golden (== inlined)", () => {
  it.each<ConeRow>([
    { name: "(let ((foo (+ 1 v2))) (* v1 foo)) == inlined cone", src: `(let ((foo (+ 1 v2))) (* v1 foo))`, binds: { v1: sNum(5, 100), v2: sNum(7, 200) }, golden: [100, 200] },
    { name: "inlined twin (* v1 (+ 1 v2)) — same cone", src: `(* v1 (+ 1 v2))`, binds: { v1: sNum(5, 100), v2: sNum(7, 200) }, golden: [100, 200] },
    { name: "nested let threads both bindings", src: `(let ((a v1)) (let ((b v2)) (+ a b)))`, binds: { v1: sNum(5, 100), v2: sNum(7, 200) }, golden: [100, 200] },
    { name: "let* sequential binding is transparent", src: `(let* ((a v1) (b (+ a v2))) b)`, binds: { v1: sNum(5, 100), v2: sNum(7, 200) }, golden: [100, 200] },
    { name: "a let body returning a pure literal carries NOTHING", src: `(let ((foo v1)) 42)`, binds: { v1: sNum(5, 100) }, golden: [] },
  ])("$name", async ({ src, binds, golden }) => {
    await expectCone(src, binds, golden);
  });
});

describe("SHADOW — `cond` single-matched-clause (superset == taken arm) == eager golden", () => {
  // The matched-clause-with-literal-else cases where the static selector∪arms
  // superset coincides with the eager matched cone (no failed-clause selector to
  // drop, no live un-taken arm). The else-taken / distinct-failed-selector cases
  // diverge by design (DR3) and are excluded — see the BOUNDARY test below.
  it("matched clause, merge arm, literal else: (cond ((< v 0) (* p q)) (else 0)) → {5,9,13}", async () => {
    await expectCone(`(cond ((< v 0) (* p q)) (else 0))`, { v: sNum(-1, 5), p: sNum(4, 9), q: sNum(2, 13) }, [5, 9, 13]);
  });
});

describe("SHADOW — `when` / `unless` mux (one-armed if) == eager golden", () => {
  // when/unless go through classifyGuardedBody → a one-armed mux(selector=test,
  // arms=[body]). When the body arm is TAKEN (when's test true / unless's test
  // false), the static selector∪body superset coincides with the eager cone (the
  // predicate's taint ∪ the body), so shadow agrees with NO throw — exercising the
  // live wiring of the guarded-body path, not just classify() in isolation.
  it.each<ConeRow>([
    { name: "when, test TRUE → body taken: (when (< 0 x) v), x>0 → predicate ∪ body {5,7}", src: `(when (< 0 x) v)`, binds: { x: sNum(3, 7), v: sNum(10, 5) }, golden: [5, 7] },
    { name: "unless, test FALSE → body taken: (unless (< 0 x) v), x<0 → predicate ∪ body {5,7}", src: `(unless (< 0 x) v)`, binds: { x: sNum(-3, 7), v: sNum(10, 5) }, golden: [5, 7] },
  ])("$name", async ({ src, binds, golden }) => {
    await expectCone(src, binds, golden);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FANS (the matching half). A bare `map`/`filter` result's SPINE carries [] on
// BOTH paths (the per-element ids live on the elements, not the list head — the
// golden-prov-fan §"the mapped LIST head's own provenance is EMPTY" finding), so
// the fan-value cone matches. The CARDINALITY observation (length over a fan) is
// the by-design over-attribution divergence — excluded, see BOUNDARY below.
// ─────────────────────────────────────────────────────────────────────────────
describe("SHADOW — bare fan result spine == eager golden ([] both paths)", () => {
  it("(map (lambda (e) e) xs) — mapped spine carries []", async () => {
    await initBridge();
    const env = mintFrame(inferenceEnv, `shadow-fan-${seq++}`);
    bindValue(env, "xs", APair.fromArray(CONSTANT_CTX, [sStr("a", 100), sStr("b", 101), sStr("c", 102)], false));
    const [result] = (await execState(`(map (lambda (e) e) xs)`, { env, irLineage: true })).values;
    expect(provOf(result)).toEqual([]); // eager spine
    const [ast] = await parse(`(map (lambda (e) e) xs)`);
    const skel = classify(ast, classifierFromEnv(env));
    expect(fullCone(skel, bindingsForSkeleton(skel, env))).toEqual([]); // static spine — agree
  });
});

describe("SHADOW — length-over-map fan: A13 CLOSED, static and eager now AGREE", () => {
  // MOVED here from the BOUNDARY describe below (was: "fan cardinality
  // over-attribution... static {} (spine), eager {100,101,102}", asserted to THROW).
  // C4's interim fix (docs/RULINGS.md R2, the R2 container structural-facts batch):
  // `length` now reads the container's own flat grouping-fact stamp instead of
  // deep-unioning every mapped element — for this UNMINTED source (`xs` built via a
  // plain `APair.fromArray`, no Rosetta-IN crossing), that stamp is EMPTY, matching
  // EXACTLY what the static classifier already predicted (`fullCone` == `[]`, a
  // length-preserving fan pruned to the spine). The eager and static cones AGREE now
  // — no more shadow divergence, no more throw.
  it("(length (map (lambda (e) e) xs)) — static [] == eager [] (the A13 leak is closed)", async () => {
    await initBridge();
    const env = mintFrame(inferenceEnv, `shadow-fan-${seq++}`);
    bindValue(env, "xs", APair.fromArray(CONSTANT_CTX, [sStr("a", 100), sStr("b", 101), sStr("c", 102)], false));
    const [result] = (await execState(`(length (map (lambda (e) e) xs))`, { env, irLineage: true })).values;
    expect(provOf(result)).toEqual([]); // eager — C4 fix
    const [ast] = await parse(`(length (map (lambda (e) e) xs))`);
    const skel = classify(ast, classifierFromEnv(env));
    expect(fullCone(skel, bindingsForSkeleton(skel, env))).toEqual([]); // static — unchanged, agrees
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BOUNDARY — by-design divergences. Each program below is a CORRECT static
// cone that legitimately disagrees with the eager stamp; running it under the flag
// MUST throw ProvenanceShadowDivergence. This proves the shadow assert is strict
// (it does NOT silently pass divergence) and documents exactly what is out of the
// v0.1 provable set. These are the eager goldens in golden-prov-* + the v0.2 line.
// ─────────────────────────────────────────────────────────────────────────────
describe("SHADOW BOUNDARY — by-design divergences throw under the flag (strict, not swallowed)", () => {
  async function runFlagged(src: string, binds: Record<string, SchemeValue>): Promise<void> {
    await initBridge();
    const env = mintFrame(inferenceEnv, `shadow-bound-${seq++}`);
    for (const [k, v] of Object.entries(binds)) bindValue(env, k, v);
    await exec(src, { env, irLineage: true });
  }

  // Both rows are by-design divergences run through the same `runFlagged` +
  // `rejects.toThrow` shape:
  //   - car element-projection: the static tree has no projection node (car is
  //     treated as a pure op → operand union: {100,200}), while eager projects
  //     just the car's own source ({100}). §5.3 element-vs-container projection,
  //     out of v0.1 scope.
  //   - control-flow superset: the static cond cone is a conservative SUPERSET
  //     (it cannot know the taken branch: {5,11,22}), while eager reflects only
  //     the taken arm ({22}). DR3; byte-identical control-flow why stays
  //     eager-sourced (Wave S).
  it.each<DivergenceRow>([
    { name: "car element-projection: (car (cons a b)) — static unions {100,200}, eager projects {100}", src: `(car (cons a b))`, binds: strs() },
    {
      name: "control-flow superset: (cond ((< v 0) a) (else b)), else taken — static {5,11,22} ⊋ eager {22}",
      src: `(cond ((< v 0) a) (else b))`,
      binds: { v: sNum(9, 5), a: sNum(11, 11), b: sNum(22, 22) },
    },
  ])("$name", async ({ src, binds }) => {
    await expect(runFlagged(src, binds)).rejects.toThrow(/PROVENANCE-SHADOW-DIVERGENCE/);
  });
  // MOVED OUT (2026-07-08, C1/C2/C4 batch): "fan cardinality over-attribution:
  // (length (map id xs))" used to throw here (static {}, eager {100,101,102} — the
  // A13 leak). C4 closed A13 — eager now reads the container's own (empty) stamp,
  // agreeing with the static spine. See "SHADOW — length-over-map fan: A13 CLOSED"
  // above, not a boundary divergence anymore.
  //
  // NEW divergence introduced by the SAME fix, moved IN: filter is length-CHANGING
  // (R2/C2) — its container's own stamp is now PROVENANCED (the survivors' own
  // union), which the v0.1 static classifier's fan model does not yet represent (it
  // still treats every fan's result spine as carrying []). This is exactly the
  // "grouping/element split is v0.2" scope note the OLD A13 row already named —
  // filter is simply the fan where the split now matters on the EAGER side first.
  it("filter fresh container stamp: (filter pred xs) — static [] (spine, v0.1 fan model), eager [100,102] (R2/C2 PROVENANCED survivors)", async () => {
    await initBridge();
    const env = mintFrame(inferenceEnv, `shadow-bound-${seq++}`);
    bindValue(env, "xs", APair.fromArray(CONSTANT_CTX, [sStr("a", 100), sStr("b", 101), sStr("c", 102)], false));
    await expect(
      exec(`(filter (lambda (e) (not (string=? e "b"))) xs)`, { env, irLineage: true }),
    ).rejects.toThrow(/PROVENANCE-SHADOW-DIVERGENCE/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SKIP CATEGORIES — macro head + keyword projection are RECORDED (uncovered), not
// asserted. A macro-headed / `(:field …)` form must NOT throw under the flag even
// though its eager and static cones may differ — it is out of the classifier's
// model entirely (no static node), so shadow correctly abstains.
// ─────────────────────────────────────────────────────────────────────────────
describe("SHADOW SKIP — macro-head / keyword-projection forms abstain (no throw)", () => {
  it("keyword projection (:length …) is skipped, not asserted", async () => {
    // A `(:keyword …)` head is a where-provenance projection with no static node
    // (v0.2/B2). exec under the flag must not throw — the form is recorded uncovered.
    await initBridge();
    const env = mintFrame(inferenceEnv, `shadow-skip-${seq++}`);
    // `a` is `nil` (was a bound string) — since benchmark-defect-register.md's B2, a
    // keyword accessor on a LEAF kind with no member protocol (a string included)
    // throws instead of silently returning nil; nil→nil is the one receiver shape
    // guaranteed to stay silent (legitimate absence). This test's own point is the
    // SHADOW mechanism's abstention for a `:`-prefixed head, not keyword-accessor
    // type-safety, so any non-throwing receiver preserves its intent.
    bindValue(env, "a", new ANil(CONSTANT_CTX, new Set([100])));
    // `(:length a)` resolves via the keyword-accessor membrane pluck; whatever its
    // value/cone, shadow abstains because the head starts with ':'.
    await expect(exec(`(:length a)`, { env, irLineage: true })).resolves.toBeDefined();
  });

  it("a `define` (macro head) is skipped via the macro-head branch, never asserted", async () => {
    // `define` is bound to a `Macro` in the env (it is NOT in CLASSIFIED_SPECIAL_FORMS),
    // so `shadowSkipReason` returns {kind:"macro-head"} and `assertShadowCone` takes the
    // skip EARLY-RETURN — it abstains and never reaches the cone compare (no fullCone vs
    // provOf at all). Same abstention path as the keyword-projection sibling above, just
    // via the macro-head branch instead of the ':'-prefix one. Guards that a
    // macro-headed top-level form does not throw under the flag.
    await initBridge();
    const env = mintFrame(inferenceEnv, `shadow-skip-${seq++}`);
    await expect(exec(`(define z 5)`, { env, irLineage: true })).resolves.toBeDefined();
  });
});
