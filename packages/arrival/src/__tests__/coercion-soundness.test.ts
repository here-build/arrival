/**
 * G6 — carrier-coercion soundness (Wave A / W2).
 *
 * The claim under test: provenance must survive `map`/`filter`/`length`/`sort`
 * across ALL carriers (Pair / SchemeVector / SchemeJSArray / LazySeq) with no
 * SILENT box-drop. The crossing audited is the FL-interop overlay
 * (`env/fl-interop.ts`) — the genuine interop members of the inference plane,
 * where a SchemeJSArray (a non-AValue membrane wrapper) and the lazy/eager
 * carriers all meet the polymorphic `map`/`filter`/`length`/`reduce`.
 *
 * DR5 (pre-mortem): every assertion inspects `.provenance` DIRECTLY — never via
 * `equal?`. `structuralEqual` is representation-blind (equality-representation.ts):
 * it sees a value's content, NOT whether a provenance box was dropped, so it is
 * the wrong oracle for "did the box survive."
 *
 * Two strata of assertion, kept visibly separate:
 *
 *   1. SOUND — the box that a consumer (the teleological seal) genuinely needs
 *      survives the coercion. These are the G6 guarantees, including the one this
 *      wave REPAIRED (the `collectElements` SchemeVector gap).
 *
 *   2. GOLDEN(eager-parity) — the deliberate, named drops the research (Galois
 *      slicing: `length`/`sort` are the upper adjoint; the container grouping is
 *      NOT in a count's cone) and the eager engine already exhibit. The static
 *      path must MATCH these byte-for-byte (G2), so they are pinned as
 *      characterization, NOT "fixed." Each is cross-referenced to a contested
 *      ruling for the parent/V.
 */

import { describe, it, expect } from "vitest";
import { initBridge } from "../bridge.js";
import { Pair } from "../values/Pair.js";
import { SchemeVector } from "../values/SchemeVector.js";
import { SchemeString } from "../values/SchemeString.js";
import { LazySeq } from "../values/LazySeq.js";
import { SchemeJSArray } from "../membrane.js";
import { FL_INTEROP_OPS } from "../env/fl-interop.js";
import { nil } from "../values/types.js";
import { provOf } from "../values/lineage-shadow.js";

await initBridge();
const ops = FL_INTEROP_OPS as unknown as Record<string, (...a: any[]) => any>;

// ── DR5 helpers (provOf is the canonical one; never `equal?`) ─────────────────
/** A provenance-bearing scalar element. SchemeString so `unwrapLipsValue` (the
 *  asyncFLMap box-strip) treats it as a real boxed value, not an inert host num. */
const el = (s: string, p: number) => new SchemeString(s, new Set([p]));
/** Element-level provenance of a returned collection, in order — the soundness
 *  signal the seal reads (per-element grounding survives the transform). */
const elemProvs = (r: unknown): number[][] => {
  const out: number[][] = [];
  if (r instanceof Pair) {
    let n: unknown = r;
    while (n instanceof Pair) {
      out.push(provOf(n.car));
      n = n.cdr;
    }
  } else if (r instanceof SchemeVector) {
    for (const e of r.__vector__) out.push(provOf(e));
  } else if (r instanceof SchemeJSArray) {
    for (const e of r.source) out.push(provOf(e));
  } else if (Array.isArray(r)) {
    for (const e of r) out.push(provOf(e));
  }
  return out;
};
/** Awaits the FL-interop result (live ops may return a Promise). */
const force = async (r: unknown): Promise<unknown> => (r && typeof (r as any).then === "function" ? await r : r);

const idSync = (x: unknown) => x;
const keepAll = () => true;
const cmp = (a: unknown, b: unknown) => String((a as SchemeString).valueOf()).localeCompare(String((b as SchemeString).valueOf()));

const mkPair = () => new Pair(el("a", 100), new Pair(el("b", 101), nil)).withProvenance(new Set([7]));
const mkVec = () => new SchemeVector([el("a", 100), el("b", 101)], new Set([7]));
const mkArr = () => new SchemeJSArray([el("a", 100), el("b", 101)]);
const mkLazy = () => new LazySeq([el("a", 100), el("b", 101)], [], new Set([7]));

