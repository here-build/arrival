/**
 * Boxes a raw JS array into the AValue kernel so it carries provenance and hosts Fantasy Land
 * algebra instances. Modeled on AString/ABytevector. Vectors are IMMUTABLE — the env is
 * immutable by design and vector-set!/vector-fill!/vector-copy! are all notImplemented stubs, so
 * the payload is never written after construction; every "mutator" instead returns a fresh
 * AVector.
 *
 * DISAMBIGUATION (boxing plan §1): a raw JS `Array` is heavily overloaded — evaluateArgs' args
 * carrier, Values, syntax-rules ellipsis machinery, and JS-array-as-list at the
 * membrane are ALL raw arrays and are NOT vectors. Only vector literals / make-vector / vector
 * builtins mint AVector. Being its own class leaves `Array.isArray` sites unaffected — never
 * widen them to accept it.
 *
 * Boxing track: docs/package-specific/arrival-scheme/plan-2026-06-10-boxing-track.md (S5).
 *
 * Lineage: R7RS-small §6.8 vectors; the Setoid/Semigroup/Functor/Filterable/
 * Foldable instances are Fantasy Land (fantasyland/fantasy-land).
 */
import { CLASS } from "../../well-known-symbols.js";
import { type RunContext } from "./RunContext.js";
import { applyCallback } from "./ACallable.js";
import { chargeHeap } from "../../heap-budget.js";
import { is_promise } from "../../eval/guards.js";
import { is_false } from "../value-guards.js";
import { promise_all } from "../../utils/promises.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { egressContainerProxy } from "../egress-proxy.js";
import { ANil, nil } from "./ANil.js";
import { strictGate } from "../../errors.js";
import { printValue } from "../print.js";
import { type SeenMap, structuralEqual } from "../structural-equal.js";
import type { SchemeValue } from "../types.js";
// op-helpers imports AVector back, but both directions are referenced only inside function
// bodies (op-helpers' asVector; this term's sort), so the cycle never bites at module-eval.
import { deriveSortCompare, withInputProvenance } from "../op-helpers.js";
import { reStampChild } from "./deep-restamp.js";
import { APair } from "./APair.js";
import { ASymbol } from "./ASymbol.js";

/** Code-position lowering cache (arrival/tagless-final/lower) for `[…]` literal nodes — the
 *  `(vector …)` application built once per node and re-answered on every subsequent eval of
 *  the SAME node (shared AST — a `[…]` literal inside a loop body must not re-cons the spine
 *  every iteration). WeakMap, not an instance field: keeps the cache off the vector's own
 *  payload (mirrors AJSObject's `entryCaches`) and off the `#`-private-slot tslib helper this
 *  workspace's `importHelpers: true` needs. GC-correct — entry disappears with the node. */
const LOWERED_LITERAL = new WeakMap<AVector, APair<SchemeValue, SchemeValue>>();

export class AVector<T extends SchemeValue = SchemeValue> extends AValue {
  static [CLASS] = "vector";
  readonly kind = "vector" as const;

  /** `[…]` reader-literal marker: the evaluator, meeting this node in CODE position,
   *  evaluates the elements (Clojure semantics) by lowering to the equivalent
   *  `(vector …)` application — see evaluator.ts. Under `quote` the node is data (a
   *  vector of the raw forms, frozen like every parsed literal). False for `#(…)`
   *  R7RS constants (self-evaluating, elements stay data) and constructed vectors.
   *  Reader-minted only. */
  evalElements = false;

  constructor(
    ctx: RunContext,
    /** Element payload — public but dunder-named to hint internals: read-only
     *  (`readonly T[]`, and elements are themselves immutable AValues, so the
     *  readonly is deep). Mutation goes nowhere — construct a fresh vector. */
    public readonly __vector__: readonly T[],
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(ctx, provenance);
  }

  get length(): number {
    return this.__vector__.length;
  }

  static isVector(x: unknown): x is AVector {
    return x instanceof AVector;
  }

