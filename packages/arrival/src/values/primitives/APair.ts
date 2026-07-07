/**
 * The cons cell. Beyond car/cdr, a Pair carries its own metadata — source
 * location, datum-label/cycle marks, provenance — on the instance (symbol-keyed),
 * not in a sidecar map, so a value and its origin travel together and survive
 * structure sharing. Runtime cycles (from `set-cdr!`) are detected actively by
 * `isCircularList` (Floyd's), which keeps spine-walking builtins from spinning.
 * The class is an interop boundary (see the bottom of the file).
 *
 * Lineage: a cons-list is the free monoid over its elements; the Fantasy Land
 * instances below (Functor/Foldable/Traversable/Chain/Monoid/Semigroup —
 * fantasyland/fantasy-land) make that algebra explicit. The `Thunk`/trampoline
 * is trampolined style (Ganz, Friedman & Wand, "Trampolined Style", ICFP 1999);
 * cycle detection is Floyd's tortoise-and-hare.
 */
import { CLASS, CYCLES, DATA, LOCATION, REF } from "../../well-known-symbols.js";
import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import { applyCallback } from "./ACallable.js";
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE, unionProvenance } from "./AValue.js";
import { fromJs } from "./boxing.js";
import { deriveSortCompare, withInputProvenance } from "../op-helpers.js";
import { type SeenMap, structuralEqual } from "../structural-equal.js";
import { type SourceLocation } from "../../errors.js";
import { is_false, is_plain_object } from "../value-guards.js";
import { is_promise } from "../../eval/guards.js";
import { promise_all } from "../../utils/promises.js";
import { AHalfBaked } from "./AHalfBaked.js";
import { type AList, type APairLike, type SchemeValue } from "../types.js";
import { AString } from "./AString.js";
import { ASymbol } from "./ASymbol.js";
import { AExact } from "./AExact.js";
import { AInexact } from "./AInexact.js";
import { INTEROP_BOUNDARY } from "../../interop-access.js";
import { ANil, nil } from "./ANil.js";
import { printValue } from "../print.js";
import { chargeHeap } from "../../heap-budget.js";
import { tf } from "../tagless-final.js";

// Trampoline thunk: `mark_cycles` walks arbitrarily deep lists, so it bounces
// through these instead of recursing and overflowing the native stack.
class Thunk {
  constructor(
    public readonly fn: () => Thunk | void,
    public readonly cont: () => void = () => {},
  ) {}

  toString(): string {
    return "#<Thunk>";
  }
}

const trampoline =
  (fn: (pair: SchemeValue, parents: APair<any, any>[]) => Thunk | void) =>
  (pair: SchemeValue, parents: APair<any, any>[]) => {
    let result = fn(pair, parents);
    while (result instanceof Thunk) {
      const thunk = result;
      result = result.fn();
      if (!(result instanceof Thunk)) {
        thunk.cont();
      }
    }
  };

/**
 * Floyd's tortoise/hare cycle detection on the cdr-spine. O(n) time, O(1) space.
 * Returns true iff the list is CIRCULAR (a cdr eventually revisits a node).
 *
 * Unlike `have_cycles()` (a metadata read populated only by the reader for `#0=`
 * datum labels), this ACTIVELY detects cycles created at runtime by `set-cdr!` —
 * the gap behind the list?/length/append/memq/reverse/list-copy non-termination.
 * Spine-walking builtins guard on this so a circular list terminates (list? → #f)
 * or raises a clean error instead of spinning. Never throws; the caller decides
 * what a cycle means.
 */
export function isCircularList(head: unknown): boolean {
  let slow: unknown = head;
  let fast: unknown = head;
  while (fast instanceof APair && fast.cdr instanceof APair) {
    slow = (slow as APair<any, any>).cdr;
    fast = fast.cdr.cdr;
    if (slow === fast) return true;
  }
  return false;
}

function is_cycle(pair: unknown): boolean {
  if (!(pair instanceof APair)) {
    return false;
  }
  if (pair.have_cycles()) {
    return true;
  }
  return is_cycle(pair.car) || is_cycle(pair.cdr);
}

