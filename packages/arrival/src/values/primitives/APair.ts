/**
 * The cons cell. Beyond car/cdr, a Pair carries its own metadata — source
 * location, datum-label/cycle marks, provenance — on the instance (symbol-keyed),
 * not in a sidecar map, so a value and its origin travel together and survive
 * structure sharing. Runtime cycles (from `set-cdr!`) are detected actively by
 * `isCircularList` (Floyd's), which keeps spine-walking builtins from spinning.
 * The class is a interop boundary (see the bottom of the file).
 *
 * Lineage: a cons-list is the free monoid over its elements; the Fantasy Land
 * instances below (Functor/Foldable/Traversable/Chain/Monoid/Semigroup —
 * fantasyland/fantasy-land) make that algebra explicit. The `Thunk`/trampoline
 * is trampolined style (Ganz, Friedman & Wand, "Trampolined Style", ICFP 1999);
 * cycle detection is Floyd's tortoise-and-hare.
 */
import { CLASS } from "../../well-known-symbols.js";
import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { withInputProvenance } from "../op-helpers.js";
import { structuralEqual, type SeenMap } from "../structural-equal.js";
import { type SourceLocation } from "../../errors.js";
import { is_native, is_nil, is_pair, is_plain_object } from "../value-guards.js";
import { is_false } from "../../eval/guards.js";
import { ABytevector } from "./ABytevector.js";
import { AString } from "./AString.js";
import { AVector } from "./AVector.js";
import { ASymbol } from "./ASymbol.js";
import { AExact, AInexact } from "../numbers.js";
import { CYCLES, DATA, LOCATION, REF } from "../../well-known-symbols.js";
import { markInteropBoundary } from "../../interop-access.js";
import { type APairLike } from "../types.js";
import { ANil, nil, setPairConstructor } from "./ANil.js";

interface PairWithMetadata<Car = unknown, Cdr = unknown> extends APair<Car, Cdr> {
  [CYCLES]?: { car?: string | APair; cdr?: string | APair };
  [REF]?: string;
  [LOCATION]?: SourceLocation;
}

// Trampoline thunk: `mark_cycles` walks arbitrarily deep lists, so it bounces
// through these instead of recursing and overflowing the native stack.
class Thunk {
  fn: () => Thunk | void;
  cont: () => void;

  constructor(fn: () => Thunk | void, cont: () => void = () => {}) {
    this.fn = fn;
    this.cont = cont;
  }

  toString(): string {
    return "#<Thunk>";
  }
}

// ----------------------------------------------------------------------
type TrampolineFn = (pair: unknown, parents: APair[]) => Thunk | void;

function trampoline(fn: TrampolineFn): (pair: unknown, parents: APair[]) => void {
  return function (pair: unknown, parents: APair[]): void {
    unwind(fn(pair, parents));
  };
}

// ----------------------------------------------------------------------
function unwind(result: Thunk | void): void {
  while (result instanceof Thunk) {
    const thunk = result;
    result = result.fn();
    if (!(result instanceof Thunk)) {
      thunk.cont();
    }
  }
}

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
  while (is_pair(fast) && is_pair(fast.cdr)) {
    slow = (slow as APair).cdr;
    fast = fast.cdr.cdr;
    if (slow === fast) return true;
  }
  return false;
}

function is_cycle(pair: unknown): boolean {
  if (!is_pair(pair)) {
    return false;
  }
  if (pair.have_cycles()) {
    return true;
  }
  return is_cycle(pair.car) || is_cycle(pair.cdr);
}

