/**
 * G6 — carrier-coercion soundness (Wave A / W2).
 *
 * The claim under test: provenance must survive `map`/`filter`/`length`/`sort`
 * across ALL carriers (Pair / SchemeVector / AJSArray) with no
 * SILENT box-drop. The crossing audited is the FL-interop overlay
 * (`env/fl-interop.ts`) — the genuine interop members of the inference plane,
 * where a AJSArray (a non-AValue membrane wrapper) and the eager
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
import { CONSTANT_CTX, makeRunContext } from "../values/primitives/RunContext.js";
import { PortabilityError } from "../errors.js";
import { initBridge } from "../bridge.js";
import { APair } from "../values/primitives/APair.js";
import { AVector } from "../values/primitives/AVector.js";
import { AString } from "../values/primitives/AString.js";
import { AJSArray } from "../values/primitives/AJSArray.js";
import listsCap from "../env/r7rs/lists.js";
import vectorsCap from "../env/r7rs/vectors.js";
import { svector } from "../common/scheme-zod.js";
import type { EnvCapability } from "../common/capability.js";
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
    )
      .map(([k, v]) => [k, v.impl ?? v.value] as const)
      // A def may carry neither `impl` nor `value` (a baked bare-`Fn` def) — that's
      // not a callable op for this test's purposes, so drop it rather than admit an
      // `undefined` into the op map (honest narrowing, not a cast over the union).
      .filter((e): e is [string, (...a: any[]) => any] => e[1] !== undefined),
  );
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
  } else if (r instanceof AJSArray) {
    for (const e of r.source) out.push(provOf(e));
  } else if (Array.isArray(r)) {
    for (const e of r) out.push(provOf(e));
  }
  return out;
};
/** Awaits the FL-interop result (live ops may return a Promise). */
const force = async (r: unknown): Promise<unknown> => (r && typeof (r as any).then === "function" ? await r : r);

const idSync = <T>(x: T): T => x;
const keepAll = () => true;
const cmp = (a: unknown, b: unknown) => String((a as AString).valueOf()).localeCompare(String((b as AString).valueOf()));

