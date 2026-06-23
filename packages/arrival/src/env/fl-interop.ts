/**
 * FL / array-interop overlay — the genuine interop members of the inference-plane
 * base env (`inferenceEnv`), carved out of the hand-built overlay in
 * `inference-env.ts`. These are the members with NO equivalent in the assembled
 * base: the SchemeJSArray-aware `car`/`cdr` and the Fantasy-Land-dispatching,
 * nil-tolerant `filter`/`map`/`reduce`.
 *
 * Why a separate capability and not an inline spread: this overlay is a real pack
 * that bridges two impedance mismatches the base env does NOT —
 *   1. Lazy JS-array wrappers (`SchemeJSArray`) that must unwrap before LIPS car/cdr.
 *   2. External Fantasy-Land structures whose FL methods are SYNC while LIPS lambdas
 *      are ASYNC (the asyncFL* helpers bridge collect→apply→reconstruct).
 *
 * LAZY BUILTIN CAPTURE (load-order discipline): the `car`/`cdr`/`filter`/`map`/
 * `reduce` it overrides delegate to the assembled base versions (`builtinCar` …).
 * Those are read from `global_env` LAZILY — at first symbol invocation, never
 * eagerly at module top-level. Eager `global_env.get("car")` at module load races
 * the async assembly of the value-domain clusters onto global_env: a load-order
 * miss captures `undefined` (the exact bug a prior `SAFE_BUILTINS` eager snapshot
 * hit). At call time global_env is fully assembled, so the read is safe — and this
 * pack is assembled onto inferenceEnv only AFTER global_env's native assembly + the
 * base packs, so the builtins are live before any symbol here can fire.
 *
 * Lineage: the Fantasy Land algebra (fantasyland/fantasy-land) used as a
 * tagless-final encoding — the polymorphic map/filter/reduce dispatch to a value's
 * `fantasy-land/*` instance, so the builtins are programs over the algebra, blind
 * to the instance (Carette, Kiselyov & Shan, "Finally Tagless, Partially
 * Evaluated", 2009).
 */

import { EnvCapability } from "./capability.js";
import { global_env } from "../stdlib.js";
import { nil } from "../values/types.js";
import { SchemeJSArray } from "../membrane.js";
import { SchemeExact, SchemeInexact, type SchemeNumeric } from "../values/numbers.js";
import { is_false, is_nil } from "../eval/guards.js";
import { Pair } from "../values/Pair.js";
import { SchemeVector } from "../values/SchemeVector.js";
import { AValue, unionProvenance, EMPTY_PROVENANCE } from "../values/AValue.js";
import { schemeFalse, schemeTrue } from "../values/SchemeBool.js";
import { LazySeq, is_lazy_seq } from "../values/LazySeq.js";

// ── FL protocol surface ──────────────────────────────────────────────────────
// Fantasy-Land structures are opaque carriers — we only ever touch their FL
// methods, never their internals. Model them as that minimal interface, not `any`.
interface FantasyLand {
  "fantasy-land/reduce"<A>(f: (acc: A, val: unknown) => A, init: A): A;
  "fantasy-land/map"(f: (val: unknown) => unknown): unknown;
  "fantasy-land/filter"(p: (val: unknown) => unknown): unknown;
}

// Arrival's canonical reduce protocol method — present on every arrival list term
// (Pair, via Pair.ts). It carries the scheme/SRFI fold convention `fn(element, acc)`
// (accumulator LAST), the opposite arg order of the FL Foldable it delegates to. The
// overlay routes any value bearing this method (and any FL Foldable) through the
// element-first async fold below, so a Pair reduces in scheme convention.
interface ArrivalFoldable {
  "arrival/tagless-final/reduce"<A>(fn: (element: unknown, acc: A) => A, init: A): A;
}

type Callable = (...args: unknown[]) => unknown;

// ── Lazy builtin capture ────────────────────────────────────────────────────
// Read once on first use, after bootstrap, when global_env is fully assembled.
let builtinCar: Callable | undefined;
let builtinCdr: Callable | undefined;
let builtinFilter: Callable | undefined;
let builtinMap: Callable | undefined;
let builtinReduce: Callable | undefined;

