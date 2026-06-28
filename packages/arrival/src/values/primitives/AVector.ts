/**
 * Boxes a raw JS array into the AValue kernel so it carries provenance and
 * hosts Fantasy Land algebra instances. Modeled on SchemeString / SchemeBytevector.
 * Vectors are MUTABLE (vector-set!/fill!/copy!) — the payload stays writable.
 *
 * THE DISAMBIGUATION (boxing plan §1): a raw JS `Array` is heavily overloaded
 * here — the evaluateArgs args carrier, Values, HalfBaked, syntax-rules ellipsis
 * machinery, and JS-array-as-list at the membrane are ALL raw arrays and are NOT
 * vectors. Only vector literals / make-vector / vector builtins mint SchemeVector.
 * Being its own class leaves the `Array.isArray` sites unaffected — NEVER widen
 * them to accept it.
 *
 * Boxing track: docs/plan-2026-06-10-boxing-track.md (S5).
 *
 * Lineage: R7RS-small §6.8 vectors; the Setoid/Semigroup/Functor/Filterable/
 * Foldable instances are Fantasy Land (fantasyland/fantasy-land).
 */
import { CLASS } from "../../well-known-symbols.js";
import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import { chargeHeap } from "../../heap-budget.js";
import { is_false, is_nil, is_promise } from "../../eval/guards.js";
import { promise_all } from "../../utils/promises.js";
import { AValue, EMPTY_PROVENANCE, unionProvenance } from "./AValue.js";
import { fromJs } from "./boxing.js";
import { markInteropBoundary } from "../../interop-access.js";
import { strictGate } from "../../portability.js";
import { structuralEqual, type SeenMap } from "../structural-equal.js";
import type { SchemeValue } from "../types.js";
// deriveSortCompare lives on the op-helpers Ord leaf (alongside isOrd/ORD_REL). op-helpers
// imports AVector back, but both directions are referenced ONLY inside function bodies
// (op-helpers' asVector; this term's sort), so the cycle never bites at module-eval.
import { deriveSortCompare } from "../op-helpers.js";

// The membrane's TO_JS protocol key, resolved from the global symbol registry
// (same rationale as SchemeBytevector.ts — avoids a membrane→SchemeVector class-def-time
// cycle since [TO_JS]() is a computed key).
const TO_JS = Symbol.for("scheme.toJS");

export class AVector extends AValue {
  static [CLASS] = "vector";
  readonly kind = "vector" as const;

  /** Mutable raw payload — vector-set!/fill!/copy! write through this. */
  __vector__: SchemeValue[];

  /** R7RS: a #(...) literal is immutable. The Parser freezes literals; the
   *  vector mutators reject a frozen target. Constructed vectors stay mutable. */
  frozen = false;

  constructor(ctx: RunContext, items: SchemeValue[], provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(ctx, provenance);
    this.__vector__ = items;
  }

  /** Mark immutable (a literal). Idempotent. */
  freeze(): void {
    this.frozen = true;
  }

  static isVector(x: unknown): x is AVector {
    return x instanceof AVector;
  }

  get length(): number {
    return this.__vector__.length;
  }

  ref(i: number): SchemeValue {
    return this.__vector__[i];
  }

  copy(start = 0, end = this.__vector__.length): AVector {
    return new AVector(this.ctx, this.__vector__.slice(start, end));
  }

  // Membrane unwrap (TO_JS protocol): a boxed vector crosses to JS as its raw
  // array (elements convert lazily, as with AJSArray).
  [TO_JS](): SchemeValue[] {
    return this.__vector__;
  }

  toJs(): SchemeValue[] {
    return this.__vector__;
  }

  valueOf(): SchemeValue[] {
    return this.__vector__;
  }

  withProvenance(p: ReadonlySet<number>): AVector {
    const v = new AVector(this.ctx, this.__vector__, p);
    // The copy shares the payload by reference, so a frozen literal stays frozen
    // (else re-stamping a literal's provenance would yield a mutable alias of it).
    if (this.frozen) v.freeze();
    return v;
  }