  ref(i: number): SchemeValue {
    return this.__vector__[i];
  }

  copy(start = 0, end = this.__vector__.length): AVector {
    return new AVector(this.ctx, this.__vector__.slice(start, end));
  }

  // Membrane unwrap (TO_JS protocol): a boxed vector crosses to JS as an R9 lazy
  // egress proxy — observationally a plain array (Array.isArray true, JSON/spread/
  // iteration work), elements unwrap through their own `arrival/toJS` on first read,
  // same box → same proxy (egress-proxy.ts owns the tracker and the write doors).
  ["arrival/toJS"](): readonly unknown[] {
    const elements = this.__vector__;
    return egressContainerProxy(this, "array", {
      keys: () => elements.map((_, i) => String(i)),
      read: (key) => elements[Number(key)],
    }) as readonly unknown[];
  }

  valueOf(): readonly T[] {
    return this.__vector__;
  }

  withProvenance(p: ReadonlySet<number>): AVector {
    const v = new AVector(this.ctx, this.__vector__, p);
    // Same-identity re-stamp: a `[…]` literal node stays a `[…]` literal node.
    v.evalElements = this.evalElements;
    return v;
  }

  /** Deep re-stamp (the inbound membrane's AValue claim, moved onto the class — see the
   *  base declaration in AValue.ts). Fresh vector under the CROSSING's ctx, elements
   *  re-stamped through the closed child fold — no casts (the dissolved router arm
   *  carried one of the membrane's two sanctioned casts because it couldn't see that
   *  `__vector__` is always SchemeValue[]). Deliberately does NOT copy `evalElements`
   *  (unlike shallow `withProvenance`) — byte-stable with the dissolved jsToSchemeImpl
   *  arm, which minted a bare `new AVector(ctx, …, p)`. */
  ["arrival/withProvenanceDeep"](
    ctx: RunContext,
    p: ReadonlySet<number>,
    seen: WeakSet<object> = new WeakSet(),
  ): AVector {
    seen.add(this);
    return new AVector(
      ctx,
      this.__vector__.map((el) => reStampChild(el, ctx, p, seen)),
      p,
    );
  }

  // Code-position lowering (eval/evaluator.ts "code-position lowering"): a `[…]` reader
  // literal (`evalElements`) lowers ONCE, cached, to the equivalent `(vector …)` application
  // — CODE position gets Clojure-style element evaluation BY CONSTRUCTION (the lowering is
  // then evaluated through the ordinary apply path, so membrane marshaling / heap charging /
  // provenance all ride unchanged). `#(…)` R7RS constants and constructed vectors
  // (`evalElements === false`) answer null: self-evaluating, no lowering.
  ["arrival/tagless-final/lower"](): APair<SchemeValue, SchemeValue> | null {
    if (!this.evalElements) return null;
    let lowered = LOWERED_LITERAL.get(this);
    if (lowered === undefined) {
      // The lowering always prepends the `vector` head symbol to the elements, so the built
      // spine is provably non-empty — genuinely `APair<SchemeValue, SchemeValue>`, never
      // `ANil`; `fromArray`'s return stays wide (`AListAlike<T> | unknown[]`) for the general
      // case, narrowed here to match what's actually built.
      lowered = APair.fromArray(this.ctx, [new ASymbol(this.ctx, "vector"), ...this.__vector__], false) as APair<
        SchemeValue,
        SchemeValue
      >;
      LOWERED_LITERAL.set(this, lowered);
    }
    return lowered;
  }

  // Setoid — structural element-wise equality, threading the harness's shared `seen`.
  // structuralEqual records (this, other) BEFORE dispatching, so a mutually-cyclic vector pair
  // re-encounters itself in the harness and short-circuits (fixes a fresh-seen-per-call stack
  // blow once the harness's inline-Vector special-case was removed, B2). Non-AVector → false.
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

  // Semigroup — element concatenation. Associative; equality via the Setoid above.
  ["arrival/tagless-final/concat"](other: AVector): AVector {
    return new AVector(this.ctx, [...this.__vector__, ...other.__vector__]);
  }

