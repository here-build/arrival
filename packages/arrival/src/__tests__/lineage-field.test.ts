/**
 * v0.2 — the FIELD / lens carrier (design
 * docs/working-proposals/provenance-static-lineage-v0.2-lens-carrier-2026-06-20.md
 * §"The carrier", §"The viz constraint", "Decisions resolved"). Proves the new
 * `field` LineageNode — the static form of trace.ts's runtime field-point — and
 * that it:
 *   - NORMALIZES every member-read surface syntax (`(:foo x)` / `(@ x :foo)` /
 *     `(car x)` / `(vector-ref x i)`) to ONE canonical node + step;
 *   - ABSORBS a field-under-field to base + innermost step (D-v02-1, mirroring
 *     trace.ts:351-352 — no nested-key path);
 *   - stays NEUTRAL for the teleological fullCone (a field over x yields x's cone,
 *     byte-identical to the pre-v0.2 pipe classification — the v0.1 shadow, which
 *     skips `(:field …)` heads, is unaffected);
 *   - DEMAND-AS-PROJECTION (fieldCone, D-v02-2): demanding one field follows the
 *     matching field child and prunes the siblings — no explicit optic needed;
 *   - composes with a FAN without unrolling (fan×lens, §"The viz constraint"): a
 *     field projected inside a fan template nests UNDER the fan; a field over the
 *     fan wraps it — the single `[number][field]` parametric wire the v02-G6 viz
 *     reads.
 *
 * DR5: assert via the tree structure (.kind/.step) and fullCone/fieldCone, never
 * equal?. ADDITIVE — the serial core (computeProvenance / AValue.provenance) is
 * untouched; its retirement is a later phase.
 */
import { describe, it, expect } from "vitest";
import { initBridge } from "../bridge";
import { parse } from "../eval/generator-exec";
import { sandboxedEnv } from "../sandbox-env";
import {
  classify,
  fullCone,
  countCone,
  fieldCone,
  type Classifier,
  type LineageNode,
} from "../values/lineage";

const C: Classifier = {
  // `dict` is treated as a pure constructor here so the fan×lens body classifies.
  isPure: (op) =>
    ["+", "-", "*", "/", "<", ">", "=", "car", "cdr", "cons", "list", "length", "not", "dict"].includes(op),
  isRosettaIn: (op) => ["infer", "fetch", "db-read"].includes(op),
  isFan: (op) => ["map", "filter", "vector-map"].includes(op),
  isOpaque: (op) => ["ext-call"].includes(op),
};

async function skeleton(src: string): Promise<LineageNode> {
  await initBridge();
  const [ast] = await parse(src, sandboxedEnv);
  return classify(ast, C); // STATIC — no execution
}

// ── NORMALIZATION — every surface accessor → ONE canonical field node ─────────
describe("lineage field — member-read syntaxes normalize to a canonical `field` node", () => {
  it("(:foo x) → field{step:{field:'foo'}} over leaf(x) (keyword accessor)", async () => {
    const n = await skeleton(`(:foo x)`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ field: "foo" });
    expect(n.child).toEqual({ kind: "leaf", slot: "x" });
  });

  it("(@ x :foo) → the SAME canonical field node (membrane.readMember, keyword key)", async () => {
    const n = await skeleton(`(@ x :foo)`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    // Canonical step is identical to `(:foo x)` — the head differs, the node does not.
    expect(n.step).toEqual({ field: "foo" });
    expect(n.child).toEqual({ kind: "leaf", slot: "x" });
  });

  it("(@ x \"foo\") → field{field:'foo'} (string key is the same canonical step)", async () => {
    const n = await skeleton(`(@ x "foo")`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ field: "foo" });
  });

  it("(car x) → field{step:{car:true}} over leaf(x)", async () => {
    const n = await skeleton(`(car x)`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ car: true });
    expect(n.child).toEqual({ kind: "leaf", slot: "x" });
  });

  it("(vector-ref x 1) → field{step:{index:1}} over leaf(x) (literal index)", async () => {
    const n = await skeleton(`(vector-ref x 1)`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ index: 1 });
    expect(n.child).toEqual({ kind: "leaf", slot: "x" });
  });

  it("(list-ref x 2) → field{step:{index:2}} (list-ref shares the index step)", async () => {
    const n = await skeleton(`(list-ref x 2)`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ index: 2 });
  });

  it("a VARIABLE index is NOT a static field: (vector-ref x n) stays a pure op (pipe/merge)", async () => {
    // The key isn't known statically (no literal), so there's no field node — the
    // form falls through to the pure-op arity cut (here: pipe over leaf(x); `n` is
    // also a leaf → merge). Either way: NOT a field.
    const n = await skeleton(`(vector-ref x n)`);
    expect(n.kind).not.toBe("field");
  });

  it("(@ x k) with a COMPUTED key is NOT a static field — falls through to a pure op", async () => {
    const n = await skeleton(`(@ x k)`);
    expect(n.kind).not.toBe("field");
  });

  it("cdr / cadr / rest stay PIPES, not fields (sound over-approximation)", async () => {
    // Consumers only ever pin keyword/car/index fields; cdr-family is left as a
    // pass-through pipe (the design's named boundary).
    const cdr = await skeleton(`(cdr x)`);
    expect(cdr).toEqual({ kind: "pipe", op: "cdr", child: { kind: "leaf", slot: "x" } });
    const cadr = await skeleton(`(cadr x)`);
    expect(cadr.kind).not.toBe("field");
  });
});