// ----------------------------------------------------------------------
function mark_cycles(pair: APair<any, any>): void {
  const seen_pairs: APair<any, any>[] = [];
  const cycles: APair<any, any>[] = [];
  const refs: APair<any, any>[] = [];

  function visit(pair: APair<any, any>): void {
    if (!seen_pairs.includes(pair)) {
      seen_pairs.push(pair);
    }
  }

  function set(node: APair<any, any>, type: "car" | "cdr", child: unknown, parents: APair<any, any>[]): boolean {
    if (child instanceof APair && parents.includes(child)) {
      if (!refs.includes(child)) {
        refs.push(child);
      }
      if (!node[CYCLES]) {
        node[CYCLES] = {};
      }
      node[CYCLES][type] = child;
      if (!cycles.includes(node)) {
        cycles.push(node);
      }
      return true;
    }
    return false;
  }

  const detect = trampoline(function detect_thunk(pair: SchemeValue, parents: APair<any, any>[]): Thunk | void {
    if (pair instanceof APair) {
      const pairWithCycles = pair;
      delete pairWithCycles[REF];
      delete pairWithCycles[CYCLES];
      visit(pair);
      parents.push(pair);
      const car = set(pairWithCycles, "car", pair.car, parents);
      const cdr = set(pairWithCycles, "cdr", pair.cdr, parents);
      if (!car) {
        detect(pair.car, [...parents]);
      }
      if (!cdr) {
        return new Thunk(() => {
          return detect_thunk(pair.cdr, [...parents]);
        });
      }
    }
  });

  function mark_node(node: APair<any, any>, type: "car" | "cdr"): void {
    const cycleData = node[CYCLES];
    if (cycleData && cycleData[type] instanceof APair) {
      const count = ref_nodes.indexOf(cycleData[type]);
      cycleData[type] = `#${count}#`;
    }
  }

  detect(pair, []);
  const ref_nodes = seen_pairs.filter((node) => refs.includes(node));
  for (const [i, node] of ref_nodes.entries()) {
    node[REF] = `#${i}=`;
  }
  for (const node of cycles) {
    mark_node(node, "car");
    mark_node(node, "cdr");
  }
}

/**
 * INTERNAL knot-tying door — the ONE mutation path through APair's readonly slots. A cycle
 * cannot be constructed immutably (a self-referential spine has no construction order), so the
 * three knot-tying consumers — `clone` (this file), the reader's datum-label resolution
 * (`Parser._resolve_pair`), and syntax-rules' ellipsis surgery on its private copies — patch
 * through HERE, each use a named reviewable act (the `installHeapMeter` pattern: one designed
 * door, never ad-hoc mutation). The ugly name IS the fence; not exported from the package index.
 */
export function __tieKnot(pair: APair<any, any>, slot: "car" | "cdr", v: SchemeValue): void {
  (pair as unknown as { car: SchemeValue; cdr: SchemeValue })[slot] = v;
}

type APairValue<P extends SchemeValue> = P extends APair<infer Car, infer Cdr> ? Car | APairValue<Cdr> : never;

export class APair<Car extends SchemeValue, Cdr extends SchemeValue> extends AValue implements APairLike<Car, Cdr> {
  // Interop boundary: a cons cell's rich prototype (match/fromArray/toArray, the cycle/ref
  // helpers) and metadata symbols (__data__/__location__) are otherwise reachable from any held
  // Pair via symbol-to-field auto-resolution — the ref-tracking helpers especially would leak
  // host-side identity comparisons. This marker stops the prototype walk at Pair.
  static [INTEROP_BOUNDARY] = true;
  static [CLASS] = "pair";
  readonly kind = "pair" as const;
  [DATA]?: boolean;
  [LOCATION]?: SourceLocation;
  [CYCLES]?: { car?: string | APair<any, any>; cdr?: string | APair<any, any> };
  [REF]?: string;

  constructor(
    ctx: RunContext,
    public readonly car: Car,
    public readonly cdr: Cdr,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(ctx, provenance);
  }

  // Static methods
  static match(obj: unknown, item: string | RegExp | ASymbol): boolean {
    if (obj instanceof ASymbol) {
      return ASymbol.is(obj, item);
    } else if (obj instanceof APair) {
      return APair.match(obj.car, item) || APair.match(obj.cdr, item);
    } else if (Array.isArray(obj)) {
      return obj.some((x) => APair.match(x, item));
    } else if (is_plain_object(obj)) {
      return Object.values(obj).some((x) => APair.match(x, item));
    }
    return false;
  }

