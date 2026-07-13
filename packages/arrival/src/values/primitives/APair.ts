/**
 * The cons cell. Beyond car/cdr, a Pair carries its own metadata — source
 * location, datum-label/cycle marks, provenance — on the instance (symbol-keyed),
 * not in a sidecar map, so a value and its origin travel together and survive
 * structure sharing. Cyclic spines (reader datum labels, the `__tieKnot` door —
 * `set-cdr!` is a notImplemented stub, values are frozen by design) are detected
 * actively by `isCircularList` (Floyd's), which keeps spine-walking builtins from
 * spinning. The class is an interop boundary (see the note on `[CLASS]` below).
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
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { deriveSortCompare, withInputProvenance } from "../op-helpers.js";
import { type SeenMap, structuralEqual } from "../structural-equal.js";
import { type SourceLocation } from "../../errors.js";
import { is_false, is_plain_object } from "../value-guards.js";
import { is_promise } from "../../eval/guards.js";
import { promise_all } from "../../utils/promises.js";
// Circular import (benign — same pattern AVector/AJSArray already document): collapseProvenance
// deep-walks APair among other carriers, so provenance-collapse.ts imports APair back. Both
// directions are referenced only inside function bodies (concatPair/cdr here; the walk closure
// there), never at module-eval time, so the cycle never bites.
import { collapseProvenance } from "../../provenance-collapse.js";
import { reStampChild } from "./deep-restamp.js";
import { egressContainerProxy } from "../egress-proxy.js";
import { type AList, AListAlike, AListAlikeValue, APairAsListValue, type MembraneExit, type SchemeValue, } from "../types.js";
import { AString } from "./AString.js";
import { ASymbol } from "./ASymbol.js";
import { AExact } from "./AExact.js";
import { AInexact } from "./AInexact.js";
import { ANil, nil } from "./ANil.js";
import { printValue } from "../print.js";
import { chargeHeap } from "../../heap-budget.js";
import { tf } from "../tagless-final.js";
import { MaybePromise } from "../../common/symbols/_bake.js";

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
  (fn: (pair: SchemeValue, parents: AListAlike[]) => Thunk | void) => (pair: SchemeValue, parents: AListAlike[]) => {
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
 * datum labels), this ACTIVELY detects any cyclic spine regardless of how it was
 * tied (datum-label knot-tying, `__tieKnot` surgery; historically `set-cdr!`,
 * now a notImplemented stub) — the gap behind the list?/length/append/memq/
 * reverse/list-copy non-termination. Spine-walking builtins guard on this so a
 * circular list terminates (list? → #f) or raises a clean error instead of
 * spinning. Never throws; the caller decides what a cycle means.
 */