// Comparison builtins — bridged Operators (=/</>/<=/>=). Captured lazily for the
// nil-tolerant overrides below (the operator membrane throws on a nil operand at
// codec-match time, before the op body runs; we intercept that one case).
let builtinNumEq: Callable | undefined;
let builtinLt: Callable | undefined;
let builtinGt: Callable | undefined;
let builtinLte: Callable | undefined;
let builtinGte: Callable | undefined;

function captureBuiltins(): void {
  if (builtinCar !== undefined) return;
  builtinCar = global_env.get("car", { throwError: false }) as Callable;
  builtinCdr = global_env.get("cdr", { throwError: false }) as Callable;
  builtinFilter = global_env.get("filter", { throwError: false }) as Callable;
  builtinMap = global_env.get("map", { throwError: false }) as Callable;
  builtinReduce = global_env.get("reduce", { throwError: false }) as Callable;
  builtinNumEq = global_env.get("=", { throwError: false }) as Callable;
  builtinLt = global_env.get("<", { throwError: false }) as Callable;
  builtinGt = global_env.get(">", { throwError: false }) as Callable;
  builtinLte = global_env.get("<=", { throwError: false }) as Callable;
  builtinGte = global_env.get(">=", { throwError: false }) as Callable;
}

// nil/'() is truthy in Scheme, so `is_false` does NOT catch it — a nil operand must
// be detected structurally. A null/undefined JS value or a Scheme Nil counts as the
// "absent value" that should compare to #f rather than crash the whole proof.
function isNilOperand(v: unknown): boolean {
  return v == null || (v as { constructor?: { name?: string } })?.constructor?.name === "Nil";
}

// ── Numeric Ord chain (plane-local) ─────────────────────────────────────────
// The 5 comparisons below derive PURELY from the operands' numeric `fantasy-land/lte`
// (SchemeExact/SchemeInexact, added value-side) when EVERY operand is a number — no
// `global_env.get("=")` env-read. NaN ⇒ both `lte` directions are #f ⇒ every relation
// collapses to #f, exactly like the numeric Operators. A non-number operand (or arity 0)
// can't be served by `lte` without diverging from the Operator's membrane type-error, so
// it routes to the kept builtin (which IS that Operator — identical throw). nil is
// short-circuited to #f first (the plane's nil-tolerance, see filter/map).
const isNumberOperand = (v: unknown): v is SchemeNumeric =>
  v instanceof SchemeExact || v instanceof SchemeInexact;
const flLteNum = (a: SchemeNumeric, b: SchemeNumeric): boolean => a["fantasy-land/lte"](b);
// Each relation of the (partial — NaN-incomparable) numeric order, from the single `lte`.
// Strict </> use the CONJUNCTIVE form (`lte(a,b) && !lte(b,a)`), NOT `!lte(b,a)`: the
// latter is the total-order shortcut and would wrongly yield #t for a NaN pair.
const NUM_PAIR: Record<"=" | "<" | ">" | "<=" | ">=", (a: SchemeNumeric, b: SchemeNumeric) => boolean> = {
  "=": (a, b) => flLteNum(a, b) && flLteNum(b, a),
  "<": (a, b) => flLteNum(a, b) && !flLteNum(b, a),
  ">": (a, b) => flLteNum(b, a) && !flLteNum(a, b),
  "<=": (a, b) => flLteNum(a, b),
  ">=": (a, b) => flLteNum(b, a),
};
// Adjacent-pair chain — matches the Operators' `prev`-walk. (`=`'s Operator is
// first-vs-each, equivalent for an equivalence relation: with no NaN, transitivity makes
// adjacent ≡ first-vs-each; with a NaN, both forms hit a failing pair → #f.)
function numericChain(sym: "=" | "<" | ">" | "<=" | ">=", args: SchemeNumeric[]): boolean {
  const rel = NUM_PAIR[sym];
  for (let i = 0; i < args.length - 1; i++) {
    if (!rel(args[i], args[i + 1])) return false;
  }
  return true;
}
// Stamp the verdict with the operands' provenance union — byte-identical to bridge.ts's
// wrapOperator (out: Bool): box to schemeTrue/schemeFalse ONLY when provenance is non-empty
// (empty ⇒ raw bool, to keep the `!== false`/find landmine callers alive), else withProvenance.
function numericCompare(sym: "=" | "<" | ">" | "<=" | ">=", args: SchemeNumeric[]): unknown {
  const verdict = numericChain(sym, args);
  // Every operand is a SchemeExact/SchemeInexact (subtype of AValue), so union directly.
  const provenance = unionProvenance(args);
  if (provenance.size > 0) return (verdict ? schemeTrue : schemeFalse).withProvenance(provenance);
  return verdict;
}