  // Return is precise on `quote`: the `unknown[]` arm is reachable ONLY via the pass-through
  // of an already-`DATA`-marked array, which is gated behind `quote`. So `quote` omitted/false
  // ⟹ `APair | ANil` (build path, or pass-through of an already-pair input); `quote: true` ⟹
  // the data-array can also flow back untouched. This lets every build-path caller drop the
  // historical `as APair | ANil` cast honestly — the narrow type is the real one, not a widen.
  static fromArray(ctx: RunContext, array: unknown, deep?: boolean, quote?: false): AList;
  static fromArray(ctx: RunContext, array: unknown, deep: boolean, quote: true): AList | unknown[];
  // `quote` not known statically (the internal recursion threads the runtime flag): can't promise
  // the data-array won't flow back, so the return stays wide. No external caller hits this arm.
  static fromArray(ctx: RunContext, array: unknown, deep: boolean, quote: boolean): AList | unknown[];
  static fromArray(ctx: RunContext, array: unknown, deep = true, quote = false): AList | unknown[] {
    if (
      array instanceof APair ||
      (quote && Array.isArray(array) && (array as unknown as { [key: symbol]: unknown })[DATA])
    ) {
      return array as APair<any, any> | unknown[];
    }
    const arr = Array.isArray(array) ? array : [...(array as Iterable<unknown>)];
    if (deep === false) {
      let list: AList = nil;
      for (let i = arr.length; i--; ) {
        list = new APair(ctx, arr[i], list);
      }
      return list;
    }
    let result: AList = nil;
    let i = arr.length;
    while (i--) {
      let car: unknown = arr[i];
      if (Array.isArray(car)) {
        car = APair.fromArray(ctx, car, deep, quote);
      } else if (typeof car === "string") {
        car = new AString(ctx, car);
      } else if (typeof car === "number" && !Number.isNaN(car)) {
        car = Number.isSafeInteger(car) ? new AExact(ctx, BigInt(car)) : new AInexact(ctx, car);
      } else if (typeof car === "bigint") {
        car = new AExact(ctx, car);
      }
      result = new APair(ctx, car as SchemeValue, result);
    }
    return result;
  }

  static fromPairs(ctx: RunContext, array: [string, unknown][]): AList {
    return array.reduce<AList>((list, pair) => {
      return new APair(ctx, new APair(ctx, new ASymbol(ctx, pair[0]), pair[1] as SchemeValue), list);
    }, nil);
  }

  static fromObject(ctx: RunContext, obj: Record<string, unknown>): AList {
    const array = Object.keys(obj).map((key) => [key, obj[key]] as [string, unknown]);
    return APair.fromPairs(ctx, array);
  }

  // Monoid — the empty list is the identity for list-concat.
  static ["arrival/tagless-final/empty"](): ANil {
    return nil;
  }

  // Applicative — single-element list.
  static ["arrival/tagless-final/of"](value: SchemeValue): APair<any, any> {
    return new APair(CONSTANT_CTX, value, nil);
  }

  /** Returns this for chaining. */
  setLocation(loc: SourceLocation): this {
    this[LOCATION] = loc;
    return this;
  }

  getLocation(): SourceLocation | undefined {
    return this[LOCATION];
  }

  // Instance methods
  flatten(): AList | unknown[] {
    return APair.fromArray(this.ctx, this.to_array().flat(Infinity));
  }

  length(): number {
    let len = 0;
    let node: APair<any, any> | unknown = this;
    while (true) {
      if (!node || node instanceof ANil || !(node instanceof APair) || node.have_cycles("cdr")) {
        break;
      }
      len++;
      node = node.cdr;
    }
    return len;
  }

  find(item: string | RegExp | ASymbol): boolean {
    return APair.match(this, item);
  }

  clone(deep = true): APair<any, any> {
    const visited = new Map<APair<any, any>, APair<any, any>>();
    const selfCtx = this.ctx;

    function cloneNode<T extends SchemeValue>(node: T): T {
      if (node instanceof APair) {
        if (visited.has(node)) {
          return visited.get(node) as T;
        }
        // Register BEFORE descending (a cycle resolves to this very clone), built with the
        // ORIGINAL slots as placeholders so the readonly contract holds at construction; the
        // knot door then overwrites with the cloned sub-spines.
        const pair = new APair(selfCtx, node.car, node.cdr);
        visited.set(node, pair);
        __tieKnot(pair, "car", (deep ? cloneNode(node.car) : node.car) as SchemeValue);
        __tieKnot(pair, "cdr", cloneNode(node.cdr) as SchemeValue);
        pair[CYCLES] = node[CYCLES];
        return pair as T;
      }
      return node;
    }

    return cloneNode(this) as APair<any, any>;
  }

  last_pair(): APair<any, any> | undefined {
    let node: APair<any, any> = this;
    while (true) {
      if (!(node.cdr instanceof APair)) {
        return node;
      }
      if (node.have_cycles("cdr")) {
        break;
      }
      node = node.cdr;
    }
  }

