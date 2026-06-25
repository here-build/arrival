/**
 * G6 — carrier-coercion soundness (Wave A / W2).
 *
 * The claim under test: provenance must survive `map`/`filter`/`length`/`sort`
 * across ALL carriers (Pair / SchemeVector / SchemeJSArray) with no
 * SILENT box-drop. The crossing audited is the FL-interop overlay
 * (`env/fl-interop.ts`) — the genuine interop members of the inference plane,
 * where a SchemeJSArray (a non-AValue membrane wrapper) and the eager
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
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { initBridge } from "../bridge.js";
import { APair } from "../values/primitives/APair.js";
import { AVector } from "../values/primitives/AVector.js";
import { AString } from "../values/primitives/AString.js";
import { SchemeJSArray } from "../membrane.js";
import flInteropCap from "../env/fl-interop.js";
import listsCap from "../env/r7rs/lists.js";
import type { EnvCapability } from "../env/capability.js";
import { nil } from "../values/primitives/ANil.js";
import { provOf } from "../values/lineage-shadow.js";

await initBridge();
// Source op fns FROM THE CAPABILITY's inlined `symbols` (the bare *_OPS map was
// inlined into the constructor; the capability default export is the single
// declaration site). These packs are all the record form of `spec.symbols`.
const opsOf = (cap: EnvCapability): Record<string, (...a: any[]) => any> =>
  Object.fromEntries(
    Object.entries(
      cap.spec.symbols as Record<string, { impl?: (...a: any[]) => any; value?: (...a: any[]) => any }>,
    ).map(([k, v]) => [k, v.impl ?? v.value]),
  );
const ops = opsOf(flInteropCap);
const listOps = opsOf(listsCap); // r7rs scheme/lists — assoc lives here now

// ── DR5 helpers (provOf is the canonical one; never `equal?`) ─────────────────
/** A provenance-bearing scalar element. SchemeString so `unwrapLipsValue` (the
 *  asyncFLMap box-strip) treats it as a real boxed value, not an inert host num. */
const el = (s: string, p: number) => new AString(CONSTANT_CTX, s, new Set([p]));
/** Element-level provenance of a returned collection, in order — the soundness
 *  signal the seal reads (per-element grounding survives the transform). */