// ════════════════════════════════════════════════════════════════════════════
// STRATUM 1 — SOUND: per-element provenance survives the structure-preserving
// transforms. This is the grounding the teleological seal walks; a drop here is
// a silent hole. (Container-grouping behavior is stratum 2.)
// ════════════════════════════════════════════════════════════════════════════
describe("G6 sound — element provenance survives map/filter/sort", () => {
  it("Pair · map preserves every element's box", async () => {
    expect(elemProvs(await force(ops.map(idSync, mkPair())))).toEqual([[100], [101]]);
  });
  it("Pair · filter preserves every kept element's box", async () => {
    expect(elemProvs(await force(ops.filter(keepAll, mkPair())))).toEqual([[100], [101]]);
  });
  it("Pair · sort preserves every element's box (only reorders)", async () => {
    expect(elemProvs(await force(ops.sort(mkPair(), cmp)))).toEqual([[100], [101]]);
  });

  it("SchemeVector · filter preserves every element's box", async () => {
    expect(elemProvs(await force(ops.filter(keepAll, mkVec())))).toEqual([[100], [101]]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STRATUM 1 — SOUND (REPAIRED THIS WAVE): the `collectElements` SchemeVector gap.
//
// `collectElements` (shared by `length` and the `lazy-seq` constructor) had no
// SchemeVector branch — a vector matched none of {Pair-spine, SchemeJSArray, raw
// array} and silently collected []. So `(length vec)` counted 0 and `(lazy-seq
// vec)` held an empty plan, dropping every element's provenance with NO error.
// Its twin `collapseProvenance` (provenance-collapse.ts) already walked
// `__vector__`; the two near-twin deep-walkers disagreed (pre-mortem DR6). Fixed
// by adding the symmetric SchemeVector branch.
// ════════════════════════════════════════════════════════════════════════════
describe("G6 sound — collectElements over a SchemeVector (repaired)", () => {
  it("length(vector) counts every element (not 0) and carries their unioned provenance", async () => {
    const r = await force(ops.length(mkVec()));
    expect(Number((r as { valueOf(): unknown }).valueOf())).toBe(2);
    // Element grounding (100,101) rides onto the count — the teleological-seal
    // need fl-interop.length documents ("a count the seal can't sign is the hole").
    expect(provOf(r)).toEqual([100, 101]);
  });

  it("lazy-seq(vector) materializes every element (not an empty plan)", async () => {
    const ls = ops["lazy-seq"](mkVec()) as LazySeq;
    expect(ls.source.length).toBe(2);
    const it = (await ls.refine({ kind: "iterate" })) as { items: readonly unknown[]; provenance: ReadonlySet<number> };
    expect(it.items.length).toBe(2);
    expect(elemProvs([...it.items])).toEqual([[100], [101]]);
  });

  it("length(SchemeJSArray) carries element provenance (the membrane-wrapper carrier)", async () => {
    const r = await force(ops.length(mkArr()));
    expect(Number((r as { valueOf(): unknown }).valueOf())).toBe(2);
    expect(provOf(r)).toEqual([100, 101]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STRATUM 1 — SOUND: LazySeq is the carrier where the cone IS the provenance.
// A pure-map length never touches the elements (their boxes stay OUT of the
// count's cone — correct minimality); a length-changing filter pulls them in.
// ════════════════════════════════════════════════════════════════════════════
describe("G6 sound — LazySeq length cone (demand == provenance)", () => {
  it("length(lazy map) keeps only the grouping fact — elements stay out of the cone", async () => {
    const planned = ops.map(idSync, mkLazy()); // extends the plan, runs nothing
    const r = await force(ops.length(planned));
    expect(Number((r as { valueOf(): unknown }).valueOf())).toBe(2);
    expect(provOf(r)).toEqual([7]); // grouping box only — map preserves length
  });
  it("length(lazy filter) pulls every inspected element into the cone", async () => {
    const planned = ops.filter(keepAll, mkLazy()); // length-changing → must run
    const r = await force(ops.length(planned));
    expect(provOf(r)).toEqual([7, 100, 101]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STRATUM 2 — GOLDEN (eager-parity): the deliberate drops. Characterized, NOT
// fixed — the static path must reproduce them (G2). Each maps to a contested
// ruling returned to the parent/V. If a future wave ELEVATES one to a fix, the
// assertion here is the canary that the eager behavior changed.
// ════════════════════════════════════════════════════════════════════════════
describe("G6 golden(eager-parity) — container-grouping drops the research blesses", () => {
  // Galois-slicing upper adjoint: a count/sort does not depend on the container
  // grouping box, so the box is not carried. Element boxes (stratum 1) survive.
  it("Pair · length drops the container box, carries the ELEMENTS' provenance (the seal need)", async () => {
    const r = await force(ops.length(mkPair()));
    expect(provOf(r)).toEqual([100, 101]); // NOT [7] — container grouping is outside a count's cone
  });

  it("Pair · sort drops the container box [CONTESTED: overlay-sort makes no collapseProvenance call]", async () => {
    // Eager parity: the ONLY `sort` is the fl-interop overlay; it rebuilds the
    // spine via `Pair.fromArray` (the shared spine-rebuild drop) and makes NO
    // collapseProvenance call. Element boxes survive (stratum 1); the container
    // box does not. Pinned as parity; flagged for the parent.
    expect(provOf(await force(ops.sort(mkPair(), cmp)))).toEqual([]);
  });

  it("Pair · map / filter drop the container box (spine rebuilt; element boxes survive)", async () => {
    expect(provOf(await force(ops.map(idSync, mkPair())))).toEqual([]);
    expect(provOf(await force(ops.filter(keepAll, mkPair())))).toEqual([]);
  });

  it("SchemeVector · map STRIPS element boxes [CONTESTED: asyncFLMap unwrapLipsValue — DR4]", async () => {
    // The overlay `map` routes a SchemeVector (it has fantasy-land/map) through
    // `asyncFLMap`, whose `unwrapLipsValue` strips a SchemeString → raw JS string,
    // DROPPING its provenance. This is the DR4 box-strip; it is NOT eager parity
    // with the proper `vector-map` (stdlib, which preserves element boxes), so it
    // is a candidate G6 fix — but touching it risks the FL-interop contract with
    // foreign FL structures (they may require raw values). Pinned as the current
    // reality + escalated. (`filter` over a vector uses fantasy-land/filter, no
    // unwrap, so it is sound — see stratum 1.)
    const r = await force(ops.map(idSync, mkVec()));
    expect(elemProvs(r)).toEqual([[], []]); // boxes dropped — the bug, captured
  });
});

describe("G6 golden(eager-parity) — wrong-carrier silent nil [CONTESTED: DR4]", () => {
  // The overlay's positional accessors + sort handle a Pair-spine OR a JS array,
  // but NOT a SchemeVector — a vector matches neither, so they silently yield
  // nil/empty (worse-than-throw, per DR4). A vector SHOULD use vector-ref /
  // vector-sort; whether the right fix is to teach these the SchemeVector carrier
  // or to throw (errors-as-doors) is a design call, not a silent box-fix.
  it("first(vector) silently returns nil (no SchemeVector branch in the accessor)", () => {
    expect(ops.first(mkVec())).toBe(nil);
  });
  it("sort(vector) silently returns nil (no SchemeVector branch in sort)", () => {
    expect(ops.sort(mkVec(), cmp)).toBe(nil);
  });

  // The overlay exists FOR SchemeJSArray-aware car/cdr, yet its map/filter/reduce
  // do NOT handle a SchemeJSArray — they fall through to the LIPS builtins, which
  // typecheck pair|nil and THROW. (Length/first/sort over a SchemeJSArray work.)
  it("map(SchemeJSArray) THROWS — the overlay map has no SchemeJSArray branch [CONTESTED]", () => {
    expect(() => ops.map(idSync, mkArr())).toThrow(/pair or nil/i);
  });
});