  to_array(deep = true): APairValue<Car | Cdr>[] {
    // A circular list can't be materialized to a finite array — the recursion on
    // `this.cdr` below would stack-overflow. `isCircularList` (Floyd's) is needed
    // here because `have_cycles()` misses runtime `set-cdr!` cycles.
    invariant(!isCircularList(this), "cannot convert a circular list to an array");
    let result: unknown[] = [];
    if (this.car instanceof APair) {
      if (deep) {
        result.push(this.car.to_array());
      } else {
        result.push(this.car);
      }
    } else {
      const car = this.car;
      // deep=false (vector literals) preserves Scheme values as-is. deep=true calls valueOf()
      // to reach JS primitives, EXCEPT ASymbol/AString/AExact/AInexact — those stay wrapped
      // even in deep mode since they're still Scheme values downstream code expects boxed.
      if (deep && car !== null && car !== undefined && typeof car === "object" && "valueOf" in car) {
        if (car instanceof ASymbol || car instanceof AString || car instanceof AExact || car instanceof AInexact) {
          result.push(car);
        } else {
          result.push((car as { valueOf(): unknown }).valueOf());
        }
      } else {
        result.push(car);
      }
    }
    if (this.cdr instanceof APair) {
      result = [...result, ...this.cdr.to_array(deep)];
    }
    return result;
  }

  reduce<T>(fn: (acc: T | ANil, val: unknown) => T): T | ANil {
    let node: APair<any, any> | unknown = this;
    let result: T | ANil = nil;
    while (true) {
      if (node instanceof ANil) {
        break;
      } else if (node instanceof APair) {
        result = fn(result, node.car);
        node = node.cdr;
      } else {
        break;
      }
    }
    return result;
  }

  transform(fn: (val: SchemeValue) => SchemeValue): APair<any, any> {
    // todo visited is unused - review
    const visited: APair<any, any>[] = [];
    const selfCtx = this.ctx;

    function recur(pair: SchemeValue): SchemeValue {
      if (pair instanceof APair) {
        if ((pair as APair<any, any> & { replace?: boolean }).replace) {
          delete (pair as APair<any, any> & { replace?: boolean }).replace;
          return pair;
        }
        let car = fn(pair.car);
        if (car instanceof APair) {
          car = recur(car);
          visited.push(car as APair<any, any>);
        }
        let cdr = fn(pair.cdr);
        if (cdr instanceof APair) {
          cdr = recur(cdr);
          visited.push(cdr as APair<any, any>);
        }
        return new APair(selfCtx, car, cdr);
      }
      return pair;
    }

    return recur(this) as APair<any, any>;
  }

  map(fn: (val: SchemeValue) => SchemeValue): AList {
    return this.car === undefined
      ? nil
      : new APair(this.ctx, fn(this.car), this.cdr instanceof ANil ? nil : (this.cdr as APair<any, any>).map(fn));
  }

  mark_cycles(): this {
    mark_cycles(this);
    return this;
  }

  have_cycles(name: "car" | "cdr" | null = null): boolean {
    if (!name) {
      return this.have_cycles("car") || this.have_cycles("cdr");
    }
    return !!this[CYCLES]?.[name];
  }

  is_cycle(): boolean {
    return is_cycle(this);
  }

  // Print protocol: `toString` delegates to `arrival/print`, the SOLE pair renderer (the old
  // local `stringifyValue` duplicate + its `quote`/`nested` params are gone — a write-mode form,
  // if a REPL ever needs one, belongs on the shared `printValue(v, { write })`, not here).
  // `arrival/print` calls `mark_cycles()` first, then walks the cdr-chain emitting the LIST repr
  // `(elem …)` / `(a . b)`, each element via `printValue`. Cyclic repr is a known gap.
  toString(): string {
    return this["arrival/print"]();
  }

  ["arrival/print"](): string {
    this.mark_cycles();
    const parts: string[] = [];

    if (this[REF]) {
      parts.push(`${this[REF]}(`);
    } else {
      parts.push("(");
    }

    let node: APair<any, any> = this;
    let first = true;

    while (node instanceof APair) {
      if (!first) {
        if (node[REF]) {
          parts.push(" . ", printValue(node));
          node = nil as unknown as APair<any, any>;
          continue;
        }
        parts.push(" ");
      }
      first = false;

      const carValue = node[CYCLES]?.car ?? printValue(node.car);
      if (carValue !== undefined) {
        parts.push(String(carValue));
      }

      if (node[CYCLES]?.cdr) {
        parts.push(" . ", String(node[CYCLES].cdr));
        break;
      }

      node = node.cdr as APair<any, any>;
    }

    if (!(node instanceof ANil) && !(node instanceof APair)) {
      parts.push(" . ", printValue(node));
    }

    parts.push(")");
    return parts.join("");
  }

  serialize(): [unknown, unknown] {
    return [this.car, this.cdr];
  }