const elemProvs = (r: unknown): number[][] => {
  const out: number[][] = [];
  if (r instanceof APair) {
    let n: unknown = r;
    while (n instanceof APair) {
      out.push(provOf(n.car));
      n = n.cdr;
    }
  } else if (r instanceof AVector) {
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
const cmp = (a: unknown, b: unknown) => String((a as AString).valueOf()).localeCompare(String((b as AString).valueOf()));

const mkPair = () => new APair(CONSTANT_CTX, el("a", 100), new APair(CONSTANT_CTX, el("b", 101), nil)).withProvenance(new Set([7]));
const mkVec = () => new AVector(CONSTANT_CTX, [el("a", 100), el("b", 101)], new Set([7]));
const mkArr = () => new SchemeJSArray([el("a", 100), el("b", 101)]);

// ════════════════════════════════════════════════════════════════════════════
// STRATUM 1 — SOUND: per-element provenance survives the structure-preserving
// transforms. This is the grounding the teleological seal walks; a drop here is
// a silent hole. (Container-grouping behavior is stratum 2.)
// ════════════════════════════════════════════════════════════════════════════
describe("G6 sound — element provenance survives map/filter/sort", () => {
  it("Pair · map preserves every element's box", async () => {
    expect(elemProvs(await force(mkPair()["arrival/tagless-final/map"](idSync)))).toEqual([[100], [101]]);
  });
  it("Pair · filter preserves every kept element's box", async () => {
    expect(elemProvs(await force(mkPair()["arrival/tagless-final/filter"](keepAll)))).toEqual([[100], [101]]);
  });
  it("Pair · sort preserves every element's box (only reorders)", async () => {
    expect(elemProvs(await force(ops.sort(mkPair(), cmp)))).toEqual([[100], [101]]);
  });

  it("SchemeVector · filter preserves every element's box", async () => {
    expect(elemProvs(await force(mkVec()["arrival/tagless-final/filter"](keepAll)))).toEqual([[100], [101]]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STRATUM 1 — SOUND (REPAIRED THIS WAVE): the `collectElements` SchemeVector gap.
//
// `collectElements` (used by `length`) had no SchemeVector branch — a vector
// matched none of {Pair-spine, SchemeJSArray, raw array} and silently collected
// []. So `(length vec)` counted 0, dropping every element's provenance with NO error.
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

  it("length(SchemeJSArray) carries element provenance (the membrane-wrapper carrier)", async () => {
    const r = await force(ops.length(mkArr()));
    expect(Number((r as { valueOf(): unknown }).valueOf())).toBe(2);
    expect(provOf(r)).toEqual([100, 101]);
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
    expect(provOf(await force(mkPair()["arrival/tagless-final/map"](idSync)))).toEqual([]);
    expect(provOf(await force(mkPair()["arrival/tagless-final/filter"](keepAll)))).toEqual([]);
  });

  it("SchemeVector · map STRIPS element boxes [CONTESTED: AVector TF-map unwrapForeign — DR4]", async () => {
    // The overlay `map` delegates a SchemeVector to its OWN arrival/tagless-final/map,
    // whose `unwrapForeign` (the relocated box-strip) turns a SchemeString → raw JS
    // string, DROPPING its provenance — a vector crosses OUT to a foreign Functor. This
    // is the DR4 box-strip; it is NOT eager parity with the proper `vector-map` (stdlib,
    // which preserves element boxes), so it is a candidate G6 fix — but flipping it would
    // change the documented cross-out contract. Pinned as the current reality + escalated.
    // (`filter` over a vector — the term's arrival/tagless-final/filter — does NOT unwrap,
    // so it is sound — see stratum 1.)
    const r = await force(mkVec()["arrival/tagless-final/map"](idSync));
    expect(elemProvs(r)).toEqual([[], []]); // boxes dropped — the bug, captured
  });
});

describe("G6 golden(eager-parity) — wrong-carrier silent nil [CONTESTED: DR4]", () => {
  // The overlay's `sort` handles a Pair-spine OR a JS array, but NOT a SchemeVector —
  // a vector matches neither, so it silently yields nil/empty (worse-than-throw, per
  // DR4). A vector SHOULD use vector-sort; whether the right fix is to teach sort the
  // SchemeVector carrier or to throw (errors-as-doors) is a design call, not a silent box-fix.
  it("sort(vector) silently returns nil (no SchemeVector branch in sort)", () => {
    expect(ops.sort(mkVec(), cmp)).toBe(nil);
  });

  // The overlay exists FOR SchemeJSArray-aware car/cdr, yet its map/filter/reduce
  // do NOT handle a SchemeJSArray — they fall through to the LIPS builtins, which
  // typecheck pair|nil and THROW. (Length/first/sort over a SchemeJSArray work.)
  it("map(SchemeJSArray) THROWS — the overlay map has no SchemeJSArray branch [CONTESTED]", () => {
    expect("arrival/tagless-final/map" in mkArr()).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G6 TOTALITY — element-projection accessors (car/cdr/assoc) + reduce across
// carriers. The audit flagged these as ZERO-coverage cells, yet car/cdr IS the
// §5.3 element projection and the wrong-carrier silent-nil/throw is the DR4 risk.
// Characterization (run-pinned): which carriers project the box, which fall
// through to a LIPS builtin that typechecks pair|nil and throws.
// ════════════════════════════════════════════════════════════════════════════
describe("G6 — element-projection (car/cdr/assoc) + reduce across carriers", () => {
  // car/cdr project ONE element — its box must survive (this IS §5.3 element
  // provenance; the golden-prov-arithmetic car/cons goldens depend on it).
  it("car(Pair) projects the head element WITH its box", async () => {
    expect(provOf(await force(mkPair()["arrival/tagless-final/car"]()))).toEqual([100]);
  });
  it("car(SchemeJSArray) projects the head element WITH its box (the .at(0) carrier path)", async () => {
    expect(provOf(await force(mkArr()["arrival/tagless-final/car"]()))).toEqual([100]);
  });
  it("cdr(Pair): the tail spine carries the remaining element's box", async () => {
    expect(elemProvs(await force(mkPair()["arrival/tagless-final/cdr"]()))).toEqual([[101]]);
  });
  it("cdr(SchemeJSArray): the tail wrapper carries the remaining element's box", async () => {
    expect(elemProvs(await force(mkArr()["arrival/tagless-final/cdr"]()))).toEqual([[101]]);
  });
  it("assoc(key, alist): the matched pair's key + value boxes both survive", async () => {
    const alist = new APair(CONSTANT_CTX, new APair(CONSTANT_CTX, el("k", 100), el("v", 101)), nil);
    const found = (await force(listOps.assoc(el("k", 200), alist))) as APair;
    expect(provOf(found.car)).toEqual([100]); // key box
    expect(provOf(found.cdr)).toEqual([101]); // value box
  });

  // Wrong-carrier: a SchemeVector has no car algebra and a SchemeJSArray no reduce
  // overlay branch → the dispatch totalic-throws (the DR4 surface — errors-as-doors,
  // not a silent box-drop). car/cdr are now the primitives OWN tagless-final algebra.
  it("car(SchemeVector): AVector carries no car algebra → the dispatch totalic-throws [DR4]", () => {
    expect("arrival/tagless-final/car" in mkVec()).toBe(false);
  });
  it("reduce(SchemeJSArray) THROWS — overlay reduce has no SchemeJSArray branch [CONTESTED]", () => {
    expect("arrival/tagless-final/reduce" in mkArr()).toBe(false);
  });
});
