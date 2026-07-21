/**
 * Boxes a raw JS array into the AValue kernel so it carries provenance and hosts Fantasy Land
 * algebra instances. Modeled on AString/ABytevector. Vectors are IMMUTABLE — the env is
 * immutable by design and vector-set!/vector-fill!/vector-copy! are all notImplemented stubs, so
 * the payload is never written after construction; every "mutator" instead returns a fresh
 * AVector.
 *
 * DISAMBIGUATION: a raw JS `Array` is heavily overloaded — evaluateArgs' args
 * carrier, Values, syntax-rules ellipsis machinery, and JS-array-as-list at the
 * membrane are ALL raw arrays and are NOT vectors. Only vector literals / make-vector / vector
 * builtins mint AVector. Being its own class leaves `Array.isArray` sites unaffected — never
 * widen them to accept it.
 *
 * Lineage: R7RS-small §6.8 vectors; the Setoid/Semigroup/Functor/Filterable/
 * Foldable instances are Fantasy Land (fantasyland/fantasy-land).
 */
import { CLASS } from "../../well-known-symbols.js";
import { type RunContext } from "../../run/RunContext.js";
import { applyCallback } from "./ACallable.js";
import { chargeHeap } from "../../heap-budget.js";
import { is_promise } from "../../eval/guards.js";
import { is_false } from "../value-guards.js";
import { promise_all } from "../../utils/promises.js";
import { AValue, EMPTY_PROVENANCE, mergeProvenance } from "./AValue.js";
import { egressContainerProxy } from "../../membrane/egress-proxy.js";
import { ANil, nil } from "./ANil.js";
import { strictGate } from "../../errors.js";
import { printValue } from "../print.js";
import { type SeenMap, structuralEqual } from "../structural-equal.js";
import type { MembraneExit, SchemeValue } from "../types.js";
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

  // Crossing to JS (TO_JS protocol) — the ONE method, keyed on `exit`. A boxed vector
  // egresses as an R9 lazy proxy — observationally a plain array (Array.isArray true,
  // JSON/spread/iteration work), same box → same proxy (egress-proxy.ts owns the tracker
  // and the write doors). Bare (no `exit`): elements unwrap through their own `arrival/toJS`,
  // identity per-box. Membrane (`exit` from egressAValue): elements materialize through the
  // full recursive crossing and the proxy caches per (box, mode, SCOPE) — see egress-proxy.ts's
  // identity laws.
  ["arrival/toJS"](exit?: MembraneExit): readonly unknown[] {
    const elements = this.__vector__;
    return egressContainerProxy(
      this,
      "array",
      {
        keys: () => elements.map((_, i) => String(i)),
        read: (key) => elements[Number(key)],
      },
      exit ? { membrane: exit } : undefined,
    ) as readonly unknown[];
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
   *  re-stamped through the closed child fold — no cast needed: `__vector__` is always
   *  `SchemeValue[]`. Deliberately does NOT copy `evalElements` (unlike shallow
   *  `withProvenance`): a membrane-crossed vector is a constructed value, never a
   *  reader-minted `[…]` literal. */
  ["arrival/withProvenanceDeep"](
    ctx: RunContext,
    p: ReadonlySet<number>,
    seen: WeakSet<object> = new WeakSet(),
  ): AVector {
    seen.add(this);
    return new AVector(
      ctx,
      this.__vector__.map((el) => reStampChild(el, ctx, p, seen)),
      // UNION, not replace — the crossing ADDS its origin to what this container already knew.
      mergeProvenance(this.provenance, p),
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
  // re-encounters itself in the harness and short-circuits — no fresh-seen-per-call stack blow.
  // Non-AVector → false.
  ["arrival/tagless-final/equals"](other: unknown, seen?: SeenMap): boolean {
    if (!(other instanceof AVector)) return false;
    const a = this.__vector__;
    const b = other.__vector__;
    if (a.length !== b.length) return false;
    for (const [i, element] of a.entries()) {
      if (!structuralEqual(element, b[i], seen)) return false;
    }
    return true;
  }

  // Semigroup — element concatenation. Associative; equality via the Setoid above.
  ["arrival/tagless-final/concat"](other: AVector): AVector {
    return new AVector(this.ctx, [...this.__vector__, ...other.__vector__]);
  }

  // STRICT divergence: car/cdr are PAIR ops in R7RS — a vector is not a pair. STRICT flags it
  // non-portable, pointing at vector-ref/`vector->list`. LOOSE mode tolerates both: `car` is the
  // first element (nil when empty, exactly like `(car '())` loose); `cdr` is the rest as a fresh
  // `AVector` SLICE — a genuine vector stays a genuine vector, deliberately NOT projected to an
  // `AJSArrayList` spine view (see `cdr` below for why the view belongs on borrowed arrays, and
  // the AJSArrayList manifold note for the `null?`/`pair?` residual a slice leaves).
  //
  // Vector OPERATIONS (vector-ref/length/slice/map/…) are untouched. This is only the spine chart.
  ["arrival/tagless-final/car"](runCtx?: RunContext): SchemeValue {
    strictGate(runCtx, {
      op: "car",
      rule: "R7RS `car` requires a pair; a vector is not a pair",
      alternative: "use `(vector-ref v 0)` for the first element, or `(vector->list v)`",
    });
    // loose: first element; empty → nil (tolerant, exactly like `(car '())` loose)
    return this.__vector__.length > 0 ? this.__vector__[0] : nil;
  }

  ["arrival/tagless-final/cdr"](runCtx?: RunContext): AVector | ANil {
    strictGate(runCtx, {
      op: "cdr",
      rule: "R7RS `cdr` requires a pair; a vector is not a pair",
      alternative: "use vector slicing or `(vector->list v)`",
    });
    // loose: the rest AS A VECTOR SLICE — a genuine vector stays a genuine vector.
    //
    // This is deliberately NOT an `AJSArrayList` spine view. A genuine vector literal is
    // never produced by an MCP tool (every tool result arrives as an `AJSArray`), so making
    // THIS `cdr` project a list-spine view would be patching the wrong type — it would teach
    // vectors to lie about being lists to paper over a bug that belongs to the borrowed array
    // (`AJSArray` projects its own spine view straight off its borrowed `source`).
    //
    // Keeping the view out of here also keeps `AJSArrayList` honest: its backing store is then
    // ALWAYS raw JSON from a tool, so its `car` is always a genuine (lazy) plane crossing. Pointing
    // it at an OWNED vector's already-boxed elements would have fused two different arrows into one
    // class — a plane crossing and a pure reading — and forced a runtime `instanceof AValue` test to
    // tell them apart. (It also silently re-stamped those elements with the container's provenance,
    // which the term-carrier law caught.)
    //
    // Residual, named rather than papered over: a hand-written `null?`-terminated walk over a
    // VECTOR LITERAL will not terminate — the exhausted slice is `#()`, and `null?` is ANil-only.
    // It bites only genuine vector literals (values a tool cannot produce), and strict mode doors
    // it. The honest fix, if it ever bites, is `(vector->list v)` — not a chart that lies.
    return new AVector(this.ctx, this.__vector__.slice(1), this.provenance);
  }

  // Print protocol — R7RS external repr `#(elem …)`, each element via `printValue`.
  /** Elements ground the vector; the vector itself does not stamp from them (see AValue). */
  override ["arrival/provenanceChildren"](): Iterable<unknown> {
    return this.__vector__;
  }

  ["arrival/print"](): string {
    return `#(${this.__vector__.map((el) => printValue(el)).join(" ")})`;
  }

  // Functor `map` — PRESERVES every mapped element's box, rebuilding a FRESH AVector: mirrors
  // APair's box-preserving map ("one algebra, every carrier" — a term's box
  // discipline cannot vary by carrier). Results are kept RAW (no box-stripping), same
  // convention as APair's map. `fn` is awaited per element. (vector-map, the N-ary builtin, is
  // a separate non-Functor op.)
  ["arrival/tagless-final/map"](
    fn: (x: SchemeValue) => SchemeValue | Promise<SchemeValue>,
    runCtx: RunContext,
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
    // RULINGS.md R2: map is LENGTH-PRESERVING — PROXY the container's own
    // grouping/length-fact stamp through unchanged (mirrors APair's map — "one algebra,
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
    runCtx: RunContext,
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
      if (!is_false(verdict)) out.push(v); // R7RS: only #f is false — nil verdicts keep
    }
    // filter is LENGTH-CHANGING — the container's own grouping/length-fact stamp is
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
    runCtx: RunContext,
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
  // charges heap before materializing. sort is LENGTH-PRESERVING — the container's
  // own grouping/length-fact stamp is PROXIED through unchanged (must agree with
  // APair's sort, which proxies identically; the two carriers no longer diverge).
  ["arrival/tagless-final/sort"](
    comparator: ((a: SchemeValue, b: SchemeValue) => unknown) | undefined,
    runCtx: RunContext,
  ): AVector {
    chargeHeap(runCtx, this.__vector__.length);
    const out = [...this.__vector__];
    out.sort(deriveSortCompare(comparator as ((a: unknown, b: unknown) => unknown) | undefined, runCtx));
    return withInputProvenance([this], new AVector(this.ctx, out));
  }

  // Prefix — SAME-KIND: vector in, fresh vector out (mirrors sort's container-preserving
  // return; take/drop/take-while/drop-while are all LENGTH-CHANGING, so — unlike sort/map's
  // PROXIED stamp — the container's own grouping/length-fact stamp is PROVENANCED fresh, same
  // discipline as filter above). `n` is clamped into [0, length] — R7RS/SRFI-1 `take` on an
  // out-of-range n is an error on lists, but a vector has no cons-cell tail to run off, so the
  // clamp is the faithful vector answer, not a loose tolerance.
  ["arrival/tagless-final/take"](n: number, runCtx: RunContext): AVector {
    // STRICT divergence: `take` (SRFI-1) is a LIST op — a vector is not a list.
    strictGate(runCtx, {
      op: "take",
      rule: "`take` (SRFI-1) operates on lists; a vector is not a list",
      alternative: "take the list form: (list->vector (take (vector->list v) n))",
    });
    const k = Math.max(0, Math.min(n, this.__vector__.length));
    chargeHeap(runCtx, k);
    const out = this.__vector__.slice(0, k);
    return withInputProvenance([this, ...out], new AVector(this.ctx, out));
  }

  // Suffix — SAME-KIND, same clamp/provenance discipline as take above.
  ["arrival/tagless-final/drop"](n: number, runCtx: RunContext): AVector {
    // STRICT divergence: `drop` (SRFI-1) is a LIST op — a vector is not a list.
    strictGate(runCtx, {
      op: "drop",
      rule: "`drop` (SRFI-1) operates on lists; a vector is not a list",
      alternative: "drop the list form: (list->vector (drop (vector->list v) n))",
    });
    const k = Math.max(0, Math.min(n, this.__vector__.length));
    const out = this.__vector__.slice(k);
    chargeHeap(runCtx, out.length);
    return withInputProvenance([this, ...out], new AVector(this.ctx, out));
  }

  // Longest satisfying prefix — SEQUENTIAL walk (NOT filter's concurrent fan): the stop at the
  // first falsy verdict IS the semantics (pred order-observable — a concurrent fan would still
  // have to serialize the stop-decision, so there is no win to be had, only a correctness risk).
  // Keep-rule matches filter's (Scheme-truthy AND nil dropped). SAME-KIND, PROVENANCED like take.
  async ["arrival/tagless-final/take-while"](
    pred: (x: SchemeValue) => unknown | Promise<unknown>,
    runCtx: RunContext,
  ): Promise<AVector> {
    // STRICT divergence: `take-while` (SRFI-1) is a LIST op — a vector is not a list.
    strictGate(runCtx, {
      op: "take-while",
      rule: "`take-while` (SRFI-1) operates on lists; a vector is not a list",
      alternative: "(list->vector (take-while pred (vector->list v)))",
    });
    const out: SchemeValue[] = [];
    for (const v of this.__vector__) {
      const verdict = await applyCallback(pred, [v], runCtx);
      if (is_false(verdict)) break; // R7RS: only #f is false
      out.push(v);
    }
    chargeHeap(runCtx, out.length);
    return withInputProvenance([this, ...out], new AVector(this.ctx, out));
  }

  // The take-while remainder — same sequential-pred discipline (the stop index IS the
  // semantics), SAME-KIND fresh vector, PROVENANCED like take/drop.
  async ["arrival/tagless-final/drop-while"](
    pred: (x: SchemeValue) => unknown | Promise<unknown>,
    runCtx: RunContext,
  ): Promise<AVector> {
    // STRICT divergence: `drop-while` (SRFI-1) is a LIST op — a vector is not a list.
    strictGate(runCtx, {
      op: "drop-while",
      rule: "`drop-while` (SRFI-1) operates on lists; a vector is not a list",
      alternative: "(list->vector (drop-while pred (vector->list v)))",
    });
    let i = 0;
    for (; i < this.__vector__.length; i++) {
      const verdict = await applyCallback(pred, [this.__vector__[i]], runCtx);
      if (is_false(verdict)) break; // R7RS: only #f is false
    }
    const out = this.__vector__.slice(i);
    chargeHeap(runCtx, out.length);
    return withInputProvenance([this, ...out], new AVector(this.ctx, out));
  }

  // Element-count. Interim fix (RULINGS.md R2): `length` reads the CONTAINER's
  // OWN flat grouping/length-fact stamp (`withInputProvenance([this], count)`), never the
  // elements' deep union — a pure count depends only on cardinality, not on what each
  // element became. The container's own stamp is already an accurate synopsis by
  // construction (MINTED at `vector`, PROXIED through map/sort, PROVENANCED fresh by
  // filter — see the term×carrier law table, _tables/terms.ts). Always a fresh boxed
  // AExact post bare-value purge — `withInputProvenance` no longer has a raw-scalar
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
  // Bounds-checked (R7RS §6.8: "it is an error if k is not a valid index"): an
  // out-of-range index throws a clean, catchable RangeError — same quality bar as
  // list-ref's — rather than leaking a raw JS `undefined` past the interop boundary.
  ["arrival/tagless-final/vector-ref"](k: number): SchemeValue {
    if (!Number.isInteger(k) || k < 0 || k >= this.__vector__.length) {
      throw new RangeError(`vector-ref: index ${k} out of range for a vector of length ${this.__vector__.length}`);
    }
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