  ["arrival/toJS"](): unknown {
    // Target is cache/log/HTTP JSON, none of which can represent cycles (unlike `toString`,
    // which emits `#0=`/`#0#` ref markers since s-expression text supports that notation).
    // Loud-fail rather than hand back a value that explodes downstream or hangs forever below.
    invariant(!this.have_cycles(), "Pair.toJs: cannot serialize a list with cycles");
    // Belt-and-suspenders against cycles introduced post-check via mutation (e.g. a nested
    // Pair's car mutated by a side-effecting toJs override). Cheap — one Set add per pair.
    const seen = new Set<APair<any, any>>();
    const list: unknown[] = [];
    let node: unknown = this;
    while (true) {
      switch (true) {
        case node instanceof ANil:
          return list;
        case node instanceof APair: {
          invariant(!seen.has(node), "Pair.toJs: cycle detected mid-traversal");
          seen.add(node);
          const car = node.car;
          list.push(car instanceof AValue ? car["arrival/toJS"]() : car);
          node = node.cdr;
          continue;
        }
        default:
          return { __dotted__: true, list, tail: node instanceof AValue ? node["arrival/toJS"]() : node };
      }
    }
  }

  // Setoid (Fantasy Land) — structural car/cdr equality, threading the harness's shared `seen`.
  // NO cycle bookkeeping here: structuralEqual records (this, other) BEFORE dispatching, so a
  // cyclic list (`a.cdr = a`) re-encounters the pair in the harness and short-circuits — this
  // method just recurses element-wise. A non-Pair `other` is false. (B2: per-type `equal?` moved
  // onto the term; the abstract AValue Setoid forces it. Mirrors AVector's seen-threaded Setoid.)
  ["arrival/tagless-final/equals"](other: unknown, seen?: SeenMap): boolean {
    return (
      other instanceof APair && structuralEqual(this.car, other.car, seen) && structuralEqual(this.cdr, other.cdr, seen)
    );
  }

  /**
   * Parser/macro-attached metadata (`__location__`, `__cycles__`, `__ref__`) must
   * survive — losing it breaks stack traces and reader-cycle reconstruction.
   */
  withProvenance(p: ReadonlySet<number>): APair<Car, Cdr> {
    const copy = new APair<Car, Cdr>(this.ctx, this.car, this.cdr, p);

    if (this[LOCATION] !== undefined) copy[LOCATION] = this[LOCATION];
    if (this[CYCLES] !== undefined) copy[CYCLES] = this[CYCLES];
    if (this[REF] !== undefined) copy[REF] = this[REF];
    return copy;
  }

  // ----------------------------------------------------------------------
  // Term algebras (arrival/tagless-final/*): Pair is the free monoid + Functor + Foldable +
  // Traversable + Chain over a list. Recursors terminate on `instanceof Nil`, not `=== nil` —
  // `nil.withProvenance(p)` mints fresh Nil clones, so reference-equality would recurse past a
  // provenance-bearing list end. Mirrors value-guards.ts:is_nil.
  // ----------------------------------------------------------------------

  [Symbol.iterator](): Iterator<unknown> {
    let node: AList = this;
    return {
      next(): IteratorResult<unknown> {
        const cur = node;
        if (cur instanceof ANil) {
          node = nil;
          return { value: undefined, done: true };
        }
        if (!(cur instanceof APair)) {
          node = nil;
          return { value: cur, done: false };
        }
        node = cur.cdr;
        return { value: cur.car, done: false };
      },
    };
  }