// ── ABSORPTION (D-v02-1) — field under field collapses to base + innermost ────
describe("lineage field — nested projection ABSORBS to base + INNERMOST step", () => {
  it("(:a (:b x)) → field{step:'b'} over leaf(x) — the outer :a is absorbed (NOT a 2-deep path)", async () => {
    // Mirrors trace.ts:351-352: a re-projection is a deeper pluck within the SAME
    // producer pin; keep the inner key as the producer port, do not compose a path.
    const n = await skeleton(`(:a (:b x))`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ field: "b" }); // INNERMOST step
    expect(n.child).toEqual({ kind: "leaf", slot: "x" }); // base — NOT a field{:a, field{:b, …}}
  });

  it("absorption is cross-syntax: (car (:b x)) and (@ (car x) :a) collapse to the inner step too", async () => {
    const carOverField = await skeleton(`(car (:b x))`);
    expect(carOverField.kind).toBe("field");
    if (carOverField.kind === "field") expect(carOverField.step).toEqual({ field: "b" });

    const fieldOverCar = await skeleton(`(@ (car x) :a)`);
    expect(fieldOverCar.kind).toBe("field");
    if (fieldOverCar.kind === "field") expect(fieldOverCar.step).toEqual({ car: true }); // innermost = car
  });

  it("triple nesting (:a (:b (:c x))) absorbs to the single innermost step :c", async () => {
    const n = await skeleton(`(:a (:b (:c x)))`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ field: "c" });
    expect(n.child).toEqual({ kind: "leaf", slot: "x" });
  });
});

// ── NEUTRALITY — fullCone of a field == fullCone of the pre-v0.2 pipe ──────────
describe("lineage field — fullCone is NEUTRAL vs the pre-change pipe classification", () => {
  it("fullCone((:foo x)) == x's cone — the teleological query is unchanged", async () => {
    const field = await skeleton(`(:foo x)`);
    // Before v0.2, `(:foo x)` classified as pipe{:foo}→leaf(x); both yield x's cone.
    expect(fullCone(field, { x: [42] })).toEqual([42]);
  });

  it("fullCone over a deeper expr is identical to the pipe form: (* v1 (:foo v2))", async () => {
    const n = await skeleton(`(* v1 (:foo v2))`);
    // (:foo v2) is a field (pipe-equivalent for the cone); the merge unions v1 + v2.
    expect(fullCone(n, { v1: [100], v2: [200] })).toEqual([100, 200]);
  });

  it("absorbed (:a (:b x)) still yields x's full cone (neutral after absorption)", async () => {
    const n = await skeleton(`(:a (:b x))`);
    expect(fullCone(n, { x: [7] })).toEqual([7]);
  });
});

// ── DEMAND-AS-PROJECTION (D-v02-2) — fieldCone prunes siblings ─────────────────
describe("lineage field — fieldCone descends the matching field, prunes the siblings", () => {
  it("demanding the SAME field follows it: fieldCone((:foo x), {field:'foo'}) == x's cone", async () => {
    const n = await skeleton(`(:foo x)`);
    expect(fieldCone(n, { x: [42] }, { field: "foo" })).toEqual([42]);
  });

  it("demanding a DIFFERENT field prunes it: fieldCone((:foo x), {field:'bar'}) == [] (sibling complement)", async () => {
    const n = await skeleton(`(:foo x)`);
    expect(fieldCone(n, { x: [42] }, { field: "bar" })).toEqual([]);
  });

  it("the demand threads THROUGH a merge: only the matching field-sibling contributes", async () => {
    // (cons (:foo a) (:bar b)) — a merge of two field projections. Demanding `foo`
    // reaches a's cone and PRUNES b (the :bar sibling); demanding `bar` is the dual.
    const n = await skeleton(`(cons (:foo a) (:bar b))`);
    expect(n.kind).toBe("merge");
    expect(fieldCone(n, { a: [1], b: [2] }, { field: "foo" })).toEqual([1]); // b pruned
    expect(fieldCone(n, { a: [1], b: [2] }, { field: "bar" })).toEqual([2]); // a pruned
    expect(fullCone(n, { a: [1], b: [2] })).toEqual([1, 2]); // teleological keeps both
  });

  it("an index demand is distinct from a field demand of the same name-shape", async () => {
    const n = await skeleton(`(vector-ref x 1)`);
    expect(fieldCone(n, { x: [9] }, { index: 1 })).toEqual([9]); // matched
    expect(fieldCone(n, { x: [9] }, { index: 2 })).toEqual([]); // wrong index — pruned
    expect(fieldCone(n, { x: [9] }, { field: "1" })).toEqual([]); // field≠index — pruned
  });
});