  // Setoid (Fantasy Land) — structural element-wise equality, threading the harness's
  // shared `seen`. structuralEqual records (this, other) BEFORE dispatching here, so a
  // MUTUALLY-CYCLIC vector pair (a↔b vs c↔d) re-encounters the pair in the harness and
  // short-circuits instead of recursing forever — fixing the fresh-seen-per-call
  // stack-blow this method used to risk once the harness's inline-Vector special-case
  // was removed (B2). Elements recurse through structuralEqual threading the SAME map
  // (handles nested AValues/Pairs/vectors). Non-SchemeVector → false.
  ["arrival/tagless-final/equals"](other: unknown, seen?: SeenMap): boolean {
    if (!(other instanceof AVector)) return false;
    const a = this.__vector__;
    const b = other.__vector__;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!structuralEqual(a[i], b[i], seen)) return false;
    }
    return true;
  }

  // Semigroup (Fantasy Land) — element concatenation. Associative; equality via
  // the Setoid above.
  ["arrival/tagless-final/concat"](other: AVector): AVector {
    return new AVector(this.ctx, [...this.__vector__, ...other.__vector__]);
  }

  // Arrival's async-aware Functor — `map` over the elements into a fresh vector. A
  // vector crosses OUT to a foreign Functor, so each mapped element is UNWRAPPED to
  // its raw JS value (a SchemeString/SchemeExact/ASymbol/ANil → string/number/string/
  // null) — the DR4 box-strip, pinned GOLDEN by coercion-soundness's "SchemeVector ·
  // map STRIPS element boxes". This is DELIBERATELY the opposite of APair's box-PRESERVING
  // map (a Pair stays an arrival list, never crossing out). `fn` is awaited per element
  // (live LIPS lambdas return Promises). (The N-ary vector-map builtin is a separate,
  // non-Functor observation — it carries arity the bare Functor underfits.)
  ["arrival/tagless-final/map"](
    fn: (x: SchemeValue) => SchemeValue | Promise<SchemeValue>,
    runCtx?: RunContext,
  ): AVector | Promise<AVector> {
    // STRICT divergence: generic `map` is a LIST op in R7RS — a vector is not a list. Loose
    // mode tolerates it (the term answers map); strict flags it non-portable. `vector-map` is
    // the faithful vector op (a SEPARATE builtin, NOT this method → never gated).
    strictGate(runCtx, {
      op: "map",
      rule: "R7RS `map` operates on lists; a vector is not a list",
      alternative: "use `vector-map` for vectors",
    });
    chargeHeap(runCtx, this.__vector__.length);
    const results = this.__vector__.map((v) => fn(v));
    if (results.some(is_promise)) {
      return (promise_all(results) as Promise<SchemeValue[]>).then(
        (resolved) => new AVector(this.ctx, resolved.map((v) => unwrapForeign(v) as SchemeValue)),
      );
    }
    return new AVector(this.ctx, results.map((v) => unwrapForeign(v) as SchemeValue));
  }

  // Arrival's async-aware Filterable — keep elements satisfying the predicate, into a
  // fresh vector. PRESERVES every kept element's box (no unwrap — coercion-soundness's
  // "SchemeVector · filter preserves every element's box"). A RegExp arg is adapted the
  // way the eager builtin's matcher does (regex → `String(x).match`); the canonical
  // keep-rule is the scheme `filter` rule — Scheme-truthy (`!is_false`) AND nil dropped
  // (`!is_nil`), IDENTICAL to APair's TF filter. `pred` is awaited per element.
  async ["arrival/tagless-final/filter"](
    arg: ((x: SchemeValue) => unknown | Promise<unknown>) | RegExp,
    runCtx?: RunContext,
  ): Promise<AVector> {
    // STRICT divergence: `filter` (SRFI-1) is a LIST op — a vector is not a list.
    strictGate(runCtx, {
      op: "filter",
      rule: "`filter` (SRFI-1) operates on lists; a vector is not a list",
      alternative: "filter the list form: (list->vector (filter pred (vector->list v)))",
    });
    chargeHeap(runCtx, this.__vector__.length);
    const pred = arg instanceof RegExp ? (x: SchemeValue) => String(x).match(arg) : arg;
    const out: SchemeValue[] = [];
    for (const v of this.__vector__) {
      const verdict = await pred(v);
      if (!is_false(verdict) && !is_nil(verdict)) out.push(v);
    }
    return new AVector(this.ctx, out);
  }

  // Arrival's canonical async-aware reduce — the scheme/SRFI fold convention
  // `fn(element, acc)` (accumulator LAST), left fold, head-to-tail. Threads the
  // accumulator with `await` (live LIPS lambdas return Promises). Reproduces the eager
  // scheme `reduce` over a vector exactly — `(reduce - 100 (vector 1 2 3 4 5))` = -97,
  // NOT the FL acc-first 85. IDENTICAL convention to APair's TF reduce.
  async ["arrival/tagless-final/reduce"]<Acc>(
    fn: (element: SchemeValue, acc: Acc) => Acc | Promise<Acc>,
    initial: Acc,
    runCtx?: RunContext,
  ): Promise<Acc> {
    // STRICT divergence: `reduce` (SRFI-1) is a LIST op — a vector is not a list.
    strictGate(runCtx, {
      op: "reduce",
      rule: "`reduce` (SRFI-1) operates on lists; a vector is not a list",
      alternative: "reduce the list form via (vector->list v)",
    });
    chargeHeap(runCtx, this.__vector__.length);
    let acc = initial;
    for (const v of this.__vector__) acc = await fn(v, acc);
    return acc;
  }

  // Arrival's structure-preserving `sort` — a fresh sorted VECTOR (a vector sorts to a
  // vector; the container-preserving return is structural — the term returns its own shape).
  // Sorts a COPY of the payload with the shared `deriveSortCompare` (no comparator ⇒ the
  // elements' own `arrival/tagless-final/lte` total order; a comparator ⇒ a SRFI-95 `less?`
  // predicate), into a new AVector. Element boxes are PRESERVED (only reordered, NO
  // unwrapForeign — this is NOT the cross-out map; mirrors the box-PRESERVING filter). The
  // source payload is untouched (slice copy), so a frozen literal is safe. ES Array.sort is
  // sync + STABLE; the runCtx symbol.sequence threads charges runCtx.heapMeter before materializing (Option A).
  ["arrival/tagless-final/sort"](
    comparator?: (a: SchemeValue, b: SchemeValue) => unknown,
    runCtx?: RunContext,
  ): AVector {
    chargeHeap(runCtx, this.__vector__.length);
    const out = this.__vector__.slice();
    out.sort(deriveSortCompare(comparator as ((a: unknown, b: unknown) => unknown) | undefined));
    return new AVector(this.ctx, out);
  }

  // Arrival's element-count — `length` carrying the ELEMENTS' unioned provenance, NOT the
  // container box (DISSOLVED from fl-interop's `length` overlay onto the term; the base stdlib
  // `length` keeps the CONTAINER-provenance discipline). count = the payload length; the cone
  // carries every grounded element's id (the same element-union APair gives — a count carries
  // the grounding of what it counted; the container box is outside a count's cone, so it drops).
  // `fromJs(count, unioned-prov)` when any element is grounded, else the bare `count`. NO
  // heap-charge / NO strict-gating, so the trailing runCtx `symbol.tagless` threads is ignored.
  ["arrival/tagless-final/length"](_runCtx?: unknown): AValue | number {
    const count = this.__vector__.length;
    const inputs = this.__vector__.filter((e): e is AValue => e instanceof AValue);
    if (inputs.length === 0) return count;
    const prov = unionProvenance(inputs);
    return prov.size === 0 ? count : fromJs(this.ctx, count, prov);
  }

  // Vector type-predicate — `(vector? x)` (a `symbol.taglessGuard`) asks the receiver itself
  // instead of the builtin reaching around the box with `instanceof AVector`. A SchemeVector
  // answers #t; a value lacking this method answers #f (the guard's graceful default).
  ["arrival/tagless-final/vector?"](): boolean {
    return true;
  }

  // Indexed access — `(vector-ref vec k)` dispatches here (the builtin forwards the index k).
  ["arrival/tagless-final/vector-ref"](k: number): SchemeValue {
    return this.__vector__[k];
  }

  // A boxed vector is iterable from JS — spread / for-of / Array.from yield its
  // elements, exactly like a Pair. Delegates to the raw payload's iterator. The
  // membrane never exposes this (Symbol.iterator is a BLOCKED_WELL_KNOWN_SYMBOL),
  // so iterability is a host-JS-interop affordance, not a sandbox surface.
  [Symbol.iterator](): Iterator<SchemeValue> {
    return this.__vector__[Symbol.iterator]();
  }
}