const mkPair = () => new APair(CONSTANT_CTX, el("a", 100), new APair(CONSTANT_CTX, el("b", 101), nil)).withProvenance(new Set([7]));
const mkVec = () => new AVector(CONSTANT_CTX, [el("a", 100), el("b", 101)], new Set([7]));
const mkArr = () => new AJSArray(CONSTANT_CTX, [el("a", 100), el("b", 101)]);

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
    // sort dissolved onto the term: call it directly (the fl-interop sort is now a
    // symbol.sequence dispatcher with no .impl). The term takes the optional comparator.
    expect(elemProvs(await force(mkPair()["arrival/tagless-final/sort"](cmp)))).toEqual([[100], [101]]);
  });

  it("SchemeVector · filter preserves every element's box", async () => {
    expect(elemProvs(await force(mkVec()["arrival/tagless-final/filter"](keepAll)))).toEqual([[100], [101]]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STRATUM 1 — SOUND (REPAIRED THIS WAVE): the `collectElements` SchemeVector gap.
//
// `collectElements` (used by `length`) had no SchemeVector branch — a vector
// matched none of {Pair-spine, AJSArray, raw array} and silently collected
// []. So `(length vec)` counted 0, dropping every element's provenance with NO error.
// Its twin `collapseProvenance` (provenance-collapse.ts) already walked
// `__vector__`; the two near-twin deep-walkers disagreed (pre-mortem DR6). Fixed
// by adding the symmetric SchemeVector branch.
// ════════════════════════════════════════════════════════════════════════════
describe("G6 sound — collectElements over a SchemeVector (repaired)", () => {
  it("length(vector) counts every element (not 0) and carries their unioned provenance", async () => {
    const r = await force(listOps.length(mkVec()));
    expect(Number((r as { valueOf(): unknown }).valueOf())).toBe(2);
    // Element grounding (100,101) rides onto the count — the teleological-seal
    // need the term length documents ("a count the seal can't sign is the hole").
    expect(provOf(r)).toEqual([100, 101]);
  });

  it("length(AJSArray) carries element provenance (the membrane-wrapper carrier)", async () => {
    const r = await force(listOps.length(mkArr()));
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
    const r = await force(listOps.length(mkPair()));
    expect(provOf(r)).toEqual([100, 101]); // NOT [7] — container grouping is outside a count's cone
  });

  it("Pair · sort drops the container box (spine rebuilt; element boxes survive)", async () => {
    // APair's arrival/tagless-final/sort re-cons the spine via `Pair.fromArray(_, false)`
    // (the shared spine-rebuild drop) and makes NO collapseProvenance call. Element boxes
    // survive (stratum 1); the container box does not — identical to map/filter.
    expect(provOf(await force(mkPair()["arrival/tagless-final/sort"](cmp)))).toEqual([]);
  });

  it("Pair · map / filter drop the container box (spine rebuilt; element boxes survive)", async () => {
    expect(provOf(await force(mkPair()["arrival/tagless-final/map"](idSync)))).toEqual([]);
    expect(provOf(await force(mkPair()["arrival/tagless-final/filter"](keepAll)))).toEqual([]);
  });

  it("SchemeVector · map crosses out to the AUTO-WRAPPING AJSArray (raw inside, boxes on access) [RESOLVED: DR4]", async () => {
    // RESOLVED (was CONTESTED): a vector's `map` still crosses OUT to a foreign Functor — its
    // `unwrapForeign` strips each SchemeString → raw JS string, DROPPING that raw value's
    // provenance — but the stripped array is now re-presented as the "impersonator" AJSArray:
    // the raw values live in `.source` (still reachable for a genuinely-foreign Functor / the
    // `[TO_JS]`/`toJs` egress), while Scheme-level access boxes each element BACK ON DEMAND.
    // This reconciles the DR4 cross-out with the Functor identity law (`map(id) ≡ id`): the raw
    // is exposed for interop, yet `(vector-ref (map id v) i)` yields a box again, so the mapped
    // structure is element-wise equal to the source (scheme-vector-algebra.test.ts pins the law).
    const r = await force(mkVec()["arrival/tagless-final/map"](idSync));

    // (a) it crossed out to the membrane's AJSArray, NOT a fresh AVector — the impersonator.
    expect(r).toBeInstanceOf(AJSArray);

    // (b) DR4 cross-out: the RAW source holds bare JS strings (foreign-reachable), provenance
    // stripped at the raw layer (`elemProvs` walks `.source` → the raw values carry no box).
    const arr = r as AJSArray;
    expect(arr.source).toEqual(["a", "b"]);
    expect(arr.source.every((x) => typeof x === "string")).toBe(true);
    expect(elemProvs(r)).toEqual([[], []]); // raw layer carries no provenance — the cross-out

    // (c) the raw-for-foreign egress still holds: `toJs`/`[TO_JS]` cross back out as the raw array.
    expect(arr.toJs()).toEqual(["a", "b"]);

    // (d) the Functor side: Scheme-level access (`__vector__`, dispatched by vector-ref/->list)
    // BOXES each element back — a raw "a" re-boxes to an AString, so the mapped structure answers
    // the value algebra as a vector of boxes (the law-satisfying half of the dual nature).
    const accessed = arr.__vector__;
    expect(accessed.every((e) => e instanceof AString)).toBe(true);
    expect(accessed.map((e) => String((e as AString).valueOf()))).toEqual(["a", "b"]);
  });
});

describe("G6 sound — sort over a SchemeVector (DR4 fix: container-preserving, box-preserving)", () => {
  // FLIPPED (DR4 fix): the old overlay's `sort` had no SchemeVector branch, so a vector
  // silently fell through to nil — worse-than-throw. Now sort is dissolved onto the term:
  // AVector's arrival/tagless-final/sort returns a FRESH sorted vector, PRESERVING every
  // element's box (no unwrapForeign — this is the box-preserving reorder, not the cross-out
  // map). Container-preserving (vector→vector) by the term returning its own shape.
  it("sort(vector) returns a sorted VECTOR (boxes preserved, container preserved)", async () => {
    const r = await force(mkVec()["arrival/tagless-final/sort"](cmp));
    expect(r).toBeInstanceOf(AVector);
    expect(elemProvs(r)).toEqual([[100], [101]]); // element boxes survive the reorder
  });
  it("sort(vector) actually REORDERS (not a passthrough): reversed input comes back sorted", async () => {
    const reversed = new AVector(CONSTANT_CTX, [el("b", 101), el("a", 100)], new Set([7]));
    const r = (await force(reversed["arrival/tagless-final/sort"](cmp))) as AVector;
    expect(r.__vector__.map((e) => String((e as AString).valueOf()))).toEqual(["a", "b"]);
    expect(elemProvs(r)).toEqual([[100], [101]]); // boxes ride along through the reorder
  });

  // RESOLVED (was CONTESTED): a borrowed JS array is now a VECTOR — it answers the
  // sequence algebra by DELEGATING to a lazily-materialized vector (AJSArray.ts),
  // so `(map f borrowed)` works uniformly with `(map f #(...))`. This is the membrane's
  // Rosetta promise: iterate the same for real vectors and borrowed JS arrays. The
  // delegated `map` is the cross-out Functor, so the result is the AUTO-WRAPPING AJSArray
  // (raw inside, boxes on access) — identical to `map` over a native vector above.
  it("map(AJSArray) delegates to the cross-out Functor — a borrowed array answers map [RESOLVED]", async () => {
    expect("arrival/tagless-final/map" in mkArr()).toBe(true);
    const r = await force(mkArr()["arrival/tagless-final/map"](idSync, CONSTANT_CTX));
    expect(r).toBeInstanceOf(AJSArray); // the cross-out impersonator (raw inside, boxes on access)
    expect((r as AJSArray).length).toBe(2);
    // Scheme-level access boxes the stripped elements back (the Functor half).
    expect((r as AJSArray).__vector__.every((e) => e instanceof AString)).toBe(true);
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
  it("car(AJSArray): loose projects index 0 WITH its box; strict throws (a vector is not a pair)", async () => {
    expect("arrival/tagless-final/car" in mkArr()).toBe(true);
    expect(provOf(await force(mkArr()["arrival/tagless-final/car"](CONSTANT_CTX)))).toEqual([100]);
    expect(() => mkArr()["arrival/tagless-final/car"](makeRunContext({ strict: true }))).toThrow(PortabilityError);
  });
  it("cdr(Pair): the tail spine carries the remaining element's box", async () => {
    expect(elemProvs(await force(mkPair()["arrival/tagless-final/cdr"]()))).toEqual([[101]]);
  });
  it("cdr(AJSArray): loose returns the rest as a vector (boxes preserved); strict throws", async () => {
    expect("arrival/tagless-final/cdr" in mkArr()).toBe(true);
    expect(elemProvs(await force(mkArr()["arrival/tagless-final/cdr"](CONSTANT_CTX)))).toEqual([[101]]);
    expect(() => mkArr()["arrival/tagless-final/cdr"](makeRunContext({ strict: true }))).toThrow(PortabilityError);
  });
  it("assoc(key, alist): the matched pair's key + value boxes both survive", async () => {
    const alist = new APair(CONSTANT_CTX, new APair(CONSTANT_CTX, el("k", 100), el("v", 101)), nil);
    const found = (await force(listOps.assoc(el("k", 200), alist))) as APair;
    expect(provOf(found.car)).toEqual([100]); // key box
    expect(provOf(found.cdr)).toEqual([101]); // value box
  });

  // A SchemeVector (and a borrowed AJSArray) DOES answer car/cdr now — but as a TOLERANT-LOOSE
  // reading (car → index 0 WITH its box, cdr → a vector slice). In STRICT mode the gate fires
  // (a vector is not a pair → vector-ref) — the DR4 errors-as-doors surface, now mode-gated.
  it("car(SchemeVector): loose projects index 0 WITH its box; strict throws [DR4 — not a pair]", () => {
    expect("arrival/tagless-final/car" in mkVec()).toBe(true);
    expect(provOf(mkVec()["arrival/tagless-final/car"](CONSTANT_CTX))).toEqual([100]);
    expect(() => mkVec()["arrival/tagless-final/car"](makeRunContext({ strict: true }))).toThrow(PortabilityError);
  });
  // RESOLVED (was CONTESTED): reduce delegates to the materialized vector, like map.
  it("reduce(AJSArray) folds the borrowed elements via a vector [RESOLVED]", async () => {
    expect("arrival/tagless-final/reduce" in mkArr()).toBe(true);
    const n = await force(mkArr()["arrival/tagless-final/reduce"]((_e, acc: number) => acc + 1, 0, CONSTANT_CTX));
    expect(n).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// VECTOR PROTOCOL via dispatch — `vector?` (symbol.taglessGuard) and `vector-ref`
// ask the operand's OWN arrival/tagless-final/{vector?,vector-ref} instead of the
// builtin reaching around the box with `instanceof AVector`. Both a real
// SchemeVector and a borrowed AJSArray answer; a non-vector gracefully #f (vector?)
// or throws (vector-ref). This is the Family-2 "reached around the box" dissolution.
// ════════════════════════════════════════════════════════════════════════════
const vectorSymbols = vectorsCap.spec.symbols as Record<
  string,
  { run?: (...a: unknown[]) => unknown; impl?: (...a: unknown[]) => unknown }
>;
describe("vector? / vector-ref dispatch via the tagless protocol (no instanceof reach-around)", () => {
  it("vector? (taglessGuard): a SchemeVector and a borrowed AJSArray both answer #t", async () => {
    expect(await vectorSymbols["vector?"].run!(mkVec())).toBe(true);
    expect(await vectorSymbols["vector?"].run!(mkArr())).toBe(true);
  });
  it("vector? (taglessGuard): a non-vector declares no method → graceful #f, NOT a throw", async () => {
    expect(await vectorSymbols["vector?"].run!(mkPair())).toBe(false);
    expect(await vectorSymbols["vector?"].run!(el("x", 1))).toBe(false);
  });
  it("vector-ref dispatches to the operand's method — borrowed array boxes element k lazily", () => {
    expect(provOf(vectorSymbols["vector-ref"].impl!(mkArr(), 1))).toEqual([101]);
    expect(provOf(vectorSymbols["vector-ref"].impl!(mkVec(), 0))).toEqual([100]);
  });
  it("vector-ref on a non-vector throws (the operation form — unlike vector?'s #f)", () => {
    expect(() => vectorSymbols["vector-ref"].impl!(mkPair(), 0)).toThrow(/not a vector/i);
  });
  it("the whole vector family works on a borrowed array via asVector's protocol dispatch", () => {
    expect(vectorSymbols["vector-length"].impl!(mkArr())).toBe(2);
    expect(elemProvs(vectorSymbols["vector->list"].impl!(mkArr()))).toEqual([[100], [101]]);
    expect(vectorSymbols["vector-copy"].impl!(mkArr())).toBeInstanceOf(AVector);
  });
  it("z.svector accepts a borrowed AJSArray (a vector by PROTOCOL, not class)", () => {
    expect(svector.safeParse(mkArr()).success).toBe(true);
    expect(svector.safeParse(mkVec()).success).toBe(true);
    expect(svector.safeParse(mkPair()).success).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STRICT-MODE DIVERGENCE via the tagless methods — because each term method gets
// the run's RunContext, a loose tolerance gates itself: generic map/filter/reduce
// are R7RS/SRFI-1 LIST ops, so on a vector they work in LOOSE mode but throw a
// PortabilityError in STRICT (the R7RS-portability control). sort is NOT gated
// (SRFI-132 accepts vectors). Generalizes ANil's car/cdr nil-tolerance.
// ════════════════════════════════════════════════════════════════════════════
describe("strict mode gates generic list-ops on a vector (loose tolerates, strict explains)", () => {
  const strict = makeRunContext({ strict: true });
  it("map(vector): loose works; strict throws PortabilityError pointing at vector-map", async () => {
    // loose tolerates: the cross-out Functor returns the auto-wrapping AJSArray (raw inside,
    // boxes on access) — getting a value back at all is the "loose works" signal.
    expect(await force(mkVec()["arrival/tagless-final/map"](idSync, CONSTANT_CTX))).toBeInstanceOf(AJSArray);
    // map is sync up to the gate → it throws synchronously, not a rejected promise
    expect(() => mkVec()["arrival/tagless-final/map"](idSync, strict)).toThrow(PortabilityError);
    expect(() => mkVec()["arrival/tagless-final/map"](idSync, strict)).toThrow(/vector-map/);
  });
  it("filter/reduce(vector): strict rejects them (SRFI-1 list-ops)", async () => {
    await expect(mkVec()["arrival/tagless-final/filter"](keepAll, strict)).rejects.toThrow(PortabilityError);
    await expect(mkVec()["arrival/tagless-final/reduce"]((_e: unknown, a: number) => a, 0, strict)).rejects.toThrow(
      PortabilityError,
    );
  });
  it("sort(vector) is NOT gated — SRFI-132 accepts vectors", () => {
    expect(mkVec()["arrival/tagless-final/sort"](cmp, strict)).toBeInstanceOf(AVector);
  });
  it("a borrowed AJSArray inherits the gate via delegation (strict map throws)", () => {
    expect(() => mkArr()["arrival/tagless-final/map"](idSync, strict)).toThrow(PortabilityError);
  });
});