  // Functor — `map` that preserves every element's box + provenance. Walks the cdr-spine
  // directly, calls `fn` per element concurrently (LIPS lambdas return Promises), then rebuilds
  // a fresh spine via Pair.fromArray(_, false) — same shape as the eager `map` builtin. Results
  // are kept RAW so a SchemeString/SchemeExact element keeps its box (coercion-soundness: "map
  // preserves every element's box", lineage A13/A18b). Honors the empty-pair sentinel and a
  // Nil-clone tail, same as the old mapPair.
  ["arrival/tagless-final/map"](
    fn: (x: unknown) => unknown | Promise<unknown>,
    runCtx?: RunContext,
  ): AList | AHalfBaked | Promise<AList> {
    chargeHeap(runCtx, countPairElements(this));
    // Spine-walk surfacing elements as `unknown` — the file's canonical convention
    // (`to_array(): unknown[]`, lineage.ts list-walks): a list element's union
    // membership is narrowed at the point of consumption, not asserted at the slot.
    const elements: unknown[] = [];
    let node: unknown = this;
    while (node instanceof APair) {
      if (node.car === undefined && node.cdr instanceof ANil) break; // empty-pair sentinel
      elements.push(node.car);
      node = node.cdr;
    }
    // Routed through the invocation seam (not a bare `fn(x)`): it dispatches the callee's apply
    // term when it's a callable VALUE and otherwise invokes a host fn with an explicit
    // `this = { ctx: { runCtx } }` — fixes the `this=undefined` crash a bare `fn(x)` caused when
    // the callback (e.g. `cadr`, a rosetta) reads `this.ctx`.
    const results = elements.map((x) => applyCallback(fn, [x], runCtx));
    if (runCtx?.speculate && results.some(is_promise)) {
      // map's count is known exactly up front (one output per input → bounds [1,1]), so its
      // HalfBaked interval is already a POINT — `length` is decidable immediately while the
      // values still resolve, carrying speculation through a map between a filter and a length check.
      const slots = results.map(
        (r): Promise<SchemeValue[]> =>
          is_promise(r) ? (r as Promise<unknown>).then((v) => [v as SchemeValue]) : Promise.resolve([r as SchemeValue]),
      );
      return AHalfBaked.collection(this.ctx, slots, () => [1, 1]);
    }
    if (results.some(is_promise)) {
      return (promise_all(results) as Promise<unknown[]>).then((resolved) =>
        APair.fromArray(this.ctx, resolved, false),
      );
    }
    return APair.fromArray(this.ctx, results, false);
  }

  // Filterable — preserves every kept element's box. Keep-rule matches the eager `filter`
  // builtin: Scheme-truthy (`!is_false`) AND nil dropped; a RegExp arg adapts via
  // `String(x).match`, a fn passes through. `pred` is awaited per element (concurrent fan — LIPS
  // lambdas return Promises); kept elements re-cons shallow via Pair.fromArray(_, false), so
  // element boxes survive and the container box drops. When SPECULATING (`runCtx.speculate`)
  // and the fan holds promises, emit a lazy AHalfBaked collection instead of awaiting: each slot
  // resolves independently to its contribution ([] dropped, [x] kept), so a monotone length
  // check (`(>= (length …) k)`) can collapse the instant `k` is reached, fan still pending.
  // Supersedes the old stdlib `filter` builtin dispatch — the term owns the algebra AND its
  // speculation strategy.
  ["arrival/tagless-final/filter"](
    arg: ((x: unknown) => unknown | Promise<unknown>) | RegExp,
    runCtx?: RunContext,
  ): AList | AHalfBaked | Promise<AList> {
    chargeHeap(runCtx, countPairElements(this));
    const pred = arg instanceof RegExp ? (x: unknown) => String(x).match(arg) : arg;
    const elements: SchemeValue[] = [];
    let node: unknown = this;
    while (node instanceof APair) {
      if (node.car === undefined && node.cdr instanceof ANil) break; // empty-pair sentinel
      elements.push(node.car);
      node = node.cdr;
    }
    // Seam-routed (see map above): `pred` is the user callable OR the RegExp-matcher closure —
    // both invoked with a defined `this`, no bare `pred(x)` crash on a `this.ctx`-reading callee.
    const verdicts = elements.map((x) => applyCallback(pred, [x], runCtx));
    const kept = (verdict: unknown): boolean => !is_false(verdict) && !(verdict instanceof ANil);
    if (runCtx?.speculate && verdicts.some(is_promise)) {
      const slots = verdicts.map((r, i): Promise<SchemeValue[]> => {
        const contribute = (verdict: unknown): SchemeValue[] => (kept(verdict) ? [elements[i]] : []);
        return is_promise(r) ? (r as Promise<unknown>).then(contribute) : Promise.resolve(contribute(r));
      });
      return AHalfBaked.collection(this.ctx, slots, () => [0, 1]);
    }
    if (verdicts.some(is_promise)) {
      return (promise_all(verdicts) as Promise<unknown[]>).then((results) =>
        APair.fromArray(
          this.ctx,
          elements.filter((_, i) => kept(results[i])),
          false,
        ),
      );
    }
    return APair.fromArray(
      this.ctx,
      elements.filter((_, i) => kept(verdicts[i])),
      false,
    );
  }