// Box-strip for a vector crossing OUT to a foreign Functor (the DR4 strip). Unwraps a
// LIPS internal box to its raw JS value so the foreign Functor stores JS-natives, not
// arrival internals; a non-box passes through unchanged. Was fl-interop's
// `unwrapLipsValue`; relocated here as AVector is the sole owner of this strip after the
// fantasy-land/* sequence-op dissolution. Constructor-name dispatch (not `instanceof`)
// keeps this off the value-class import graph, like `[TO_JS]` above.
function unwrapForeign(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v;
  const box = v as { constructor?: { name?: string }; valueOf(): unknown; __string__?: unknown; __name__?: unknown };
  const name = box.constructor?.name;
  if (name === "AExact" || name === "AInexact") return box.valueOf();
  if (name === "AString") return box.__string__;
  if (name === "ASymbol") return String(box.__name__);
  if (name === "ANil") return null;
  return v;
}

// NOTE: producer-minted (#(...) literal / make-vector / vector / vector-copy /
// list->vector / ...), NOT registered via AValue.registerBoxer — the "object"
// typeof tag is taken by the membrane's list-conser (boxing plan R6). Boxing is
// producer-driven.

// ============================================================================
// INTEROP BOUNDARY
// ============================================================================
// Same rationale as SchemeString/SchemeBytevector: block inherited-method
// exposure when interop symbol-to-field resolution walks the prototype chain.
markInteropBoundary(AVector);
