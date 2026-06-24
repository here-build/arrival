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
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { withInputProvenance } from "../op-helpers.js";
import { structuralEqual, type SeenMap } from "../structural-equal.js";
import { type SourceLocation } from "../../errors.js";
import { is_native, is_nil, is_pair, is_plain_object } from "../value-guards.js";
import { SchemeBytevector } from "./SchemeBytevector.js";
import { SchemeString } from "./SchemeString.js";
import { SchemeVector } from "./SchemeVector.js";
import { SchemeSymbol } from "./SchemeSymbol.js";
import { SchemeExact, SchemeInexact } from "../numbers.js";
import { CYCLES, DATA, LOCATION, REF } from "../../well-known-symbols.js";
import { markInteropBoundary } from "../../interop-access.js";
import { type PairLike } from "../types.js";
import { Nil, nil, setPairConstructor } from "./Nil.js";

interface PairWithMetadata<Car = unknown, Cdr = unknown> extends Pair<Car, Cdr> {
  [CYCLES]?: { car?: string | Pair; cdr?: string | Pair };
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
type TrampolineFn = (pair: unknown, parents: Pair[]) => Thunk | void;

function trampoline(fn: TrampolineFn): (pair: unknown, parents: Pair[]) => void {
  return function (pair: unknown, parents: Pair[]): void {
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
    slow = (slow as Pair).cdr;
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
function mark_cycles(pair: Pair): void {
  const seen_pairs: Pair[] = [];
  const cycles: PairWithMetadata[] = [];
  const refs: Pair[] = [];

  function visit(pair: Pair): void {
    if (!seen_pairs.includes(pair)) {
      seen_pairs.push(pair);
    }
  }

  function set(node: PairWithMetadata, type: "car" | "cdr", child: unknown, parents: Pair[]): boolean {
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

  const detect = trampoline(function detect_thunk(pair: unknown, parents: Pair[]): Thunk | void {
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
    if (obj instanceof SchemeVector) {
      return `#(${obj.__vector__.map((el) => stringifyValue(el, quote)).join(" ")})`;
    }
    if (obj instanceof SchemeBytevector) {
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

export class Pair<Car = unknown, Cdr = unknown> extends AValue implements PairLike<Car, Cdr> {
  static [CLASS] = "pair";
  readonly kind = "pair" as const;
  [DATA]?: boolean;
  [LOCATION]?: SourceLocation;

  car: Car;
  cdr: Cdr;

  constructor(car?: Car, cdr?: Cdr, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(provenance);
    this.car = car as Car;
    this.cdr = cdr as Cdr;
  }

  // Static methods
  static match(obj: unknown, item: string | RegExp | SchemeSymbol): boolean {
    if (obj instanceof SchemeSymbol) {
      return SchemeSymbol.is(obj, item);
    } else if (is_pair(obj)) {
      return Pair.match(obj.car, item) || Pair.match(obj.cdr, item);
    } else if (Array.isArray(obj)) {
      return obj.some((x) => Pair.match(x, item));
    } else if (is_plain_object(obj)) {
      return Object.values(obj).some((x) => Pair.match(x, item));
    }
    return false;
  }

  static fromArray(array: unknown, deep = true, quote = false): Pair | Nil | unknown[] {
    if (
      is_pair(array) ||
      (quote && Array.isArray(array) && (array as unknown as { [key: symbol]: unknown })[DATA])
    ) {
      return array as Pair | unknown[];
    }
    const arr = Array.isArray(array) ? array : [...(array as Iterable<unknown>)];
    if (deep === false) {
      let list: Pair | Nil = nil;
      for (let i = arr.length; i--; ) {
        list = new Pair(arr[i], list);
      }
      return list;
    }
    let result: Pair | Nil = nil;
    let i = arr.length;
    while (i--) {
      let car: unknown = arr[i];
      if (Array.isArray(car)) {
        car = Pair.fromArray(car, deep, quote);
      } else if (typeof car === "string") {
        car = new SchemeString(car);
      } else if (typeof car === "number" && !Number.isNaN(car)) {
        car = Number.isSafeInteger(car) ? new SchemeExact(BigInt(car)) : new SchemeInexact(car);
      } else if (typeof car === "bigint") {
        car = new SchemeExact(car);
      }
      result = new Pair(car, result);
    }
    return result;
  }

  static fromPairs(array: [string, unknown][]): Pair | Nil {
    return array.reduce<Pair | Nil>((list, pair) => {
      return new Pair(new Pair(new SchemeSymbol(pair[0]), pair[1]), list);
    }, nil);
  }

  static fromObject(obj: Record<string, unknown>): Pair | Nil {
    const array = Object.keys(obj).map((key) => [key, obj[key]] as [string, unknown]);
    return Pair.fromPairs(array);
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
  flatten(): Pair | Nil | unknown[] {
    return Pair.fromArray(this.to_array().flat(Infinity));
  }

  length(): number {
    let len = 0;
    let node: Pair | unknown = this;
    while (true) {
      if (!node || is_nil(node) || !is_pair(node) || node.have_cycles("cdr")) {
        break;
      }
      len++;
      node = node.cdr;
    }
    return len;
  }

  find(item: string | RegExp | SchemeSymbol): boolean {
    return Pair.match(this, item);
  }

  clone(deep = true): Pair {
    const visited = new Map<Pair, Pair>();

    function cloneNode(node: unknown): unknown {
      if (is_pair(node)) {
        if (visited.has(node)) {
          return visited.get(node);
        }
        const pair = new Pair() as PairWithMetadata;
        visited.set(node, pair);
        pair.car = deep ? cloneNode(node.car) : node.car;
        pair.cdr = cloneNode(node.cdr);
        pair[CYCLES] = (node as PairWithMetadata)[CYCLES];
        return pair;
      }
      return node;
    }

    return cloneNode(this) as Pair;
  }

  last_pair(): Pair | undefined {
    let node: Pair = this;
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
          car instanceof SchemeSymbol ||
          car instanceof SchemeString ||
          car instanceof SchemeExact ||
          car instanceof SchemeInexact
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
    let node: Pair | unknown = this;
    const result: Record<string, unknown> = {};
    while (true) {
      if (is_pair(node) && is_pair(node.car)) {
        const pair = node.car;
        let name: unknown = pair.car;
        if (name instanceof SchemeSymbol) {
          name = name.__name__;
        }
        if (name instanceof SchemeString) {
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

  reduce<T>(fn: (acc: T | Nil, val: unknown) => T): T | Nil {
    let node: Pair | unknown = this;
    let result: T | Nil = nil;
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

  reverse(): Pair | Nil {
    invariant(!this.have_cycles(), "You can't reverse list that have cycles");
    let node: Pair | unknown = this;
    let prev: Pair | Nil = nil;
    while (!is_nil(node) && is_pair(node)) {
      const next = node.cdr;
      node.cdr = prev;
      prev = node;
      node = next;
    }
    return prev;
  }

  transform(fn: (val: unknown) => unknown): Pair {
    const visited: Pair[] = [];

    function recur(pair: unknown): unknown {
      if (is_pair(pair)) {
        if ((pair as Pair & { replace?: boolean }).replace) {
          delete (pair as Pair & { replace?: boolean }).replace;
          return pair;
        }
        let car = fn(pair.car);
        if (is_pair(car)) {
          car = recur(car);
          visited.push(car as Pair);
        }
        let cdr = fn(pair.cdr);
        if (is_pair(cdr)) {
          cdr = recur(cdr);
          visited.push(cdr as Pair);
        }
        return new Pair(car, cdr);
      }
      return pair;
    }

    return recur(this) as Pair;
  }

  map(fn: (val: unknown) => unknown): Pair | Nil {
    return this.car === undefined ? nil : new Pair(fn(this.car), is_nil(this.cdr) ? nil : (this.cdr as Pair).map(fn));
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

    let node: Pair = this;
    let first = true;

    // Iterate through cdr chain (no recursion on cdr = no stack overflow on long lists)
    while (is_pair(node)) {
      const nodeWithCycles = node as PairWithMetadata;
      if (!first) {
        if (nodeWithCycles[REF]) {
          // Shared structure in cdr position - print as dotted pair with full notation
          parts.push(" . ", node.toString(quote));
          node = nil as unknown as Pair;
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

      node = node.cdr as Pair;
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

  set(prop: "car" | "cdr", value: unknown): void {
    (this as Pair)[prop] = value;
    if (is_pair(value)) {
      this.mark_cycles();
    }
  }

  append(arg: unknown): this {
    if (Array.isArray(arg)) {
      return this.append(Pair.fromArray(arg));
    }
    const self = this as Pair;
    let p: Pair = self;
    if (p.car === undefined) {
      if (is_pair(arg)) {
        self.car = arg.car;
        self.cdr = arg.cdr;
      } else {
        self.car = arg;
      }
    } else if (!is_nil(arg)) {
      while (true) {
        if (is_pair(p) && is_pair(p.cdr)) {
          p = p.cdr;
        } else {
          break;
        }
      }
      (p as Pair).cdr = arg;
    }
    return this;
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
    const seen = new Set<Pair>();
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
  withProvenance(p: ReadonlySet<number>): Pair<Car, Cdr> {
    const copy = new Pair<Car, Cdr>(this.car, this.cdr, p);
    const src = this as PairWithMetadata<Car, Cdr>;
    const dst = copy as PairWithMetadata<Car, Cdr>;
    if (src[LOCATION] !== undefined) dst[LOCATION] = src[LOCATION];
    if (src[CYCLES] !== undefined) dst[CYCLES] = src[CYCLES];
    if (src[REF] !== undefined) dst[REF] = src[REF];
    return copy;
  }

  [Symbol.iterator](): Iterator<unknown> {
    let node: Pair | Nil | unknown = this;
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
  ["fantasy-land/equals"](other: unknown, seen?: SeenMap): boolean {
    return (
      other instanceof Pair &&
      structuralEqual(this.car, other.car, seen) &&
      structuralEqual(this.cdr, other.cdr, seen)
    );
  }

  // ----------------------------------------------------------------------
  // Fantasy Land structure-algebras (migrated from the fantasy-land.ts
  // monkey-patch into the class body — plan-2026-06-10-algebras-in-entities.md
  // wave 2). A Pair is the free monoid + Functor + Foldable + Traversable +
  // Chain over a list. The recursors below TERMINATE on `instanceof Nil`, not
  // `=== nil`: after the AValue refactor `nil.withProvenance(p)` mints fresh
  // Nil clones (types.ts), so reference-equality would recurse past a
  // provenance-bearing list end and crash on `<Nil-clone>.cdr`. Mirrors
  // value-guards.ts:is_nil.
  // ----------------------------------------------------------------------

  // Functor — map each element, preserving the list spine.
  ["fantasy-land/map"](f: (x: unknown) => unknown): Pair | Nil {
    return mapPair(f, this);
  }

  // Filterable — keep elements satisfying the predicate.
  ["fantasy-land/filter"](predicate: (x: unknown) => unknown): Pair | Nil {
    return filterPair(predicate, this);
  }

  // Foldable — left fold over the elements.
  ["fantasy-land/reduce"]<Acc>(f: (acc: Acc, x: unknown) => Acc, initial: Acc): Acc {
    return reducePair(f, initial, this);
  }

  // Arrival's canonical reduce — the scheme/SRFI fold convention `fn(element, acc)`
  // (accumulator last), head-to-tail. PASSES THE CALL TO FL: delegates to the FL
  // Foldable `fantasy-land/reduce` (acc-first) with the argument order adapted, so the
  // arrival convention lives on the term in one place and the borrowed FL algebra stays
  // pure FL-spec underneath. The scheme `reduce` builtin + fl-interop dispatch to THIS.
  ["arrival/tagless-final/reduce"]<Acc>(fn: (element: unknown, acc: Acc) => Acc, initial: Acc): Acc {
    return (this as { ["fantasy-land/reduce"]: (f: (acc: Acc, x: unknown) => Acc, init: Acc) => Acc })
      ["fantasy-land/reduce"]((acc, element) => fn(element, acc), initial);
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
  ["fantasy-land/traverse"](of: (x: unknown) => unknown, f: (x: unknown) => unknown): unknown {
    return traversePair(of, f, this);
  }

  // Chain (Monad) — map then flatten. Flattening reuses the PURE list-concat
  // Semigroup below; there is no `global_env.get("append")` back-edge (the
  // require("./stdlib") hack the monkey-patch carried existed ONLY because the
  // method lived outside the class — see plan wave 2).
  ["fantasy-land/chain"](f: (x: unknown) => Pair | Nil): Pair | Nil {
    return chainPair(f, this);
  }

  // Semigroup — list append. `this ⋄ other` = the elements of this list
  // followed by the elements of `other`. Pure: builds a fresh spine, never
  // mutates either operand (unlike the in-place `append` method above).
  ["fantasy-land/concat"](other: Pair | Nil): Pair | Nil {
    return concatPair(this, other);
  }

  // Monoid — the empty list is the identity for list-concat.
  static ["fantasy-land/empty"](): Nil {
    return nil;
  }

  // Applicative — single-element list.
  static ["fantasy-land/of"](value: unknown): Pair {
    return new Pair(value, nil);
  }
}

// Structure-algebra recursors for the Fantasy Land methods above. They terminate
// on `instanceof Nil`, not `=== nil` — see the class-body comment for why.

// The empty-list sentinel: `new Pair()` (no args) yields `Pair(undefined, nil)`,
// the shape arrival uses for "empty list" wherever a bare Pair is constructed.
// EVERY Pair recursor must honor it (the ramda pack's own recursors do too), else
// delegating through `fantasy-land/*` would fold a phantom `undefined` element.
// `instanceof Nil` (not `=== nil`) catches provenance clones in the cdr.
function isEmptyPairSentinel(p: Pair): boolean {
  return p.car === undefined && p.cdr instanceof Nil;
}

function mapPair(f: (x: unknown) => unknown, pair: unknown): Pair | Nil {
  // Iterative spine-walk (was self-recursive on the cdr → O(depth) host stack →
  // overflow on a long list via fantasy-land/map). Builds into a JS array then
  // re-conses shallow via Pair.fromArray(arr, false) — the exact form the eager
  // builtins use, freshening the spine and terminating in the canonical `nil`.
  // Behavior-preserving: same per-element f order, same empty-sentinel/Nil-clone
  // termination, and an improper tail still folds ONE phantom `f(undefined)` (the
  // non-Pair tail is read as a node with `.car === undefined`, exactly as before).
  const out: unknown[] = [];
  let node: unknown = pair;
  while (node && !(node instanceof Nil)) {
    const p = node as Pair;
    if (isEmptyPairSentinel(p)) break;
    out.push(f(p.car));
    node = p.cdr;
  }
  return Pair.fromArray(out, false) as Pair | Nil;
}

function filterPair(predicate: (x: unknown) => unknown, pair: unknown): Pair | Nil {
  // Iterative spine-walk (was self-recursive → O(depth) host stack). JS-truthy on
  // the predicate (unchanged); kept elements are re-consed shallow in order via
  // Pair.fromArray(arr, false). Behavior-preserving: same empty-sentinel/Nil-clone
  // termination, all-false → nil, and an improper tail still tests `predicate(undefined)`
  // for the phantom node exactly as the recursive base case did.
  const out: unknown[] = [];
  let node: unknown = pair;
  while (node && !(node instanceof Nil)) {
    const p = node as Pair;
    if (isEmptyPairSentinel(p)) break;
    if (predicate(p.car)) out.push(p.car);
    node = p.cdr;
  }
  return Pair.fromArray(out, false) as Pair | Nil;
}

function reducePair<Acc>(f: (acc: Acc, x: unknown) => Acc, initial: Acc, pair: unknown): Acc {
  // Iterative left fold (was self-recursive on the cdr → O(depth) host stack →
  // the ~6000-frame overflow on `(filter … (range 50000))` that isContainment()
  // misread as a budget hit). Behavior-preserving: same left-to-right fold, same
  // empty-sentinel/Nil-clone termination, and an improper tail still folds ONE
  // phantom `f(acc, undefined)` before the non-Pair cdr ends the walk.
  let acc = initial;
  let node: unknown = pair;
  while (node && !(node instanceof Nil)) {
    const p = node as Pair;
    if (isEmptyPairSentinel(p)) break;
    acc = f(acc, p.car);
    node = p.cdr;
  }
  return acc;
}

function traversePair(of: (x: unknown) => unknown, f: (x: unknown) => unknown, pair: unknown): unknown {
  // Iterative right fold (was self-recursive → O(depth) host stack). traverse is a
  // RIGHT fold: collect each `f(car)` left-to-right (preserving f-call order), then
  // combine from the tail with `of(nil)` as the seed — `ap` when the mapped head is
  // applicative, else the leaf wrap `of(new Pair(head, acc))`. This reproduces the
  // recursive unwind exactly: same of-call count/order (base `of(nil)` first, then one
  // wrap per element from last to first), same ap-vs-leaf branch per node, and the same
  // single phantom step on an improper/non-Pair tail (no sentinel guard, as before).
  const heads: ({ ["fantasy-land/ap"]?: (m: unknown) => unknown } | undefined)[] = [];
  let node: unknown = pair;
  while (node && !(node instanceof Nil)) {
    const p = node as Pair;
    heads.push(f(p.car) as { ["fantasy-land/ap"]?: (m: unknown) => unknown } | undefined);
    node = p.cdr;
  }
  let acc = of(nil);
  for (let i = heads.length; i--; ) {
    const mappedCar = heads[i];
    acc = mappedCar?.["fantasy-land/ap"]
      ? mappedCar["fantasy-land/ap"](acc)
      : of(new Pair(mappedCar, acc));
  }
  return acc;
}

// Pure list append (the Semigroup) — fresh spine of `a`'s elements, then `b`.
// Iterative (was self-recursive on `a`'s cdr → O(depth) host stack). Collect a's
// cars in order, then prepend them onto `b` (shared by reference, exactly as the
// recursive base `return b ?? nil` did — purity: a's spine is fresh, b untouched).
// An improper `a` still contributes its phantom `undefined` car before the non-Pair
// tail ends the walk, matching the recursive form.
function concatPair(a: unknown, b: unknown): Pair | Nil {
  const cars: unknown[] = [];
  let node: unknown = a;
  while (node && !(node instanceof Nil)) {
    const p = node as Pair;
    cars.push(p.car);
    node = p.cdr;
  }
  let result: Pair | Nil = (b ?? nil) as Pair | Nil;
  for (let i = cars.length; i--; ) {
    result = new Pair(cars[i], result);
  }
  return result;
}

// Chain = map-then-flatten. Each `f(car)` yields a list; concat them with the
// PURE list-append above — NO global_env.get("append") back-edge.
// Iterative (was self-recursive → O(depth) host stack). Map each car left-to-right
// (preserving f-call order), then concat from the right onto `nil` — the same right-
// associated fold the recursion produced, so the flattened result is identical
// (concat is associative). An improper tail still maps its phantom `f(undefined)`.
function chainPair(f: (x: unknown) => Pair | Nil, pair: unknown): Pair | Nil {
  const parts: (Pair | Nil)[] = [];
  let node: unknown = pair;
  while (node && !(node instanceof Nil)) {
    const p = node as Pair;
    parts.push(f(p.car));
    node = p.cdr;
  }
  let result: Pair | Nil = nil;
  for (let i = parts.length; i--; ) {
    result = concatPair(parts[i], result);
  }
  return result;
}

// Register Pair constructor with types.ts for Nil.append
setPairConstructor(Pair);

// Interop boundary. A cons cell's rich prototype (`match`/`fromArray`/`toArray`,
// the cycle/ref-tracking helpers) and metadata symbols (`__data__`, `__location__`)
// are reachable from any held Pair via symbol-to-field auto-resolution; the
// ref-tracking helpers in particular would leak host-side identity comparisons.
// This marker stops the prototype-chain walk at Pair before any helper is reached.
markInteropBoundary(Pair);