// ── FL async-dispatch helpers (module-private) ───────────────────────────────

/**
 * Collect all leaf values from an FL Foldable using fantasy-land/reduce.
 * Returns values in traversal order (same order as map visits them).
 */
function flCollectValues(structure: FantasyLand): unknown[] {
  const values: unknown[] = [];
  structure["fantasy-land/reduce"]((acc: null, val: unknown) => {
    values.push(val);
    return acc;
  }, null);
  return values;
}

/**
 * Unwrap LIPS internal types to JS equivalents for FL interop.
 * When LIPS lambdas produce SchemeExact/SchemeString/etc, FL structures
 * should store JS-native values, not LIPS internals.
 */
function unwrapLipsValue(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v;
  const box = v as { constructor?: { name?: string }; valueOf(): unknown; __string__?: unknown; __name__?: unknown };
  const name = box.constructor?.name;
  if (name === "SchemeExact" || name === "SchemeInexact") return box.valueOf();
  if (name === "SchemeString") return box.__string__;
  if (name === "SchemeSymbol") return String(box.__name__);
  if (name === "Nil") return null;
  return v;
}

/**
 * FL dispatch helpers for async LIPS lambdas.
 *
 * LIPS lambdas always return Promises. FL methods are synchronous.
 * Strategy: collect values via FL reduce, apply async fn, cache results
 * by value identity, then reconstruct via FL method using cached lookups.
 * Value-based caching is order-independent (filter visits bottom-up,
 * reduce visits top-down — both get correct results from cache).
 */
async function asyncFLMap(fn: (v: unknown) => unknown, structure: FantasyLand): Promise<unknown> {
  const values = flCollectValues(structure);
  const cache = new Map<unknown, unknown>();
  await Promise.all(
    values.map(async (v) => {
      if (!cache.has(v)) {
        cache.set(v, unwrapLipsValue(await fn(v)));
      }
    }),
  );
  return structure["fantasy-land/map"]((v: unknown) => cache.get(v));
}

// Box-PRESERVING map twin of asyncFLMap — for OUR OWN containers (a LIPS Pair), which
// are NOT crossing out to a foreign Functor, so their element boxes (SchemeString /
// SchemeExact) and provenance sets must survive. The ONLY difference from asyncFLMap is
// that the cache stores the RAW `await fn(v)` result instead of `unwrapLipsValue(...)`:
// asyncFLMap strips boxes (external FL structures want raw JS values — pinned GOLDEN by
// coercion-soundness's SchemeVector case), but a Pair mapped here reproduces the eager
// scheme `map` builtin's box-preserving `Pair.fromArray(results)` semantics. Same
// value-identity cache as asyncFLMap (FL visit-order independence — all `cache.has`
// checks run before any `await` populates it, so no fn-call dedup is observable), same
// rebuild via the structure's own `fantasy-land/map` (mapPair builds a fresh spine,
// dropping the container box exactly as the eager builtin does — stratum-2 parity).
async function asyncArrivalMap(fn: (v: unknown) => unknown, structure: FantasyLand): Promise<unknown> {
  const values = flCollectValues(structure);
  const cache = new Map<unknown, unknown>();
  await Promise.all(
    values.map(async (v) => {
      if (!cache.has(v)) {
        cache.set(v, await fn(v)); // RAW result — NO unwrapLipsValue (preserve element box + provenance)
      }
    }),
  );
  return structure["fantasy-land/map"]((v: unknown) => cache.get(v));
}