export function isCircularList(head: APair<any, any>): boolean {
  let slow = head;
  let fast = head;
  while (fast instanceof APair && fast.cdr instanceof APair) {
    slow = slow.cdr;
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
  const seen_pairs: AListAlike[] = [];
  const cycles: AListAlike[] = [];
  const refs: AListAlike[] = [];

  function visit(pair2: APair<any, any>): void {
    if (!seen_pairs.includes(pair2)) {
      seen_pairs.push(pair2);
    }
  }

  function set(node: AListAlike, type: "car" | "cdr", child: unknown, parents: AListAlike[]): boolean {
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

  const detect = trampoline(function detect_thunk(pair2: SchemeValue, parents: AListAlike[]): Thunk | void {
    if (pair2 instanceof APair) {
      const pairWithCycles = pair2;
      delete pairWithCycles[REF];
      delete pairWithCycles[CYCLES];
      visit(pair2);
      parents.push(pair2);
      const car = set(pairWithCycles, "car", pair2.car, parents);
      const cdr = set(pairWithCycles, "cdr", pair2.cdr, parents);
      if (!car) {
        detect(pair2.car, [...parents]);
      }
      if (!cdr) {
        return new Thunk(() => {
          return detect_thunk(pair2.cdr, [...parents]);
        });
      }
    }
  });

  function mark_node(node: AListAlike, type: "car" | "cdr"): void {
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
 * through HERE, each use a named reviewable act (the `makeRunContext` pattern: one designed
 * door, never ad-hoc mutation). The ugly name IS the fence; not exported from the package index.
 */
export function __tieKnot(pair: AListAlike, slot: "car" | "cdr", v: SchemeValue): void {
  (pair as unknown as { car: SchemeValue; cdr: SchemeValue })[slot] = v;
}

export class APair<Car extends SchemeValue, Cdr extends SchemeValue> extends AValue {
  // Interop boundary: a cons cell's rich prototype (match/fromArray/toArray, the cycle/ref
  // helpers) and metadata symbols (__data__/__location__) are otherwise reachable from any held
  // Pair via symbol-to-field auto-resolution — the ref-tracking helpers especially would leak
  // host-side identity comparisons. This marker stops the prototype walk at Pair.
  static [CLASS] = "pair";
  readonly kind = "pair" as const;
  [DATA]?: boolean;
  [LOCATION]?: SourceLocation;
  [CYCLES]?: { car?: string | AListAlike; cdr?: string | AListAlike };
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
  static fromArray<T extends SchemeValue>(ctx: RunContext, array: readonly T[], deep?: boolean, quote?: false): AListAlike<T>;
  static fromArray<T extends SchemeValue>(
    ctx: RunContext,
    array: readonly T[],
    deep: boolean,
    quote: true,
  ): AListAlike<T> | unknown[];
  // `quote` not known statically (the internal recursion threads the runtime flag): can't promise
  // the data-array won't flow back, so the return stays wide. No external caller hits this arm.
  static fromArray<T extends SchemeValue>(
    ctx: RunContext,
    array: readonly T[],
    deep: boolean,
    quote: boolean,
  ): AListAlike<T> | unknown[];
  static fromArray<T extends SchemeValue>(
    ctx: RunContext,
    array: readonly T[],
    deep = true,
    quote = false,
  ): AListAlike<T> | unknown[] {
    if (
      array instanceof APair ||
      (quote && Array.isArray(array) && (array as unknown as { [key: symbol]: unknown })[DATA])
    ) {
      // AListAlike<T>'s own conditional (types.ts) is DEFERRED for an abstract T — casting to
      // the parameterized alias (not the unparameterized default) documents that this pass-
      // through arm is honest for whatever T the caller instantiated, per the overloads above.
      return array as AListAlike<T> | unknown[];
    }
    const arr = Array.isArray(array) ? array : [...(array as Iterable<unknown>)];
    if (deep === false) {
      let list: AListAlike = nil;
      for (let i = arr.length; i--; ) {
        list = new APair(ctx, arr[i], list);
      }
      // Same deferred-conditional cast as above: `list` is nil | a freshly-built spine over
      // `arr`'s own elements — the base case + recursive shape AListAlike<T> always admits,
      // just not provable through the conditional while T is abstract at this call site.
      return list as AListAlike<T>;
    }
    let result: AListAlike = nil;
    let i = arr.length;
    while (i--) {
      let car: unknown = arr[i];
      if (Array.isArray(car)) {
        car = APair.fromArray(ctx, car, deep, quote);
      } else if (typeof car === "string") {
        car = new AString(ctx, car);
      } else if (typeof car === "number" && !Number.isNaN(car)) {
        car = Number.isSafeInteger(car) ? new AExact(ctx, car) : new AInexact(ctx, car);
      }
      // A raw JS `bigint` element is left untouched: per the numeric-rework law
      // (docs/working-proposals/arrival-one-number-rework.md §0/§2.3), bigint is an
      // opaque host value, not a scheme number — it rides the same pass-through lane
      // the membrane's `fromJS(bigint)` uses, rather than auto-boxing into an AExact.
      result = new APair(ctx, car as SchemeValue, result);
    }
    // Same deferred-conditional cast as the two arms above.
    return result as AListAlike<T>;
  }

  static fromPairs(ctx: RunContext, array: [string, SchemeValue][]): AListAlike {
    return this.fromArray(
      ctx,
      array.map(([left, right]) => new APair(ctx, new ASymbol(ctx, left), right)),
    );
  }

  static fromObject(ctx: RunContext, obj: Record<string, SchemeValue>): AListAlike {
    return APair.fromPairs(
      ctx,
      Object.keys(obj).map((key) => [key, obj[key]] as const),
    );
  }

  // Monoid — the empty list is the identity for list-concat.
  static ["arrival/tagless-final/empty"](): ANil {
    return nil;
  }

  // Applicative — single-element list. STRUCTURAL SENTINEL, re-verified
  // (arrival-constant-ctx-audit-2026-07-11.md §2.5): zero dispatchers/callers of
  // `tagless-final/of` repo-wide as of this pass (`grep '"arrival/tagless-final/of"\]'`).
  // A no-arg static has no crossing to derive a live ctx from — if a Monoid/Applicative
  // dispatcher ever lands, this needs a designed answer (a caller-supplied ctx param),
  // not a threaded param invented here.
  static ["arrival/tagless-final/of"](value: SchemeValue): AListAlike {
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
  flatten(): AListAlike | unknown[] {
    return APair.fromArray(this.ctx, this.to_array().flat(Infinity));
  }

  length(): number {
    let len = 0;
    let node: AListAlike | unknown = this;
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

  clone(deep = true): AListAlike {
    const visited = new Map<AListAlike, AListAlike>();
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

    return cloneNode(this) as AListAlike;
  }

  last_pair(): AListAlike | undefined {
    let node: AListAlike = this;
    while (node instanceof APair) {
      if (!(node.cdr instanceof APair)) {
        return node;
      }
      if (node.have_cycles("cdr")) {
        break;
      }
      node = node.cdr;
    }
  }

  to_array(deep = true): APairAsListValue<Car, Cdr>[] {
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
    // Honest by construction: every pushed element is `this.car` (a Car) or a spread of the
    // cdr-spine's own APairAsListValue<Car,Cdr> array — `unknown[]` is this fn's internal
    // working type (mixed car/flattened-nested pushes), the declared return is the real union.
    return result as APairAsListValue<Car, Cdr>[];
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

    let node: AListAlike = this;
    let first = true;

    while (node instanceof APair) {
      if (!first) {
        if (node[REF]) {
          parts.push(" . ", printValue(node));
          node = nil as unknown as AListAlike;
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

      node = node.cdr as AListAlike;
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

  // R9 lazy egress: the spine snapshots ONCE at proxy creation (an O(n) pointer copy —
  // a linked spine can't be lazily indexed without O(n²)); the ELEMENTS stay lazy,
  // unwrapping through their own `arrival/toJS` on first read. Improper tail folds in
  // as the last element, per the one-way list→array projection. A cyclic SPINE
  // still throws the iterator's taught invariant — an infinite list has no finite
  // array projection; cycles THROUGH elements terminate via the proxy tracker.
  ["arrival/toJS"](): unknown[] {
    const spine: SchemeValue[] = [...this];
    return egressContainerProxy(this, "array", {
      keys: () => spine.map((_, i) => String(i)),
      read: (key) => spine[Number(key)],
    }) as unknown[];
  }

  // Membrane exit (rosetta's egressAValue is the only builder of `exit`): identical
  // spine projection, but elements materialize through the full recursive crossing and
  // the proxy caches per (box, mode, SCOPE) — see egress-proxy.ts's identity laws.
  ["arrival/toJSMembrane"](exit: MembraneExit): unknown[] {
    const spine: SchemeValue[] = [...this];
    return egressContainerProxy(
      this,
      "array",
      {
        keys: () => spine.map((_, i) => String(i)),
        read: (key) => spine[Number(key)],
      },
      { membrane: exit },
    ) as unknown[];
  }

  // Setoid (Fantasy Land) — structural car/cdr equality, threading the harness's shared `seen`.
  // NO cycle bookkeeping here: structuralEqual records (this, other) BEFORE dispatching, so a
  // cyclic list (`a.cdr = a`) re-encounters the pair in the harness and short-circuits — this
  // method just recurses element-wise. A non-Pair `other` is false. (Per-type `equal?` lives
  // on the term; the abstract AValue Setoid forces it. Mirrors AVector's seen-threaded Setoid.)
  ["arrival/tagless-final/equals"](other: unknown, seen?: SeenMap): boolean {
    return (
      other instanceof APair && structuralEqual(this.car, other.car, seen) && structuralEqual(this.cdr, other.cdr, seen)
    );
  }

  /**
   * Parser/macro-attached metadata (`LOCATION`, `CYCLES`, `REF` — well-known-symbols.ts)
   * must survive — losing it breaks stack traces and reader-cycle reconstruction.
   */
  withProvenance(p: ReadonlySet<number>): APair<Car, Cdr> {
    const copy = new APair<Car, Cdr>(this.ctx, this.car, this.cdr, p);

    if (this[LOCATION] !== undefined) copy[LOCATION] = this[LOCATION];
    if (this[CYCLES] !== undefined) copy[CYCLES] = this[CYCLES];
    if (this[REF] !== undefined) copy[REF] = this[REF];
    return copy;
  }

  /** Deep re-stamp (the inbound membrane's AValue claim, moved onto the class — see the
   *  base declaration in AValue.ts). Mints a fresh cell under the CROSSING's ctx whose
   *  car/cdr re-stamp through the closed child fold — no `unknown` re-entry, no casts
   *  (the dissolved router arm carried one of the membrane's two sanctioned casts exactly
   *  because it couldn't see that car/cdr are always SchemeValue). Deliberately does NOT
   *  copy LOCATION/CYCLES/REF (unlike shallow `withProvenance`) — byte-stable with the
   *  dissolved jsToSchemeImpl arm, which minted a bare `new APair(ctx, …, p)`. */
  ["arrival/withProvenanceDeep"](
    ctx: RunContext,
    p: ReadonlySet<number>,
    seen: WeakSet<object> = new WeakSet(),
  ): APair<SchemeValue, SchemeValue> {
    seen.add(this);
    return new APair(ctx, reStampChild(this.car, ctx, p, seen), reStampChild(this.cdr, ctx, p, seen), p);
  }

  // ----------------------------------------------------------------------
  // Term algebras (arrival/tagless-final/*): Pair is the free monoid + Functor + Foldable +
  // Traversable + Chain over a list. Recursors terminate on `instanceof Nil`, not `=== nil` —
  // `nil.withProvenance(p)` mints fresh Nil clones, so reference-equality would recurse past a
  // provenance-bearing list end. Mirrors value-guards.ts:is_nil.
  // ----------------------------------------------------------------------

  *[Symbol.iterator](): Generator<APairAsListValue<Car, Cdr>> {
    const seen = new WeakSet<SchemeValue>();
    let node: SchemeValue = this;
    while (node instanceof APair) {
      TypeError.invariant(!seen.has(node), "APair[Symbol.iterator]: list cycle detected — cannot iterate a cyclic list");
      seen.add(node);
      if (node.car === undefined && node.cdr instanceof ANil) return; // empty-pair sentinel
      yield node.car;
      node = node.cdr;
    }
    // Improper tail folds in as the last element: list→array is one-way
    // (scheme list → js array → scheme vector), no round-trip promise.
    if (!(node instanceof ANil)) yield node as APairAsListValue<Car, Cdr>;
  }

  // Functor — `map` that preserves every element's box + provenance. Walks the cdr-spine
  // directly, calls `fn` per element concurrently (scheme lambdas return Promises), then rebuilds
  // a fresh spine via Pair.fromArray(_, false) — same shape as the eager `map` builtin. Results
  // are kept RAW so a SchemeString/SchemeExact element keeps its box (coercion-soundness: "map
  // preserves every element's box"). Honors the empty-pair sentinel and a
  // Nil-clone tail, same as the old mapPair.
  ["arrival/tagless-final/map"](
    fn: (x: APairAsListValue<Car, Cdr>) => MaybePromise<SchemeValue>,
    runCtx: RunContext,
  ): MaybePromise<AListAlike> {
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
    // `this = makeCallCtx(runCtx)` (flat `CallCtx`) — fixes the `this=undefined` crash a bare
    // `fn(x)` caused when the callback (e.g. `cadr`, a rosetta) reads `this.runCtx`.
    // Wave 1 (arrival-constant-ctx-audit-2026-07-11.md §4): the confession this comment
    // used to document is closed — `runCtx` is now a REQUIRED param (AValue.ts's protocol
    // declaration, mirrored here), so there is no fallback left to reach for. The sole
    // production dispatcher (`env/r7rs/lists.ts`'s single-list `map` arm) already threaded
    // a live, defined `this.runCtx` through `resolveMethod(seq, tf("map")).call(seq, fn,
    // runCtx)` before this fix — `?? CONSTANT_CTX` was dead code on every real call path,
    // verified via the dispatch chain (`common/symbols/sequence.ts`'s wrapper always
    // supplies `this.runCtx`, non-optional since Wave 0's `CallCtx` fix).
    const results = elements.map((x) => applyCallback(fn, [x], runCtx));
    // RULINGS.md R2 (naive-but-explicit strategy): map is
    // LENGTH-PRESERVING — the container's own grouping/length-fact stamp is PROXIED through
    // unchanged onto the rebuilt spine (`withInputProvenance([this], …)` unions `this`'s own
    // top-level provenance onto the fresh head; a no-op when the input carries no stamp).
    if (results.some(is_promise)) {
      // `resolved`'s settled payloads are CallResult's SchemeValue arm — the seam's
      // `canBounce: false` (see the invocation-seam comment above) rules out a bounce marker
      // reaching a HOF-applied callback's result.
      return (promise_all(results) as Promise<unknown[]>).then((resolved) =>
        withInputProvenance([this], APair.fromArray(this.ctx, resolved as SchemeValue[], false)),
      );
    }
    // Same CallResult→SchemeValue narrowing as above: `results` holds no promise (checked) and
    // no bounce marker (canBounce: false at the seam), so every element is a settled SchemeValue.
    return withInputProvenance([this], APair.fromArray(this.ctx, results as SchemeValue[], false));
  }

  // Filterable — preserves every kept element's box. Keep-rule matches the eager `filter`
  // builtin: Scheme-truthy (`!is_false`) AND nil dropped; a RegExp arg adapts via
  // `String(x).match`, a fn passes through. `pred` is awaited per element (concurrent fan —
  // scheme lambdas return Promises); kept elements re-cons shallow via Pair.fromArray(_, false), so
  // element boxes survive and the container box drops. Supersedes the old stdlib `filter`
  // builtin dispatch — the term owns the algebra.
  ["arrival/tagless-final/filter"](
    arg: ((x: unknown) => unknown | Promise<unknown>) | RegExp,
    runCtx: RunContext,
  ): MaybePromise<AListAlike> {
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
    // both invoked with a defined `this`, no bare `pred(x)` crash on a `this.runCtx`-reading callee.
    // Wave 1 (see map above) — `runCtx` required, confession closed; `env/srfi/srfi-1.ts`'s
    // `filter` dispatcher already threads a live `this.runCtx` on every real call.
    const verdicts = elements.map((x) => applyCallback(pred, [x], runCtx));
    // R7RS truthiness: ONLY #f is false — a '()-returning predicate KEEPS the element
    // (nil-as-false here was a private truthiness fork; some/every/if never had it).
    const kept = (verdict: unknown): boolean => !is_false(verdict);
    // RULINGS.md R2: filter is LENGTH-CHANGING — the container's own grouping/
    // length-fact stamp is PROVENANCED, minted fresh as the union of (a) the INPUT
    // container's own top-level stamp and (b) the decision lineage that changed the
    // length — here, the SURVIVING elements' own top-level provenance (the dropped
    // elements never flow; naive-but-explicit, not a deep walk: `withInputProvenance
    // ([this, ...survivors], …)`).
    if (verdicts.some(is_promise)) {
      return (promise_all(verdicts) as Promise<unknown[]>).then((results) => {
        const survivors = elements.filter((_, i) => kept(results[i]));
        return withInputProvenance([this, ...survivors], APair.fromArray(this.ctx, survivors, false));
      });
    }
    const survivors = elements.filter((_, i) => kept(verdicts[i]));
    return withInputProvenance([this, ...survivors], APair.fromArray(this.ctx, survivors, false));
  }

  // Canonical async-aware reduce, SRFI fold convention `fn(element, acc)` (acc last), left fold.
  // Walks the spine directly, threads the accumulator with `await`. Reproduces the eager
  // `reduce` builtin EXACTLY — `(reduce - 100 '(1 2 3 4 5))` = -97, NOT the FL acc-first 85.
  // Honors the empty-pair sentinel and a Nil-clone tail. Both the scheme `reduce` builtin and
  // fl-interop dispatch here.
  async ["arrival/tagless-final/reduce"]<Acc>(
    fn: (element: unknown, acc: Acc) => Acc | Promise<Acc>,
    initial: Acc,
    runCtx: RunContext,
  ): Promise<Acc> {
    chargeHeap(runCtx, countPairElements(this));
    let acc = initial;
    let node: unknown = this;
    while (node instanceof APair) {
      const p = node;
      if (p.car === undefined && p.cdr instanceof ANil) break; // empty-pair sentinel
      // Seam-routed. The dispatch erases the generic `Acc` return to `CallResult`, so cast back
      // at this boundary — the reducer's result IS an `Acc` (a scheme value).
      // Wave 1 (see map above) — `runCtx` required, confession closed; `symbol.tagless`'s
      // dispatcher (the sole caller of this term) always threads a live `this.runCtx`.
      acc = (await applyCallback(fn, [p.car, acc], runCtx)) as Acc;
      node = p.cdr;
    }
    return acc;
  }

  // Structure-preserving sort — stays a list (never crosses out). Collects the spine to an
  // array, sorts with `deriveSortCompare` (no comparator ⇒ elements' own
  // `arrival/tagless-final/lte` total order, so `(sort '(2 10))` is `(2 10)`, the lte-default
  // bug-fix; comparator ⇒ SRFI-95 `less?`), then re-cons SHALLOW via Pair.fromArray(_, false):
  // element boxes are preserved (only reordered). ES Array.sort is sync + stable; charges heap
  // before materializing. sort is LENGTH-PRESERVING — the container's own grouping/
  // length-fact stamp is PROXIED through unchanged (`withInputProvenance([this], …)`), same
  // convention as map above — this must agree with AVector's sort (both PROXY).
  ["arrival/tagless-final/sort"](
    comparator: ((a: unknown, b: unknown) => unknown) | undefined,
    runCtx: RunContext,
  ): AListAlike {
    chargeHeap(runCtx, countPairElements(this));
    const out: SchemeValue[] = [];
    let node: unknown = this;
    while (node instanceof APair) {
      const p = node;
      if (p.car === undefined && p.cdr instanceof ANil) break; // empty-pair sentinel
      out.push(p.car);
      node = p.cdr;
    }
    // `runCtx` threaded (Wave 1, arrival-constant-ctx-audit-2026-07-11.md §2.5's
    // deriveSortCompare row): the comparator now runs under THIS invocation's live ctx,
    // not CONSTANT_CTX — closes the metering/cache/effects leak. The SEPARATE host-schedule/
    // RegionScope wiring `region-scope.ts`'s own header names ("routing a real host
    // comparator loop through withRegionCall so a scope is open around it") is NOT done
    // here — that's order-attribution provenance tracking, a distinct Wave-4 design task,
    // not a ctx-honesty fix.
    out.sort(deriveSortCompare(comparator, runCtx));
    return withInputProvenance([this], APair.fromArray(this.ctx, out, false));
  }

  // Prefix — the first n elements as a FRESH list (SRFI-1 take), dotted-tail tolerant: the
  // `instanceof APair` guard stops the walk naturally at an improper tail or once n exceeds
  // the list's own length, so no separate improper-list branch is needed. LENGTH-CHANGING
  // (RULINGS.md R2, same family as filter/take-while below): PROVENANCED fresh, the union of
  // the INPUT container's own top-level stamp and the taken elements' own.
  ["arrival/tagless-final/take"](n: number, runCtx: RunContext): AListAlike {
    const out: SchemeValue[] = [];
    let node: unknown = this;
    let k = n;
    while (k > 0 && node instanceof APair) {
      if (node.car === undefined && node.cdr instanceof ANil) break; // empty-pair sentinel
      out.push(node.car);
      node = node.cdr;
      k--;
    }
    chargeHeap(runCtx, out.length);
    return withInputProvenance([this, ...out], APair.fromArray(this.ctx, out, false));
  }

  // Suffix — the n-th cdr ITSELF (SRFI-1 drop): shared structure, not a rebuild, so this is a
  // pure projection — no fresh cell, no heap charge, no re-stamp (mirrors `arrival/tagless-
  // final/cdr`'s "compute directly on the term" register, but hands back the tail node whole
  // rather than peeling one layer). The same `instanceof APair` guard gives dotted-tail
  // tolerance: an improper tail or n past the list's own length just stops the walk and
  // returns whatever node is standing there (a Pair, the dotted tail, or nil).
  ["arrival/tagless-final/drop"](n: number, _runCtx: RunContext): SchemeValue {
    let node: SchemeValue = this;
    let k = n;
    while (k > 0 && node instanceof APair) {
      if (node.car === undefined && node.cdr instanceof ANil) return node.cdr; // empty-pair sentinel
      node = node.cdr as SchemeValue;
      k--;
    }
    return node;
  }

  // Longest satisfying prefix (SRFI-1 take-while) — fresh list, same LENGTH-CHANGING
  // provenance convention as take above. The predicate walk is SEQUENTIAL, not filter's
  // concurrent fan: take-while must stop at the FIRST falsy verdict, which a concurrent
  // Promise.all over the whole spine can't express (it would force-evaluate every element
  // before any verdict is known).
  async ["arrival/tagless-final/take-while"](
    pred: (x: unknown) => unknown | Promise<unknown>,
    runCtx: RunContext,
  ): Promise<AListAlike> {
    const out: SchemeValue[] = [];
    let node: unknown = this;
    while (node instanceof APair) {
      if (node.car === undefined && node.cdr instanceof ANil) break; // empty-pair sentinel
      const verdict = await applyCallback(pred, [node.car], runCtx);
      if (is_false(verdict)) break; // R7RS: only #f is false — nil verdicts continue
      out.push(node.car);
      node = node.cdr;
    }
    chargeHeap(runCtx, out.length);
    return withInputProvenance([this, ...out], APair.fromArray(this.ctx, out, false));
  }

  // The take-while remainder (SRFI-1 drop-while) — SHARED tail, same pure-projection register
  // as drop above (no heap charge, no re-stamp). Same sequential-predicate discipline as
  // take-while: stop at the first falsy verdict and return the node standing there whole.
  async ["arrival/tagless-final/drop-while"](
    pred: (x: unknown) => unknown | Promise<unknown>,
    runCtx: RunContext,
  ): Promise<SchemeValue> {
    let node: SchemeValue = this;
    while (node instanceof APair) {
      if (node.car === undefined && node.cdr instanceof ANil) return node.cdr; // empty-pair sentinel
      const verdict = await applyCallback(pred, [node.car], runCtx);
      if (is_false(verdict)) return node; // R7RS: only #f is false
      node = node.cdr as SchemeValue;
    }
    return node;
  }

  // Element-count. Interim fix (RULINGS.md R2): `length` reads the CONTAINER's
  // OWN flat grouping/length-fact stamp (`withInputProvenance([this], count)` unions just
  // `this`'s own top-level provenance) — it no longer deep-walks the spine unioning every
  // element's box. A pure count depends only on cardinality, not on what each element
  // became; the container's own stamp is already an accurate synopsis by construction
  // (MINTED at `list`/`cons`, PROXIED through map/sort, PROVENANCED fresh by filter/concat —
  // see the term×carrier law table, _tables/terms.ts). Still throws "length: circular list"
  // on a cycle, matching the base stdlib `length`'s error; still honors the empty-pair
  // sentinel (both checks only touch cardinality, never element boxes).
  ["arrival/tagless-final/length"](_runCtx?: unknown): AValue | number {
    if (isCircularList(this)) throw new TypeError("length: circular list");
    let count = 0;
    let node: SchemeValue = this;
    while (node instanceof APair) {
      if (node.car === undefined && node.cdr instanceof ANil) break; // empty-pair sentinel
      count++;
      node = node.cdr;
    }
    return withInputProvenance([this], count);
  }

  // car/cdr compute directly on the term (mirrors map/filter/reduce) rather than routing
  // through the env-resolved scheme builtin. Result inherits ONLY the element's own provenance,
  // never the container's — `withInputProvenance` re-stamps an AValue element with its own
  // provenance (a no-op clone preserving identity); a raw element passes through unchanged.
  ["arrival/tagless-final/car"](): Car {
    return withInputProvenance([this.car], this.car);
  }

  ["arrival/tagless-final/cdr"](): Cdr {
    const cdr = this.cdr;
    // A projected sub-spine (the tail is itself a Pair) is a REBUILD boundary the same way
    // append/list's fresh cells are: the sub-spine's own flat stamp was never set when the
    // outer list was constructed (only the OUTER head got `withInputProvenance`'d), so a bare
    // `withInputProvenance([cdr], cdr)` finds nothing to union (cdr's own provenance is empty)
    // and silently returns the unstamped cell — the "rebuild therefore drops" bug. The fix:
    // stamp the returned sub-spine with the DEEP union of what it still reaches (conservation,
    // naive strategy) — never minted, only the ids already living on its own elements.
    if (cdr instanceof APair) {
      const deep = collapseProvenance(cdr);
      if (deep.size === 0) return cdr;
      const merged = cdr.provenance.size === 0 ? deep : new Set([...cdr.provenance, ...deep]);
      return cdr.withProvenance(merged) as Cdr;
    }
    return withInputProvenance([cdr], cdr);
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

  // Semigroup — list append. `this ⋄ other` = this list's elements followed by other's. Pure:
  // builds a fresh spine, never mutates either operand.
  ["arrival/tagless-final/concat"]<T extends AListAlike>(other: T): AConcatPair<APair<Car, Cdr>, T> {
    return concatPair<APair<Car, Cdr>, T>(this.ctx, this, other);
  }
}

function traversePair(
  ctx: RunContext,
  // `of` lifts ANY SchemeValue into the applicative — it's called with both `nil` (the fold
  // seed) and a freshly-built `APair` (the leaf-wrap below), never just an APair.
  of: (x: SchemeValue) => SchemeValue,
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
  while (node instanceof APair) {
    heads.push(f(node.car));
    node = node.cdr;
  }
  let acc: SchemeValue = of(nil);
  for (let i = heads.length; i--; ) {
    const mappedCar = heads[i];
    const apFn = (mappedCar as AValue | null | undefined)?.[tf("ap")];
    // `ap`'s declared return is `unknown` (AValue's dynamic-dispatch key, no implementer yet) —
    // the Applicative contract it stands in for always answers with a SchemeValue, same as
    // every other tagless term.
    acc = apFn ? (apFn.call(mappedCar, acc) as SchemeValue) : of(new APair(ctx, mappedCar as SchemeValue, acc));
  }
  return acc;
}

type AConcatPair<Car extends SchemeValue, Cdr extends AListAlike> =
  Car extends APair<infer Caar, infer Cadr>
    ? Cadr extends ANil
      ? APair<Caar, Cdr>
      : APair<Car, AConcatPair<Cadr, Cdr>>
    : APair<Car, Cdr>;

// todo move to tagless-final/concat
// Pure list append (the Semigroup) — fresh spine of `a`'s elements, then `b`. Iterative (was
// self-recursive on `a`'s cdr → O(depth) host stack): collect a's cars in order, then prepend
// them onto `b` (shared by reference — purity: a's spine is fresh, b untouched). An improper
// `a` still contributes its phantom `undefined` car before the non-Pair tail ends the walk.
export function concatPair<Car extends SchemeValue, Cdr extends AListAlike>(
  ctx: RunContext,
  a: Car,
  b: Cdr,
): AConcatPair<Car, Cdr> {
  const cars: SchemeValue[] = [];
  let node: unknown = a;
  while (node instanceof APair) {
    cars.push(node.car);
    node = node.cdr;
  }
  let result: AListAlike = b ?? nil;
  for (let i = cars.length; i--; ) {
    result = new APair(ctx, cars[i], result);
  }
  // The rebuilt spine's fresh head cell carries NO stamp of its own by construction (same
  // rebuild-drop shape cdr's fix above addresses) — stamp it with the union of BOTH operands'
  // deep element provenance (conservation; matches cons/list's convention of unioning onto
  // the produced cell, generalized past the one-level union since either operand may itself be
  // an unstamped rebuilt spine).
  if (result instanceof APair) {
    const deep = new Set([...collapseProvenance(a), ...collapseProvenance(b)]);
    if (deep.size > 0) result = result.withProvenance(deep);
  }
  return result as AConcatPair<Car, Cdr>;
}

/** Element count of a pair's cdr-spine (honoring the empty-pair sentinel) — the heap-charge
 *  basis for the materializing tagless terms. Module-side plain count, no provenance (unlike
 *  `arrival/tagless-final/length`, which carries the elements' grounding). */
function countPairElements(head: APair<any, any> | ANil): number {
  let n = 0;
  let node: unknown = head;
  while (node instanceof APair) {
    if (node.car === undefined && node.cdr instanceof ANil) break; // empty-pair sentinel
    n++;
    node = node.cdr;
  }
  return n;
}