// ----------------------------------------------------------------------
function mark_cycles(pair: APair): void {
  const seen_pairs: APair[] = [];
  const cycles: PairWithMetadata[] = [];
  const refs: APair[] = [];

  function visit(pair: APair): void {
    if (!seen_pairs.includes(pair)) {
      seen_pairs.push(pair);
    }
  }

  function set(node: PairWithMetadata, type: "car" | "cdr", child: unknown, parents: APair[]): boolean {
    if (is_pair(child) && parents.includes(child)) {
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

  const detect = trampoline(function detect_thunk(pair: unknown, parents: APair[]): Thunk | void {
    if (is_pair(pair)) {
      const pairWithCycles = pair as PairWithMetadata;
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

  function mark_node(node: PairWithMetadata, type: "car" | "cdr"): void {
    const cycleData = node[CYCLES];
    if (cycleData && is_pair(cycleData[type])) {
      const count = ref_nodes.indexOf(cycleData[type]);
      cycleData[type] = `#${count}#`;
    }
  }

  detect(pair, []);
  const ref_nodes = seen_pairs.filter((node) => refs.includes(node));
  for (const [i, node] of ref_nodes.entries()) {
    (node as PairWithMetadata)[REF] = `#${i}=`;
  }
  for (const node of cycles) {
    mark_node(node, "car");
    mark_node(node, "cdr");
  }
}

interface ObjectWithToString {
  toString: (quote?: boolean) => string;
}
interface FunctionWithName extends Function {
  __name__?: string | symbol;
}

function stringifyValue(obj: unknown, quote?: boolean): string {
  // Handle null/undefined
  if (obj === null) return "null";
  if (obj === undefined) return "#void";
  if (obj === true) return "#t";
  if (obj === false) return "#f";

  // Handle primitives
  const t = typeof obj;
  if (t === "string") return quote ? JSON.stringify(obj) : (obj as string);
  if (t === "number" || t === "bigint") return String(obj);
  if (t === "symbol") return (obj as symbol).toString().replace(/^Symbol\(([^)]+)\)/, "$1");

  // Handle objects with toString method (SchemeSymbol, SchemeString, SchemeCharacter, numbers, nil, etc.)
  if (t === "object" || t === "function") {
    // Special handling for functions
    if (t === "function") {
      const fn = obj as FunctionWithName;
      if (fn.__name__) {
        const name =
          typeof fn.__name__ === "symbol"
            ? fn.__name__.toString().replace(/^Symbol\((?:#:)?([^)]+)\)$/, "$1")
            : fn.__name__;
        return `#<procedure:${name}>`;
      }
      return "#<procedure>";
    }
    // Boxed vectors/bytevectors → R7RS external representation #(...)/#u8(...),
    // recursing through stringifyValue so nested elements (incl. quoting) format
    // correctly. Without this they fall through to the generic #<ctor.name>
    // ("#<SchemeVector>") below — the nested-in-a-list repr leak. (The stdlib
    // toString path is handled symmetrically via get_instances.)
    if (obj instanceof AVector) {
      return `#(${obj.__vector__.map((el) => stringifyValue(el, quote)).join(" ")})`;
    }
    if (obj instanceof ABytevector) {
      return `#u8(${Array.from(obj.__bytevector__).join(" ")})`;
    }
    // Objects with custom toString
    const o = obj as ObjectWithToString;
    if (typeof o.toString === "function" && o.toString !== Object.prototype.toString) {
      const str = o.toString(quote);
      return typeof str === "string" ? str : String(str);
    }
    // Fallback for plain objects
    const ctor = (obj as object).constructor;
    if (ctor?.name) {
      return `#<${ctor.name}>`;
    }
    return "#<Object>";
  }

  return String(obj);
}

export class APair<Car = unknown, Cdr = unknown> extends AValue implements APairLike<Car, Cdr> {
  static [CLASS] = "pair";
  readonly kind = "pair" as const;
  [DATA]?: boolean;
  [LOCATION]?: SourceLocation;

  car: Car;
  cdr: Cdr;

  constructor(ctx: RunContext, car?: Car, cdr?: Cdr, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(ctx, provenance);
    this.car = car as Car;
    this.cdr = cdr as Cdr;
  }

  // Static methods
  static match(obj: unknown, item: string | RegExp | ASymbol): boolean {
    if (obj instanceof ASymbol) {
      return ASymbol.is(obj, item);
    } else if (is_pair(obj)) {
      return APair.match(obj.car, item) || APair.match(obj.cdr, item);
    } else if (Array.isArray(obj)) {
      return obj.some((x) => APair.match(x, item));
    } else if (is_plain_object(obj)) {
      return Object.values(obj).some((x) => APair.match(x, item));
    }
    return false;
  }

  static fromArray(array: unknown, deep = true, quote = false): APair | ANil | unknown[] {
    if (
      is_pair(array) ||
      (quote && Array.isArray(array) && (array as unknown as { [key: symbol]: unknown })[DATA])
    ) {
      return array as APair | unknown[];
    }
    const arr = Array.isArray(array) ? array : [...(array as Iterable<unknown>)];
    if (deep === false) {
      let list: APair | ANil = nil;
      for (let i = arr.length; i--; ) {
        list = new APair(CONSTANT_CTX, arr[i], list);
      }
      return list;
    }
    let result: APair | ANil = nil;
    let i = arr.length;
    while (i--) {
      let car: unknown = arr[i];
      if (Array.isArray(car)) {
        car = APair.fromArray(car, deep, quote);
      } else if (typeof car === "string") {
        car = new AString(CONSTANT_CTX, car);
      } else if (typeof car === "number" && !Number.isNaN(car)) {
        car = Number.isSafeInteger(car) ? new AExact(CONSTANT_CTX, BigInt(car)) : new AInexact(CONSTANT_CTX, car);
      } else if (typeof car === "bigint") {
        car = new AExact(CONSTANT_CTX, car);
      }
      result = new APair(CONSTANT_CTX, car, result);
    }
    return result;
  }

  static fromPairs(array: [string, unknown][]): APair | ANil {
    return array.reduce<APair | ANil>((list, pair) => {
      return new APair(CONSTANT_CTX, new APair(CONSTANT_CTX, new ASymbol(CONSTANT_CTX, pair[0]), pair[1]), list);
    }, nil);
  }

  static fromObject(obj: Record<string, unknown>): APair | ANil {
    const array = Object.keys(obj).map((key) => [key, obj[key]] as [string, unknown]);
    return APair.fromPairs(array);
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
  flatten(): APair | ANil | unknown[] {
    return APair.fromArray(this.to_array().flat(Infinity));
  }

  length(): number {
    let len = 0;
    let node: APair | unknown = this;
    while (true) {
      if (!node || is_nil(node) || !is_pair(node) || node.have_cycles("cdr")) {
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

  clone(deep = true): APair {
    const visited = new Map<APair, APair>();
    const selfCtx = this.ctx;

    function cloneNode(node: unknown): unknown {
      if (is_pair(node)) {
        if (visited.has(node)) {
          return visited.get(node);
        }
        const pair = new APair(selfCtx, ) as PairWithMetadata;
        visited.set(node, pair);
        pair.car = deep ? cloneNode(node.car) : node.car;
        pair.cdr = cloneNode(node.cdr);
        pair[CYCLES] = (node as PairWithMetadata)[CYCLES];
        return pair;
      }
      return node;
    }

    return cloneNode(this) as APair;
  }

  last_pair(): APair | undefined {
    let node: APair = this;
    while (true) {
      if (!is_pair(node.cdr)) {
        return node;
      }
      if (node.have_cycles("cdr")) {
        break;
      }
      node = node.cdr;
    }
  }

  to_array(deep = true): unknown[] {
    // A circular list can't be materialized to a finite array — the recursion on
    // `this.cdr` below would stack-overflow. `isCircularList` (Floyd's) is needed
    // here because `have_cycles()` misses runtime `set-cdr!` cycles.
    invariant(!isCircularList(this), "cannot convert a circular list to an array");
    let result: unknown[] = [];
    if (is_pair(this.car)) {
      if (deep) {
        result.push(this.car.to_array());
      } else {
        result.push(this.car);
      }
    } else {
      const car = this.car;
      // When deep=false (used for vector literals), preserve Scheme values as-is
      // Only call valueOf() for deep conversions to JS primitives
      if (deep && car !== null && car !== undefined && typeof car === "object" && "valueOf" in car) {
        // But preserve SchemeSymbol, SchemeString, and number types even in deep mode
        // as they are Scheme values that should remain wrapped
        if (
          car instanceof ASymbol ||
          car instanceof AString ||
          car instanceof AExact ||
          car instanceof AInexact
        ) {
          result.push(car);
        } else {
          result.push((car as { valueOf(): unknown }).valueOf());
        }
      } else {
        result.push(car);
      }
    }
    if (is_pair(this.cdr)) {
      result = [...result, ...this.cdr.to_array(deep)];
    }
    return result;
  }

  to_object(literal = false): Record<string, unknown> {
    let node: APair | unknown = this;
    const result: Record<string, unknown> = {};
    while (true) {
      if (is_pair(node) && is_pair(node.car)) {
        const pair = node.car;
        let name: unknown = pair.car;
        if (name instanceof ASymbol) {
          name = name.__name__;
        }
        if (name instanceof AString) {
          name = name.valueOf();
        }
        let cdr: unknown = pair.cdr;
        if (is_pair(cdr)) {
          cdr = cdr.to_object(literal);
        }
        if (is_native(cdr) && !literal) {
          cdr = (cdr as { valueOf(): unknown }).valueOf();
        }
        result[name as string] = cdr;
        node = node.cdr;
      } else {
        break;
      }
    }
    return result;
  }

  reduce<T>(fn: (acc: T | ANil, val: unknown) => T): T | ANil {
    let node: APair | unknown = this;
    let result: T | ANil = nil;
    while (true) {
      if (is_nil(node)) {
        break;
      } else if (is_pair(node)) {
        result = fn(result, node.car);
        node = node.cdr;
      } else {
        break;
      }
    }
    return result;
  }

  transform(fn: (val: unknown) => unknown): APair {
    const visited: APair[] = [];
    const selfCtx = this.ctx;

    function recur(pair: unknown): unknown {
      if (is_pair(pair)) {
        if ((pair as APair & { replace?: boolean }).replace) {
          delete (pair as APair & { replace?: boolean }).replace;
          return pair;
        }
        let car = fn(pair.car);
        if (is_pair(car)) {
          car = recur(car);
          visited.push(car as APair);
        }
        let cdr = fn(pair.cdr);
        if (is_pair(cdr)) {
          cdr = recur(cdr);
          visited.push(cdr as APair);
        }
        return new APair(selfCtx, car, cdr);
      }
      return pair;
    }

    return recur(this) as APair;
  }

  map(fn: (val: unknown) => unknown): APair | ANil {
    return this.car === undefined ? nil : new APair(this.ctx, fn(this.car), is_nil(this.cdr) ? nil : (this.cdr as APair).map(fn));
  }

  mark_cycles(): this {
    mark_cycles(this);
    return this;
  }

  have_cycles(name: "car" | "cdr" | null = null): boolean {
    if (!name) {
      return this.have_cycles("car") || this.have_cycles("cdr");
    }
    return !!(this as PairWithMetadata)[CYCLES]?.[name];
  }

  is_cycle(): boolean {
    return is_cycle(this);
  }

  toString(quote?: boolean, { nested = false } = {}): string {
    const parts: string[] = [];
    const thisWithCycles = this as PairWithMetadata;

    // Opening paren (with ref marker if present)
    if (thisWithCycles[REF]) {
      parts.push(`${thisWithCycles[REF]}(`);
    } else if (!nested) {
      parts.push("(");
    }

    let node: APair = this;
    let first = true;

    // Iterate through cdr chain (no recursion on cdr = no stack overflow on long lists)
    while (is_pair(node)) {
      const nodeWithCycles = node as PairWithMetadata;
      if (!first) {
        if (nodeWithCycles[REF]) {
          // Shared structure in cdr position - print as dotted pair with full notation
          parts.push(" . ", node.toString(quote));
          node = nil as unknown as APair;
          continue;
        }
        parts.push(" ");
      }
      first = false;

      // Car value (recursive for nested structures - usually shallow)
      const carValue = nodeWithCycles[CYCLES]?.car ?? stringifyValue(node.car, quote);
      if (carValue !== undefined) {
        parts.push(String(carValue));
      }

      // Check for cdr cycle marker
      if (nodeWithCycles[CYCLES]?.cdr) {
        parts.push(" . ", String(nodeWithCycles[CYCLES].cdr));
        break;
      }

      node = node.cdr as APair;
    }

    // Improper list tail (non-nil, non-pair cdr)
    if (!is_nil(node) && !is_pair(node)) {
      parts.push(" . ", stringifyValue(node, quote));
    }

    // Closing paren
    if (!nested || thisWithCycles[REF]) {
      parts.push(")");
    }
    return parts.join("");
  }

  serialize(): [unknown, unknown] {
    return [this.car, this.cdr];
  }

  toJs(): unknown {
    // toJs's serialization target is cache / log / HTTP JSON — none of which
    // can represent cycles. `toString` handles them by emitting `#0=` / `#0#`
    // ref markers via __cycles__ / __ref__ metadata because s-expression text
    // supports that notation; JSON does not. Loud-fail rather than hand back a
    // value that explodes downstream — or, worse, hangs forever in the loop below.
    invariant(!this.have_cycles(), "Pair.toJs: cannot serialize a list with cycles");
    // Belt-and-suspenders against cycles introduced post-have_cycles check via
    // mutation between top-level call and a deeper recursive toJs (e.g. a
    // nested Pair's car being mutated by a side-effecting toJs override). Cheap
    // — one Set add per pair traversed.
    const seen = new Set<APair>();
    const list: unknown[] = [];
    let node: unknown = this;
    while (true) {
      switch (true) {
        case is_nil(node):
          return list;
        case is_pair(node): {
          invariant(!seen.has(node), "Pair.toJs: cycle detected mid-traversal");
          seen.add(node);
          const car = node.car;
          list.push(car instanceof AValue ? car.toJs() : car);
          node = node.cdr;
          continue;
        }
        default:
          return { __dotted__: true, list, tail: node instanceof AValue ? node.toJs() : node };
      }
    }
  }

  /**
   * Parser/macro-attached metadata (`__location__`, `__cycles__`, `__ref__`) must
   * survive — losing it breaks stack traces and reader-cycle reconstruction.
   */
  withProvenance(p: ReadonlySet<number>): APair<Car, Cdr> {
    const copy = new APair<Car, Cdr>(this.ctx, this.car, this.cdr, p);
    const src = this as PairWithMetadata<Car, Cdr>;
    const dst = copy as PairWithMetadata<Car, Cdr>;
    if (src[LOCATION] !== undefined) dst[LOCATION] = src[LOCATION];
    if (src[CYCLES] !== undefined) dst[CYCLES] = src[CYCLES];
    if (src[REF] !== undefined) dst[REF] = src[REF];
    return copy;
  }

  [Symbol.iterator](): Iterator<unknown> {
    let node: APair | ANil | unknown = this;
    return {
      next(): IteratorResult<unknown> {
        const cur = node;
        if (is_nil(cur)) {
          node = nil;
          return { value: undefined, done: true };
        }
        if (!is_pair(cur)) {
          node = nil;
          return { value: cur, done: false };
        }
        node = cur.cdr;
        return { value: cur.car, done: false };
      },
    };
  }

  // Setoid (Fantasy Land) — structural car/cdr equality, threading the harness's
  // shared `seen`. NO cycle bookkeeping here: structuralEqual recorded (this, other)
  // BEFORE dispatching, so a cyclic list (`a.cdr = a`) re-encounters the pair in the
  // harness and short-circuits — this method just recurses element-wise. A non-Pair
  // `other` is false. (B2: per-type `equal?` moved onto the term; the abstract AValue
  // Setoid forces it. Mirrors SchemeVector's seen-threaded Setoid.)
  ["arrival/tagless-final/equals"](other: unknown, seen?: SeenMap): boolean {
    return (
      other instanceof APair &&
      structuralEqual(this.car, other.car, seen) &&
      structuralEqual(this.cdr, other.cdr, seen)
    );
  }

  // ----------------------------------------------------------------------
  // Structure-algebras on the term (arrival/tagless-final/*). A Pair is the free
  // monoid + Functor + Foldable + Traversable + Chain over a list. The recursors
  // TERMINATE on `instanceof Nil`, not `=== nil`: after the AValue refactor
  // `nil.withProvenance(p)` mints fresh Nil clones (types.ts), so reference-equality
  // would recurse past a provenance-bearing list end and crash on `<Nil-clone>.cdr`.
  // Mirrors value-guards.ts:is_nil. (The map/filter/reduce sequence-ops were dissolved
  // out of the borrowed fantasy-land/* protocol into the async-aware methods below —
  // plan-2026-06-10-algebras-in-entities.md wave 2 → fl-dissolution.)
  // ----------------------------------------------------------------------

  // Arrival's async-aware Functor — `map` that PRESERVES every element's box and
  // provenance. Walks the cdr-spine DIRECTLY (not via fantasy-land/reduce collect),
  // awaiting `fn` per element (live LIPS lambdas always return Promises), then rebuilds
  // a fresh APair spine via Pair.fromArray(_, false) — the exact form the eager scheme
  // `map` builtin uses (freshening the spine, dropping the container box, terminating in
  // the canonical nil). The element results are kept RAW (no unwrap), so a SchemeString /
  // SchemeExact element keeps its box: coercion-soundness's "Pair · map preserves every
  // element's box" + lineage A13/A18b are the pins. Honors the empty-pair sentinel
  // (`Pair(undefined, nil)`) and a Nil-clone tail exactly as mapPair did.
  async ["arrival/tagless-final/map"](fn: (x: unknown) => unknown | Promise<unknown>): Promise<APair | ANil> {
    const out: unknown[] = [];
    let node: unknown = this;
    while (node && !(node instanceof ANil)) {
      const p = node as APair;
      if (p.car === undefined && p.cdr instanceof ANil) break; // empty-pair sentinel
      out.push(await fn(p.car));
      node = p.cdr;
    }
    return APair.fromArray(out, false) as APair | ANil;
  }

  // Arrival's async-aware Filterable — `filter` that PRESERVES every kept element's box.
  // Spine-walk + the canonical keep-rule IDENTICAL to the eager scheme `filter` builtin:
  // Scheme-truthy (`!is_false`) AND nil dropped (`!is_nil`). `pred` is awaited per element.
  // A RegExp arg is adapted the way the eager builtin's matcher does (regex →
  // `String(x).match`); a fn passes through. Kept elements are re-consed shallow in order
  // via Pair.fromArray(_, false), so element boxes survive and the container box drops —
  // byte-identical to the overlay's prior asyncFLFilter-over-a-Pair VALUE semantics.
  async ["arrival/tagless-final/filter"](
    arg: ((x: unknown) => unknown | Promise<unknown>) | RegExp,
  ): Promise<APair | ANil> {
    const pred = arg instanceof RegExp ? (x: unknown) => String(x).match(arg) : arg;
    const out: unknown[] = [];
    let node: unknown = this;
    while (node && !(node instanceof ANil)) {
      const p = node as APair;
      if (p.car === undefined && p.cdr instanceof ANil) break; // empty-pair sentinel
      const verdict = await pred(p.car);
      if (!is_false(verdict) && !is_nil(verdict)) out.push(p.car);
      node = p.cdr;
    }
    return APair.fromArray(out, false) as APair | ANil;
  }

  // Arrival's canonical async-aware reduce — the scheme/SRFI fold convention
  // `fn(element, acc)` (accumulator last), left fold, head-to-tail. Walks the spine
  // DIRECTLY and threads the accumulator with `await` (live LIPS lambdas return
  // Promises), absorbing the overlay's prior asyncArrivalReduce helper. Reproduces the
  // eager scheme `reduce` builtin EXACTLY — `(reduce - 100 '(1 2 3 4 5))` = -97, NOT the
  // FL acc-first 85. Honors the empty-pair sentinel + a Nil-clone tail (no phantom fold).
  // The scheme `reduce` builtin + fl-interop dispatch to THIS.
  async ["arrival/tagless-final/reduce"]<Acc>(
    fn: (element: unknown, acc: Acc) => Acc | Promise<Acc>,
    initial: Acc,
  ): Promise<Acc> {
    let acc = initial;
    let node: unknown = this;
    while (node && !(node instanceof ANil)) {
      const p = node as APair;
      if (p.car === undefined && p.cdr instanceof ANil) break; // empty-pair sentinel
      acc = await fn(p.car, acc);
      node = p.cdr;
    }
    return acc;
  }

  // Arrival's canonical car/cdr — the head/tail PROJECTIONS. They mirror the scheme
  // `car`/`cdr` builtins exactly (spec §5.3): the result inherits ONLY the element's
  // own provenance, never the container's, so `withInputProvenance` is passed the
  // element as its single input (an AValue element is re-stamped with its own
  // provenance — a no-op clone preserving identity; a raw element returns unchanged).
  // fl-interop's car/cdr overlay dispatches a LIPS Pair HERE so the head/tail projection
  // computes on the term, not via the env-resolved scheme builtin (mirrors map/filter/reduce).
  ["arrival/tagless-final/car"](): Car {
    return withInputProvenance([this.car], this.car);
  }

  ["arrival/tagless-final/cdr"](): Cdr {
    return withInputProvenance([this.cdr], this.cdr);
  }

  // Traversable — effectful traversal; `of` lifts into the applicative.
  ["arrival/tagless-final/traverse"](of: (x: unknown) => unknown, f: (x: unknown) => unknown): unknown {
    return traversePair(of, f, this);
  }

  // Chain (Monad) — map then flatten. Flattening reuses the PURE list-concat
  // Semigroup below; there is no `global_env.get("append")` back-edge (the
  // require("./stdlib") hack the monkey-patch carried existed ONLY because the
  // method lived outside the class — see plan wave 2).
  ["arrival/tagless-final/chain"](f: (x: unknown) => APair | ANil): APair | ANil {
    return chainPair(f, this);
  }

  // Semigroup — list append. `this ⋄ other` = the elements of this list
  // followed by the elements of `other`. Pure: builds a fresh spine, never
  // mutates either operand (unlike the in-place `append` method above).
  ["arrival/tagless-final/concat"](other: APair | ANil): APair | ANil {
    return concatPair(this, other);
  }

  // Monoid — the empty list is the identity for list-concat.
  static ["arrival/tagless-final/empty"](): ANil {
    return nil;
  }

  // Applicative — single-element list.
  static ["arrival/tagless-final/of"](value: unknown): APair {
    return new APair(CONSTANT_CTX, value, nil);
  }
}

// Structure-algebra recursors for the term methods above. They terminate on
// `instanceof Nil`, not `=== nil` — see the class-body comment for why.

// The empty-list sentinel: `new Pair()` (no args) yields `Pair(undefined, nil)`,
// the shape arrival uses for "empty list" wherever a bare Pair is constructed.
// EVERY Pair recursor must honor it, else folding through it would yield a phantom
// `undefined` element. `instanceof Nil` (not `=== nil`) catches provenance clones in
// the cdr. (Shared by the surviving traverse/chain recursors AND the async-aware
// map/filter/reduce methods on the class body above.)
function isEmptyPairSentinel(p: APair): boolean {
  return p.car === undefined && p.cdr instanceof ANil;
}

function traversePair(of: (x: unknown) => unknown, f: (x: unknown) => unknown, pair: unknown): unknown {
  // Iterative right fold (was self-recursive → O(depth) host stack). traverse is a
  // RIGHT fold: collect each `f(car)` left-to-right (preserving f-call order), then
  // combine from the tail with `of(nil)` as the seed — `ap` when the mapped head is
  // applicative, else the leaf wrap `of(new Pair(head, acc))`. This reproduces the
  // recursive unwind exactly: same of-call count/order (base `of(nil)` first, then one
  // wrap per element from last to first), same ap-vs-leaf branch per node, and the same
  // single phantom step on an improper/non-Pair tail (no sentinel guard, as before).
  const heads: ({ ["arrival/tagless-final/ap"]?: (m: unknown) => unknown } | undefined)[] = [];
  let node: unknown = pair;
  while (node && !(node instanceof ANil)) {
    const p = node as APair;
    heads.push(f(p.car) as { ["arrival/tagless-final/ap"]?: (m: unknown) => unknown } | undefined);
    node = p.cdr;
  }
  let acc = of(nil);
  for (let i = heads.length; i--; ) {
    const mappedCar = heads[i];
    acc = mappedCar?.["arrival/tagless-final/ap"]
      ? mappedCar["arrival/tagless-final/ap"](acc)
      : of(new APair(CONSTANT_CTX, mappedCar, acc));
  }
  return acc;
}

// Pure list append (the Semigroup) — fresh spine of `a`'s elements, then `b`.
// Iterative (was self-recursive on `a`'s cdr → O(depth) host stack). Collect a's
// cars in order, then prepend them onto `b` (shared by reference, exactly as the
// recursive base `return b ?? nil` did — purity: a's spine is fresh, b untouched).
// An improper `a` still contributes its phantom `undefined` car before the non-Pair
// tail ends the walk, matching the recursive form.
export function concatPair(a: unknown, b: unknown): APair | ANil {
  const cars: unknown[] = [];
  let node: unknown = a;
  while (node && !(node instanceof ANil)) {
    const p = node as APair;
    cars.push(p.car);
    node = p.cdr;
  }
  let result: APair | ANil = (b ?? nil) as APair | ANil;
  for (let i = cars.length; i--; ) {
    result = new APair(CONSTANT_CTX, cars[i], result);
  }
  return result;
}

// Chain = map-then-flatten. Each `f(car)` yields a list; concat them with the
// PURE list-append above — NO global_env.get("append") back-edge.
// Iterative (was self-recursive → O(depth) host stack). Map each car left-to-right
// (preserving f-call order), then concat from the right onto `nil` — the same right-
// associated fold the recursion produced, so the flattened result is identical
// (concat is associative). An improper tail still maps its phantom `f(undefined)`.
function chainPair(f: (x: unknown) => APair | ANil, pair: unknown): APair | ANil {
  const parts: (APair | ANil)[] = [];
  let node: unknown = pair;
  while (node && !(node instanceof ANil)) {
    const p = node as APair;
    parts.push(f(p.car));
    node = p.cdr;
  }
  let result: APair | ANil = nil;
  for (let i = parts.length; i--; ) {
    result = concatPair(parts[i], result);
  }
  return result;
}

// Register Pair constructor with types.ts for Nil.append
setPairConstructor(APair);

// Interop boundary. A cons cell's rich prototype (`match`/`fromArray`/`toArray`,
// the cycle/ref-tracking helpers) and metadata symbols (`__data__`, `__location__`)
// are reachable from any held Pair via symbol-to-field auto-resolution; the
// ref-tracking helpers in particular would leak host-side identity comparisons.
// This marker stops the prototype-chain walk at Pair before any helper is reached.
markInteropBoundary(APair);