async function asyncFLFilter(arg: ((v: unknown) => unknown) | RegExp, structure: FantasyLand): Promise<unknown> {
  // Adapt a regex arg the same way the eager builtin's `matcher` does (regex →
  // `String(x).match(arg)`, a fn passes through). `String(x)` sees the same raw
  // boxed element `flCollectValues` collects as `listToArray` fed the builtin.
  const pred = arg instanceof RegExp ? (x: unknown) => String(x).match(arg) : arg;
  const values = flCollectValues(structure);
  const cache = new Map<unknown, unknown>();
  await Promise.all(
    values.map(async (v) => {
      if (!cache.has(v)) {
        cache.set(v, await pred(v));
      }
    }),
  );
  // Canonical keep-rule — IDENTICAL to the eager scheme `filter` builtin: Scheme-truthy
  // (`!is_false`) AND nil dropped (`!is_nil`, arrival's nil-as-false rule for a #f/void/nil
  // predicate result). FL `filterPair` is JS-truthy on the predicate, so it gets a Boolean.
  return structure["fantasy-land/filter"]((v: unknown) => !is_false(cache.get(v)) && !is_nil(cache.get(v)));
}

// Arrival-convention async fold — the SCHEME/SRFI fold `fn(element, acc)` (element
// FIRST), left fold, head-to-tail.
// This is the async-aware twin of the term's `arrival/tagless-final/reduce` method:
// LIPS lambdas return Promises while the FL Foldable is sync, so we collect the
// elements (same traversal order fantasy-land/reduce visits them) then thread the
// accumulator sequentially with `await`. Reproduces the eager scheme `reduce` builtin
// EXACTLY — `(reduce - 100 '(1 2 3 4 5))` = 1-(...)=-97 — so a Pair list folds in
// scheme convention through the overlay, not the FL acc-first convention.
async function asyncArrivalReduce(
  fn: (acc: unknown, val: unknown) => unknown,
  init: unknown,
  structure: FantasyLand,
): Promise<unknown> {
  const values = flCollectValues(structure);
  let acc = init;
  for (const element of values) {
    // element FIRST (scheme convention), acc threaded.
    acc = await fn(element, acc);
  }
  return acc;
}

// ── LazySeq egress ────────────────────────────────────────────────────────────
// reduce is a full-egress observation (no `Observation` of its own in the first
// cut): force the plan with `iterate`, rebuild a Scheme list, and DELEGATE to the
// captured base `reduce`. Delegating (not re-folding by hand) keeps lazy reduce
// observationally identical to eager — same fold direction, same provenance
// propagation — BY CONSTRUCTION. A hand-rolled left-fold here silently disagreed
// with the base reduce's right-fold for non-commutative reducers (caught by the
// confluence battery): the lazy plane must defer to the real op, never re-derive it.
async function reduceLazySeq(
  fn: (acc: unknown, val: unknown) => unknown,
  init: unknown,
  ls: LazySeq,
): Promise<unknown> {
  const { items } = (await ls.refine({ kind: "iterate" })) as { items: readonly unknown[] };
  return builtinReduce!(fn, init, Pair.fromArray([...items], false));
}