// ── FAN × LENS (§"The viz constraint") — field nests under the fan, no unroll ──
describe("lineage field — fan × lens composes PARAMETRICALLY (the z-axis is preserved)", () => {
  it("field-INSIDE-fan: (map (lambda (it) (:bar it)) xs) keeps the field NESTED in the fan template", async () => {
    const n = await skeleton(`(map (lambda (it) (:bar it)) xs)`);
    expect(n.kind).toBe("fan");
    if (n.kind !== "fan") return;
    expect(n.lengthPreserving).toBe(true);
    expect(n.source).toEqual({ kind: "leaf", slot: "xs" }); // the z-stack source, NOT unrolled
    // The per-element field lives in the template — the parametric [number][:bar] path.
    expect(n.template).toBeDefined();
    expect(n.template).toEqual({
      kind: "field",
      op: ":bar",
      step: { field: "bar" },
      child: { kind: "leaf", slot: "it" }, // the element binder
    });
  });

  it("field-OVER-fan wraps it: (:foo (map (lambda (it) (:bar it)) xs)) = field{:foo}→fan→template field{:bar}", async () => {
    // The single `[number][field]` wire the v02-G6 viz reads: source[number][:bar]
    // → result[number][:foo], carried as ONE parametric shape (field over fan over
    // field-in-template), never N unrolled element wires.
    const n = await skeleton(`(:foo (map (lambda (it) (:bar it)) xs))`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ field: "foo" }); // result projection
    expect(n.child.kind).toBe("fan"); // the fan axis survives under the outer field
    if (n.child.kind !== "fan") return;
    expect(n.child.source).toEqual({ kind: "leaf", slot: "xs" });
    expect(n.child.template).toEqual({
      kind: "field",
      op: ":bar",
      step: { field: "bar" },
      child: { kind: "leaf", slot: "it" },
    });
  });

  it("the v0.2 dict shape (map (lambda (it) (dict :foo (:bar it))) xs) carries the inner field nested", async () => {
    // The canonical example from the proposal: the per-element template is a dict
    // construction whose `:bar` projection of the element is a field node nested
    // inside it (NOT flattened away) — the carrier-shaping constraint.
    const n = await skeleton(`(map (lambda (it) (dict :foo (:bar it))) xs)`);
    expect(n.kind).toBe("fan");
    if (n.kind !== "fan") return;
    expect(n.template?.kind).toBe("merge");
    if (n.template?.kind !== "merge") return;
    const innerField = n.template.children.find((ch) => ch.kind === "field");
    expect(innerField).toEqual({
      kind: "field",
      op: ":bar",
      step: { field: "bar" },
      child: { kind: "leaf", slot: "it" },
    });
  });

  it("a BARE function symbol fan carries NO template — byte-identical to the pre-v0.2 fan", async () => {
    // (map infer xs) — no lambda, so no template key. This guards the additive
    // promise: existing fans (lineage-spike's (map infer xs)) are untouched.
    const n = await skeleton(`(map infer xs)`);
    expect(n.kind).toBe("fan");
    if (n.kind !== "fan") return;
    expect(n.template).toBeUndefined();
    expect(n.introduces).toBe(true); // infer mints
    // Cones unchanged from lineage-spike.
    expect(fullCone(n, { xs: [10], infer: [20] })).toEqual([10, 20]);
    expect(countCone(n, { xs: [10], infer: [20] })).toEqual([10]);
  });

  it("field-over-fan fullCone is still the source cone (the field walk descends only the focus)", async () => {
    // The outer field over the fan does not collapse the fan axis for the cone: the
    // teleological query reaches the fan's source (xs). The template is viz-only.
    const n = await skeleton(`(:foo (map (lambda (it) (:bar it)) xs))`);
    expect(fullCone(n, { xs: [10] })).toEqual([10]);
  });
});