  // Canonical async-aware reduce, SRFI fold convention `fn(element, acc)` (acc last), left fold.
  // Walks the spine directly, threads the accumulator with `await`. Reproduces the eager
  // `reduce` builtin EXACTLY — `(reduce - 100 '(1 2 3 4 5))` = -97, NOT the FL acc-first 85.
  // Honors the empty-pair sentinel and a Nil-clone tail. Both the scheme `reduce` builtin and
  // fl-interop dispatch here.
  async ["arrival/tagless-final/reduce"]<Acc>(
    fn: (element: unknown, acc: Acc) => Acc | Promise<Acc>,
    initial: Acc,
    runCtx?: RunContext,
  ): Promise<Acc> {
    chargeHeap(runCtx, countPairElements(this));
    let acc = initial;
    let node: unknown = this;
    while (node && !(node instanceof ANil)) {
      const p = node as APair<any, any>;
      if (p.car === undefined && p.cdr instanceof ANil) break; // empty-pair sentinel
      // Seam-routed. The dispatch erases the generic `Acc` return to `CallResult`, so cast back
      // at this boundary — the reducer's result IS an `Acc` (a scheme value).
      acc = (await applyCallback(fn, [p.car, acc], runCtx)) as Acc;
      node = p.cdr;
    }
    return acc;
  }

  // Structure-preserving sort — stays a list (never crosses out). Collects the spine to an
  // array, sorts with `deriveSortCompare` (no comparator ⇒ elements' own
  // `arrival/tagless-final/lte` total order, so `(sort '(2 10))` is `(2 10)`, the lte-default
  // bug-fix; comparator ⇒ SRFI-95 `less?`), then re-cons SHALLOW via Pair.fromArray(_, false):
  // element boxes are preserved (only reordered), the container box drops, an empty list is
  // nil. ES Array.sort is sync + stable; charges heap before materializing.
  ["arrival/tagless-final/sort"](
    comparator?: (a: unknown, b: unknown) => unknown,
    runCtx?: RunContext,
  ): AList {
    chargeHeap(runCtx, countPairElements(this));
    const out: unknown[] = [];
    let node: unknown = this;
    while (node && !(node instanceof ANil)) {
      const p = node as APair<any, any>;
      if (p.car === undefined && p.cdr instanceof ANil) break; // empty-pair sentinel
      out.push(p.car);
      node = p.cdr;
    }
    out.sort(deriveSortCompare(comparator));
    return APair.fromArray(this.ctx, out, false);
  }

  // Element-count — `length` carrying the ELEMENTS' (cars') unioned provenance, NOT the
  // container box: a count carries the grounding of every element it touched. Walks the
  // cdr-spine counting elements + collecting their AValue cars; returns the bare count if none
  // are grounded, else `fromJs(count, unioned-prov)`. No heap-charge (a count allocates
  // nothing). Throws "length: circular list" on a cycle, matching the base stdlib `length`'s
  // error. Honors the empty-pair sentinel.
  ["arrival/tagless-final/length"](_runCtx?: unknown): AValue | number {
    if (isCircularList(this)) throw new TypeError("length: circular list");
    let count = 0;
    const inputs: AValue[] = [];
    let node: unknown = this;
    while (node && !(node instanceof ANil)) {
      const p = node as APair<any, any>;
      if (p.car === undefined && p.cdr instanceof ANil) break; // empty-pair sentinel
      count++;
      if (p.car instanceof AValue) inputs.push(p.car);
      node = p.cdr;
    }
    if (inputs.length === 0) return count;
    const prov = unionProvenance(inputs);
    return prov.size === 0 ? count : fromJs(this.ctx, count, prov);
  }

  // car/cdr compute directly on the term (mirrors map/filter/reduce) rather than routing
  // through the env-resolved scheme builtin. Result inherits ONLY the element's own provenance,
  // never the container's — `withInputProvenance` re-stamps an AValue element with its own
  // provenance (a no-op clone preserving identity); a raw element passes through unchanged.
  ["arrival/tagless-final/car"](): Car {
    return withInputProvenance([this.car], this.car);
  }

  ["arrival/tagless-final/cdr"](): Cdr {
    return withInputProvenance([this.cdr], this.cdr);
  }

  // Type predicate — the receiver answers directly (a `symbol.taglessGuard`) instead of the
  // builtin reaching around the box with `instanceof APair`. A Pair is always #t; a value
  // lacking this method defaults to #f (the guard's graceful default).
  ["arrival/tagless-final/pair?"](): boolean {
    return true;
  }

  // Traversable — effectful traversal; `of` lifts into the applicative.
  ["arrival/tagless-final/traverse"](of: (x: unknown) => unknown, f: (x: unknown) => unknown): unknown {
    return traversePair(this.ctx, of as (x: unknown) => SchemeValue, f, this);
  }

  // Chain (Monad) — map then flatten, via the pure list-concat Semigroup below. No
  // `global_env.get("append")` back-edge (the old monkey-patch's require("./stdlib") hack
  // existed only because this method lived outside the class — see plan wave 2).
  ["arrival/tagless-final/chain"](f: (x: unknown) => AList): AList {
    return chainPair(this.ctx, f, this);
  }