// Materialize a collection's elements — a LIPS pair spine, a SchemeVector, a lazy
// SchemeJSArray wrapper, or a raw JS array — to a flat element array. Shared by
// `length` and the `lazy-seq` constructor so both see the same element set. As
// lenient as the old length: an unrecognized input yields `[]` (an empty collection).
//
// G6 (carrier-coercion soundness): the SchemeVector branch mirrors its twin
// `collapseProvenance` (provenance-collapse.ts), which already deep-walks
// `__vector__`. Without it a SchemeVector matched none of the branches and
// silently collected `[]` — so `(length vec)` counted 0 and `(lazy-seq vec)` held
// an empty plan, dropping every element's provenance with no error.
function collectElements(collection: any): unknown[] {
  const elements: unknown[] = [];
  if (collection && typeof collection === "object" && "car" in collection) {
    let current = collection; // LIPS list — walk the spine.
    while (current?.constructor && current.constructor.name !== "Nil") {
      elements.push(current.car);
      current = current.cdr;
    }
  } else if (collection instanceof SchemeVector) {
    elements.push(...collection.__vector__); // boxed vector — its elements carry provenance
  } else if (collection instanceof SchemeJSArray) {
    elements.push(...collection.source); // lazy JS-array wrapper from `@`/membrane
  } else if (Array.isArray(collection)) {
    elements.push(...collection);
  }
  return elements;
}

// A18d — un-forced egress is a programmer error (LazySeq.ts header). An accessor
// the first cut hasn't taught to force a LazySeq throws LOUD here, never returns a
// silent nil/empty. The lazy plane is map/filter (extend) → length/iterate/reduce
// (force); everything else forces explicitly or waits for a later slice.
function unforcedLazyEgress(op: string): never {
  throw new Error(
    `\`${op}\` received an un-forced lazy-seq — the first cut supports map/filter then ` +
      `length/iterate/reduce only. Force it to a list before \`${op}\` (a later slice may teach it to force).`,
  );
}

// ── The interop overlay symbols ──────────────────────────────────────────────