  // STRICT divergence: car/cdr are PAIR ops in R7RS — a vector is not a pair. LOOSE mode treats
  // a vector list-like (car → element 0; cdr → the rest AS A VECTOR slice), so
  // `(car borrowed-array)` keeps working and cXr composes. STRICT flags it non-portable,
  // pointing at vector-ref/slicing — same tolerant-loose/faithful-strict split as map/filter.
  // Mirrors ANil's nil-tolerance.
  ["arrival/tagless-final/car"](runCtx?: RunContext): SchemeValue {
    strictGate(runCtx, {
      op: "car",
      rule: "R7RS `car` requires a pair; a vector is not a pair",
      alternative: "use `(vector-ref v 0)` for the first element, or `(vector->list v)`",
    });
    // loose: first element; empty → nil (tolerant, exactly like `(car '())` loose)
    return this.__vector__.length > 0 ? this.__vector__[0] : nil;
  }

  ["arrival/tagless-final/cdr"](runCtx?: RunContext): AVector {
    strictGate(runCtx, {
      op: "cdr",
      rule: "R7RS `cdr` requires a pair; a vector is not a pair",
      alternative: "use vector slicing or `(vector->list v)`",
    });
    // loose: the rest as a VECTOR slice (index 1..) — empty/singleton → the empty vector
    return new AVector(this.ctx, this.__vector__.slice(1), this.provenance);
  }

  // Print protocol — R7RS external repr `#(elem …)`, each element via `printValue`.
  ["arrival/print"](): string {
    return `#(${this.__vector__.map((el) => printValue(el)).join(" ")})`;
  }