  // Semigroup — list append. `this ⋄ other` = this list's elements followed by other's. Pure:
  // builds a fresh spine, never mutates either operand (unlike the in-place `append` method above).
  ["arrival/tagless-final/concat"]<T extends AList>(other: T): AConcatPair<APair<Car, Cdr>, T> {
    return concatPair<APair<Car, Cdr>, T>(this.ctx, this, other);
  }
}

function traversePair(
  ctx: RunContext,
  of: (x: unknown) => SchemeValue,
  f: (x: unknown) => unknown,
  pair: unknown,
): unknown {
  // Iterative right fold (was self-recursive → O(depth) host stack). traverse is a RIGHT fold:
  // collect each `f(car)` left-to-right (preserving f-call order), then combine from the tail
  // with `of(nil)` as the seed — `ap` when the mapped head is applicative, else the leaf wrap
  // `of(new Pair(head, acc))`. Reproduces the recursive unwind exactly: same of-call count/order,
  // same ap-vs-leaf branch per node, same single phantom step on an improper/non-Pair tail.
  // `heads` holds the MAPPED values (`f(car)` results) — unknown by f's own honest type; each is
  // probed for the applicative `ap` term at combine time.
  const heads: unknown[] = [];
  let node: unknown = pair;
  while (node && !(node instanceof ANil)) {
    const p = node as APair<any, any>;
    heads.push(f(p.car));
    node = p.cdr;
  }
  let acc: SchemeValue = of(nil);
  for (let i = heads.length; i--; ) {
    const mappedCar = heads[i];
    const apFn = (mappedCar as AValue | null | undefined)?.[tf("ap")];
    acc = apFn ? apFn.call(mappedCar, acc) : of(new APair(ctx, mappedCar as SchemeValue, acc));
  }
  return acc;
}

type AConcatPair<Car extends SchemeValue, Cdr extends AList> =
  Car extends APair<infer Caar, infer Cadr>
    ? Cadr extends ANil
      ? APair<Caar, Cdr>
      : APair<Car, AConcatPair<Cadr, Cdr>>
    : APair<Car, Cdr>;

// Pure list append (the Semigroup) — fresh spine of `a`'s elements, then `b`. Iterative (was
// self-recursive on `a`'s cdr → O(depth) host stack): collect a's cars in order, then prepend
// them onto `b` (shared by reference — purity: a's spine is fresh, b untouched). An improper
// `a` still contributes its phantom `undefined` car before the non-Pair tail ends the walk.
export function concatPair<Car extends SchemeValue, Cdr extends AList>(
  ctx: RunContext,
  a: Car,
  b: Cdr,
): AConcatPair<Car, Cdr> {
  const cars: SchemeValue[] = [];
  let node: unknown = a;
  while (node && !(node instanceof ANil)) {
    const p = node as APair<any, any>;
    cars.push(p.car);
    node = p.cdr;
  }
  let result: AList = (b ?? nil) as AList;
  for (let i = cars.length; i--; ) {
    result = new APair(ctx, cars[i], result);
  }
  return result as AConcatPair<Car, Cdr>;
}

// Chain = map-then-flatten. Each `f(car)` yields a list; concat them with the PURE list-append
// above — no global_env.get("append") back-edge. Iterative (was self-recursive → O(depth) host
// stack): map each car left-to-right (preserving f-call order), then concat from the right onto
// `nil` — the same right-associated fold the recursion produced (concat is associative, so the
// flattened result is identical). An improper tail still maps its phantom `f(undefined)`.
function chainPair(ctx: RunContext, f: (x: unknown) => AList, pair: unknown): AList {
  const parts: AList[] = [];
  let node: unknown = pair;
  while (node && !(node instanceof ANil)) {
    const p = node as APair<any, any>;
    parts.push(f(p.car));
    node = p.cdr;
  }
  let result: AList = nil;
  for (let i = parts.length; i--; ) {
    result = concatPair(ctx, parts[i], result);
  }
  return result;
}

/** Element count of a pair's cdr-spine (honoring the empty-pair sentinel) — the heap-charge
 *  basis for the materializing tagless terms. Module-side plain count, no provenance (unlike
 *  `arrival/tagless-final/length`, which carries the elements' grounding). */
function countPairElements(head: APair<any, any>): number {
  let n = 0;
  let node: unknown = head;
  while (node instanceof APair) {
    if (node.car === undefined && node.cdr instanceof ANil) break; // empty-pair sentinel
    n++;
    node = node.cdr;
  }
  return n;
}