export const FL_INTEROP_OPS = {
  // SchemeJSArray-aware car/cdr — unwrap lazy array wrappers; a Pair computes on the term (arrival/tagless-final/car)
  car: (list: unknown) => {
    captureBuiltins();
    if (is_lazy_seq(list)) unforcedLazyEgress("car"); // A18d (builtinCar would throw a less clear error)
    if (list instanceof Pair) return list["arrival/tagless-final/car"](); // compute-by-fl: element projection on the term
    return list instanceof SchemeJSArray ? list.at(0) : builtinCar!(list);
  },
  cdr: (list: unknown) => {
    captureBuiltins();
    if (is_lazy_seq(list)) unforcedLazyEgress("cdr");
    if (list instanceof Pair) return list["arrival/tagless-final/cdr"](); // compute-by-fl: tail projection on the term
    return list instanceof SchemeJSArray
      ? list.length <= 1
        ? nil
        : new SchemeJSArray(list.source.slice(1))
      : builtinCdr!(list);
  },
  // FL-dispatch: any FL entity — INCLUDING a LIPS Pair (filterPair preserves spine
  // order; the coercion-soundness suite pins per-element-box order) — computes by its
  // own fantasy-land/filter, so this no longer reaches the env-resolved scheme builtin.
  // (map/reduce below still route Pairs to the builtin — only filter is flipped here.)
  // LIPS lambdas are async; FL methods are sync. asyncFL* bridges this gap.
  filter: function filter(this: unknown, arg: ((v: unknown) => unknown) | RegExp, list: unknown) {
    captureBuiltins();
    // Nil-tolerant: a `(first? …)`/`(if …)` that yielded #f or void flowing into a
    // filter resolves to the empty list, not a crash — so a multi-leaf proof can still
    // ground its OTHER leaves instead of losing the whole program to one absent read.
    // (Matches the `@` accessor, which already returns nil for a null object. nil/'()
    // is NOT caught here — it passes through to builtinFilter as a valid empty list.)
    if (list == null || is_false(list)) return nil;
    // Empty/nil list → nil, like the eager builtin. asyncFLFilter on a Nil (which
    // lacks fantasy-land/filter) would misbehave, so guard it before the FL route.
    if (is_nil(list)) return nil;
    // LazySeq fast-path — BEFORE the FL/asyncFL collect: extend the plan, run
    // nothing. The Scheme-truthiness adaptation (await + is_false) lives here, at
    // the interop boundary, so the carrier stays a generic async-aware pipe. A regex
    // arg never reaches a LazySeq in practice; cast to the fn form for the await.
    if (is_lazy_seq(list)) return list.filter(async (x: unknown) => !is_false(await (arg as (v: unknown) => unknown)(x)));
    // FL-dispatch — NOW INCLUDING LIPS Pairs. A Pair implements fantasy-land/filter
    // (filterPair walks the spine, preserving element boxes), so it computes by FL
    // here instead of reaching the env-resolved scheme builtin. asyncFLFilter applies
    // the canonical keep-rule and adapts a regex arg, so this is byte-identical to the
    // eager builtin's VALUE semantics (the heap-meter charge listToArray did is the one
    // resource-accounting difference; no value-level behavior changes).
    if (
      list &&
      typeof list === "object" &&
      (list as Partial<FantasyLand>)["fantasy-land/filter"]
    ) {
      return asyncFLFilter(arg, list as FantasyLand);
    }
    // Final fallback — any input that implements neither LazySeq nor fantasy-land/filter.
    return builtinFilter!.call(this, arg, list);
  },
  map: function map(this: unknown, fn: (v: unknown) => unknown, ...lists: unknown[]) {
    captureBuiltins();
    if (lists.length === 1 && (lists[0] == null || is_false(lists[0]))) return nil; // nil-tolerant (see filter)
    // LazySeq fast-path — extend the plan, run nothing (a pure map mints no
    // provenance of its own, so its op-prov is empty; the source's grouping
    // provenance and the elements' provenance ride the carrier).
    if (lists.length === 1 && is_lazy_seq(lists[0])) return lists[0].map(fn);
    // FL-dispatch — NOW INCLUDING a single-list LIPS Pair, which computes by its OWN
    // fantasy-land/map (mapPair) here instead of reaching the env-resolved scheme builtin
    // (mirrors filter/reduce). asyncArrivalMap is the box-PRESERVING twin (no unwrapLipsValue),
    // so per-element boxes + provenance survive — byte-identical to the eager builtin's
    // `Pair.fromArray(results)` (coercion-soundness "Pair · map preserves every element's
    // box"; lineage A13/A18b carry every element's provenance through map). A multi-list map
    // (lists.length > 1) is a ZIP, not a Functor op, so it stays on builtinMap below.
    if (lists.length === 1 && lists[0] instanceof Pair) {
      return asyncArrivalMap(fn, lists[0] as unknown as FantasyLand);
    }
    // External single-list FL entity (non-Pair: a SchemeVector, a foreign Functor) — it IS
    // crossing out, so asyncFLMap's unwrapLipsValue strips boxes to raw JS values (the DR4
    // box-strip, pinned GOLDEN for SchemeVector). UNCHANGED.
    if (
      lists.length === 1 &&
      !(lists[0] instanceof Pair) &&
      (lists[0] as Partial<FantasyLand> | undefined)?.["fantasy-land/map"]
    ) {
      return asyncFLMap(fn, lists[0] as FantasyLand);
    }
    // Fallback — multi-list (zip), or a non-FL input (a SchemeJSArray: builtinMap
    // typechecks pair|nil and THROWS, the coercion-soundness pin).
    return builtinMap!.call(this, fn, ...lists);
  },
  reduce: function reduce(
    this: unknown,
    fn: (acc: unknown, val: unknown) => unknown,
    init: unknown,
    collection: unknown,
  ) {
    captureBuiltins();
    if (is_lazy_seq(collection)) return reduceLazySeq(fn, init, collection); // force the plan, fold eager
    // FL-Foldable dispatch — NOW INCLUDING LIPS Pairs — folds in ARRIVAL/SCHEME
    // convention (`fn(element, acc)`, element first), the opposite of the FL Foldable's
    // own acc-first order. A Pair carries `arrival/tagless-final/reduce` (Pair.ts) which
    // is exactly `fantasy-land/reduce` with the args swapped; rather than re-fold by hand
    // we run that same element-first fold async-aware here (asyncArrivalReduce), so the
    // overlay reduce over a Pair is byte-identical to the eager scheme `reduce` builtin —
    // `(reduce - 100 '(1 2 3 4 5))` = -97, NOT the FL acc-first 85. Routing on
    // `fantasy-land/reduce` keeps the branch total over every arrival Foldable (Pair +
    // SchemeVector); the `arrival/tagless-final/reduce` carrier names the convention on
    // the term. A SchemeJSArray has neither method, so it still falls through to
    // builtinReduce, whose pair|nil typecheck throws (the coercion-soundness DR4 pin).
    if (
      collection &&
      typeof collection === "object" &&
      ((collection as Partial<ArrivalFoldable>)["arrival/tagless-final/reduce"] ||
        (collection as Partial<FantasyLand>)["fantasy-land/reduce"])
    ) {
      return asyncArrivalReduce(fn, init, collection as FantasyLand);
    }
    // Fallback — neither LazySeq nor an FL/arrival Foldable (a SchemeJSArray, a raw
    // input). builtinReduce typechecks pair|nil and folds (or throws for a non-list).
    return builtinReduce!.call(this, fn, init, collection);
  },

  // ── Nil-tolerant comparisons (plane-local) ──────────────────────────────────
  // The operator membrane rejects a nil operand at codec-match time (the `=`/`<`/…
  // Operators declare `in: [SchemeNum]`), so a comparison against an absent value
  // (a nil PID, an unmatched lookup) throws before the body runs — forcing models
  // to write defensive `(if (nil? x) … (= x …))` guards. Completing the plane's
  // existing nil-tolerance grain (see filter/map): a nil operand resolves the
  // comparison to #f rather than crashing the proof. Non-nil NUMBER operands compute
  // by-value via their `fantasy-land/lte` (numericChain — no env-read, byte-identical
  // to the =/</>/<=/>= Operators incl. NaN/cross-type); a non-number (or arity-0) operand
  // falls back to the kept bridged builtin, which is that Operator (identical throw).
  "=": function numEq(...args: unknown[]) {
    if (args.some(isNilOperand)) return false;
    if (args.length >= 1 && args.every(isNumberOperand)) return numericCompare("=", args);
    captureBuiltins();
    return builtinNumEq!(...args);
  },
  "<": function lt(...args: unknown[]) {
    if (args.some(isNilOperand)) return false;
    if (args.length >= 1 && args.every(isNumberOperand)) return numericCompare("<", args);
    captureBuiltins();
    return builtinLt!(...args);
  },
  ">": function gt(...args: unknown[]) {
    if (args.some(isNilOperand)) return false;
    if (args.length >= 1 && args.every(isNumberOperand)) return numericCompare(">", args);
    captureBuiltins();
    return builtinGt!(...args);
  },
  "<=": function lte(...args: unknown[]) {
    if (args.some(isNilOperand)) return false;
    if (args.length >= 1 && args.every(isNumberOperand)) return numericCompare("<=", args);
    captureBuiltins();
    return builtinLte!(...args);
  },
  ">=": function gte(...args: unknown[]) {
    if (args.some(isNilOperand)) return false;
    if (args.length >= 1 && args.every(isNumberOperand)) return numericCompare(">=", args);
    captureBuiltins();
    return builtinGte!(...args);
  },

  // ── Array-aware list accessors ───────────────────────────────────────────────
  // Nil-tolerant accessors that work over both JS arrays (what `@`/SchemeJSArray
  // hand the inference plane) and LIPS pairs. Self-contained — no builtin capture.

  // ── List aliases (models expect these) ──
  // Each guards against an un-forced lazy-seq (A18d): without it these silently
  // return nil for a LazySeq (no `.car`, not an array), masking the misuse.
  first: (list: any) => {
    if (is_lazy_seq(list)) unforcedLazyEgress("first");
    return list?.car ?? (Array.isArray(list) ? list[0] : nil);
  },
  last: (list: any) => {
    if (is_lazy_seq(list)) unforcedLazyEgress("last");
    if (Array.isArray(list)) return list.at(-1) ?? nil;
    let current = list;
    while (current?.cdr?.constructor?.name !== "Nil" && current?.cdr != null) {
      current = current.cdr;
    }
    return current?.car ?? nil;
  },
  second: (list: any) => {
    if (is_lazy_seq(list)) unforcedLazyEgress("second");
    return list?.cdr?.car ?? (Array.isArray(list) ? list[1] : nil);
  },
  third: (list: any) => {
    if (is_lazy_seq(list)) unforcedLazyEgress("third");
    return list?.cdr?.cdr?.car ?? (Array.isArray(list) ? list[2] : nil);
  },

  // ── Association lists ──
  assoc: (key: any, alist: any) => {
    if (is_lazy_seq(alist)) unforcedLazyEgress("assoc");
    if (!alist) return nil;
    const items = Array.isArray(alist) ? alist : [];
    // Convert LIPS pairs to traversable
    if (!Array.isArray(alist) && alist?.car) {
      let current = alist;
      while (current?.car) {
        const pair = current.car;
        if (pair?.car?.valueOf?.() === key?.valueOf?.() || pair?.car === key) return pair;
        current = current.cdr;
      }
      return nil;
    }
    return items.find((pair: any) => pair?.[0] === key || pair?.car === key) ?? nil;
  },

  // ── Sort ──
  sort: (list: any, comparator?: any) => {
    if (is_lazy_seq(list)) unforcedLazyEgress("sort");
    const arr = Array.isArray(list) ? [...list] : [];
    if (!Array.isArray(list) && list?.car) {
      let current = list;
      while (current?.car) {
        arr.push(current.car);
        current = current.cdr;
      }
    }
    if (comparator) {
      arr.sort((a: any, b: any) => comparator(a, b));
    } else {
      arr.sort();
    }
    // Return a Scheme LIST, not a raw JS array — a Lisp `sort` whose result the sibling
    // `map`/`filter` reject ("Expecting pair or nil, got array") is an inconsistency. The elements
    // are already Scheme values (we just reordered them), so build the list shallow (no re-boxing);
    // an empty result is nil.
    return Pair.fromArray(arr, false);
  },

  length: (collection: any) => {
    // LazySeq fast-path — the demand cone IS the provenance cone: refine under a
    // `length` observation runs only the ops the count depends on (a pure-map
    // chain runs NOTHING — `(length (map f xs))` never touches f) and stamps the
    // minimal cone from the same walk. Returns a Promise only here; the eager
    // path below stays sync and byte-identical (the speculate discipline).
    if (is_lazy_seq(collection)) {
      return collection.refine({ kind: "length" }).then((r) => {
        const { count, provenance } = r as { count: number; provenance: ReadonlySet<number> };
        return provenance.size === 0 ? count : AValue.fromJs(count, provenance);
      });
    }
    // Collect elements so the count can carry their provenance (V: "provenance
    // everything; exclusion should not be possible in teleological mode"). A
    // `(count …)`/`(length …)` the seal can't sign — even though every row that
    // produced it was grounded — is exactly the hole the teleological seal forbids.
    const elements = collectElements(collection);
    const count = elements.length;
    const inputs = elements.filter((e): e is AValue => e instanceof AValue);
    if (inputs.length === 0) return count;
    const prov = unionProvenance(inputs);
    return prov.size === 0 ? count : AValue.fromJs(count, prov);
  },

  // A18c — the scheme-surface entry into the lazy plane. `(lazy-seq xs)` wraps a
  // collection's elements into an un-run plan; `map`/`filter` then EXTEND it and
  // `length`/`reduce`/iterate FORCE it. The collection's own provenance is the
  // grouping fact (cheap, eager); per-element provenance rides the elements and
  // is distributed only on materialization. Conservative by design: laziness is
  // opt-in, so a plain Pair stays eager and byte-identical (the speculate
  // discipline) — flipping map's default to lazy is a separate, deliberate call.
  "lazy-seq": (collection: any) =>
    new LazySeq(
      collectElements(collection),
      [],
      collection instanceof AValue ? collection.provenance : EMPTY_PROVENANCE,
    ),
};

export default new EnvCapability("scheme/fl-interop", {
  symbols: Object.fromEntries(Object.entries(FL_INTEROP_OPS).map(([k, v]) => [k, { value: v }])),
});