  // Functor `map` — PRESERVES every mapped element's box, rebuilding a FRESH AVector (DR4 fix:
  // mirrors APair's box-preserving map, P8 "one algebra, every carrier" — a term's box
  // discipline cannot vary by carrier). Results are kept RAW (no box-stripping), same
  // convention as APair's map. `fn` is awaited per element. (vector-map, the N-ary builtin, is
  // a separate non-Functor op.)
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
    const results = this.__vector__.map((v) => applyCallback(fn, [v], runCtx));
    // R2/C2 (RULINGS.md R2): map is LENGTH-PRESERVING — PROXY the container's own
    // grouping/length-fact stamp through unchanged (mirrors APair's map, P8 "one algebra,
    // every carrier" — the two carriers must agree, not just their element boxes).
    if (results.some(is_promise)) {
      return (promise_all(results) as Promise<SchemeValue[]>).then(
        (resolved): AVector => withInputProvenance([this], new AVector(this.ctx, resolved)),
      );
    }
    return withInputProvenance([this], new AVector(this.ctx, results as SchemeValue[]));
  }

  // Filterable — keeps elements satisfying the predicate into a fresh vector, PRESERVING every
  // kept element's box (coercion-soundness: "AVector · filter preserves every element's box").
  // RegExp arg adapts via String(x).match; keep-rule matches APair's TF filter (Scheme-truthy
  // AND nil dropped). `pred` awaited per element.
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
      const verdict = await applyCallback(pred, [v], runCtx);
      if (!is_false(verdict) && !(verdict instanceof ANil)) out.push(v);
    }
    // R2/C2: filter is LENGTH-CHANGING — the container's own grouping/length-fact stamp is
    // PROVENANCED, minted fresh as the union of (a) the INPUT container's own top-level
    // stamp and (b) the decision lineage that changed the length — here, the SURVIVING
    // elements' own top-level provenance (mirrors APair's filter — naive-but-explicit,
    // not a deep walk).
    return withInputProvenance([this, ...out], new AVector(this.ctx, out));
  }

  // Canonical async-aware reduce, SRFI fold convention `fn(element, acc)` (acc last), left
  // fold, head-to-tail. Threads the accumulator with `await`. Reproduces eager `reduce` over a
  // vector exactly — `(reduce - 100 (vector 1 2 3 4 5))` = -97, NOT the FL acc-first 85. Same
  // convention as APair's TF reduce.
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
    for (const v of this.__vector__) acc = (await applyCallback(fn, [v, acc], runCtx)) as Acc;
    return acc;
  }

  // Structure-preserving sort — a vector sorts to a fresh vector (container-preserving
  // return). Sorts a COPY with the shared `deriveSortCompare` (no comparator ⇒ elements' own
  // `lte` total order; comparator ⇒ SRFI-95 `less?`). Element boxes are PRESERVED (only
  // reordered — this is NOT the cross-out map; mirrors the box-preserving filter). Source
  // payload untouched (slice copy), so a frozen literal is safe. ES Array.sort is stable;
  // charges heap before materializing. R2/C2: sort is LENGTH-PRESERVING — the container's
  // own grouping/length-fact stamp is PROXIED through unchanged (P8 — must agree with
  // APair's sort, which proxies identically; the two carriers no longer diverge).
  ["arrival/tagless-final/sort"](
    comparator?: (a: SchemeValue, b: SchemeValue) => unknown,
    runCtx?: RunContext,
  ): AVector {
    chargeHeap(runCtx, this.__vector__.length);
    const out = this.__vector__.slice();
    out.sort(deriveSortCompare(comparator as ((a: unknown, b: unknown) => unknown) | undefined));
    return withInputProvenance([this], new AVector(this.ctx, out));
  }

  // Element-count. C4/A13 interim fix (docs/test-suite-v2/RULINGS.md R2,
  // docs/working-proposals/execution-plan-wireframe.md §7): `length` reads the CONTAINER's
  // OWN flat grouping/length-fact stamp (`withInputProvenance([this], count)`), never the
  // elements' deep union — a pure count depends only on cardinality, not on what each
  // element became. The container's own stamp is already an accurate synopsis by
  // construction (MINTED at `vector`, PROXIED through map/sort, PROVENANCED fresh by
  // filter — see the term×carrier law table, _tables/terms.ts). Always a fresh boxed
  // AExact post bare-value purge (A4/P4) — `withInputProvenance` no longer has a raw-scalar
  // tolerance. No heap-charge / no strict-gating.
  ["arrival/tagless-final/length"](_runCtx?: unknown): AValue | number {
    return withInputProvenance([this], this.__vector__.length);
  }

  // Type predicate — the receiver answers directly (`symbol.taglessGuard`) instead of the
  // builtin reaching around the box with `instanceof AVector`. #t for a vector; a value
  // lacking this method defaults to #f (the guard's graceful default).
  ["arrival/tagless-final/vector?"](): boolean {
    return true;
  }

  // Indexed access — `(vector-ref vec k)` dispatches here (the builtin forwards the index k).
  ["arrival/tagless-final/vector-ref"](k: number): SchemeValue {
    return this.__vector__[k];
  }

  // A boxed vector is iterable from JS — spread / for-of / Array.from yield its elements,
  // exactly like a Pair. Delegates to the raw payload's iterator. The membrane never exposes
  // this (Symbol.iterator is a BLOCKED_WELL_KNOWN_SYMBOL), so iterability is a host-JS-interop
  // affordance, not a sandbox surface.
  [Symbol.iterator](): Iterator<SchemeValue> {
    return this.__vector__[Symbol.iterator]();
  }
}

// Producer-minted (#(...) literal / make-vector / vector / vector-copy / list->vector / ...),
// NOT boxed from JS — fromJs's "object" arm maps a JS array to a borrowed AJSArray, not an
// AVector. Boxing is producer-driven.

// ============================================================================
// INTEROP BOUNDARY: same rationale as AString/ABytevector — inherited-method exposure is
// blocked when interop symbol-to-field resolution walks the prototype chain, via the FAMILY
// RULE in interop-access.ts (own `[CLASS]` brand on the constructor = boundary; no per-class
// stamp).
// ============================================================================
