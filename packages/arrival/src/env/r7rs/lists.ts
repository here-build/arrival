/**
 * List ops — the R7RS § 6.4 pairs-and-lists cluster: constructors, accessors,
 * mutators (doored), copy, and the search functions (memq/memv/assq/assv/
 * member/assoc). The c[ad]+r accessor family is intentionally NOT declared here
 * — those are served by a resolver, not this pack.
 *
 * Each op declares a SCHEME-IDENTITY zod contract (no codec, no runtime
 * validation — "zod for types purely") and an impl bound raw. List args are
 * typed `Pair | Nil` (the proper-list domain; the defensive improper-list
 * passthrough is robustness, not the declared domain), indices are the
 * `schemeNumber` tower, the searched object and copied/returned cells are
 * representation-blind (`z.value`), and the optional user comparator is the
 * types-only `z.custom` binary predicate.
 */

// Installs the global \`TypeError.invariant\` assertion helper used by the
// list-bounds and circular-list guards below (side-effect import).
import "@here.build/error-invariant";
import { CONSTANT_CTX, type RunContext } from "../../values/primitives/RunContext.js";
import { applyCallback } from "../../values/primitives/ACallable.js";
import { CallCtx } from "../../common/symbols/_bake.js";

import * as z from "../../common/scheme-zod.js";
import { type MaybePromise, resolveMethod, symbol } from "../../common/symbol.js";
import { schemeFalse, withInputProvenance } from "../../values/op-helpers.js";
import invariant from "tiny-invariant";
import { APair, concatPair, isCircularList } from "../../values/primitives/APair.js";
import { ctxOf } from "../../values/primitives/AValue.js";
import { is_false, is_function, is_promise } from "../../eval/guards.js";
import { type, typeErrorMessage } from "../../utils/typecheck.js";
import { heapBudgetMessage } from "../../heap-budget.js";
import { ArrivalError } from "../../eval/evaluator.js";
import { eqv, structuralEqual } from "../../values/structural-equal.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { type AVoid, theVoid } from "../../values/primitives/AVoid.js";
import { AExact } from "../../values/primitives/AExact.js";
import { EnvCapability } from "../../common/capability.js";
import { AHalfBaked, is_half_baked } from "../../values/primitives/AHalfBaked.js";
import { SPECULATE } from "../../well-known-symbols.js";
import { call_function } from "../../eval/call-function.js";
import { promise_all } from "../../utils/promises.js";
import { tf } from "../../values/tagless-final.js";
import type { AList, AProcedure, SchemeValue } from "../../values/types.js";

// A JS value used as a Scheme procedure IS the SchemeValue function member
// `(...args: SchemeValue[]) => SchemeValue` (types.ts). `is_function`/`typeof`
// over `unknown` only yield the bare `Function` type, which lacks the call
// signature `call_function`/`apply` need — this refines the predicate to the
// procedure shape the union already names.
const is_callable = (o: unknown): o is (...args: SchemeValue[]) => SchemeValue => is_function(o);

// Pack-local copies of the list<->array bridge helpers. The stdlib originals
// (`listToArray`/`arrayToList`/`to_array`/`isProperList`) stay in stdlib.ts for
// its remaining consumers; these reproduce the same logic byte-for-byte (incl.
// the per-run heap-meter charge `to_array` levies at the collection choke) so
// the relocated defs are behavior-identical.
function to_array(name: string): (list: AList) => SchemeValue[] {
  return function recur(list: AList): SchemeValue[] {
    if (list instanceof ANil) {
      return [];
    }
    invariant(!isCircularList(list), `${name}: can't convert a circular list`);
    // Heap meter off the OPERAND's ctx: a run-built list carries the run's RunContext;
    // a quoted literal carries CONSTANT_CTX → no meter (and is parse-bounded anyway).
    const meter = ctxOf(list).heapMeter;
    const result: SchemeValue[] = [];
    let node: unknown = list;
    while (true) {
      if (node instanceof APair) {
        if (node.have_cycles("cdr")) {
          break;
        }
        result.push(node.car);
        if (meter !== undefined && ++meter.used > meter.max) {
          throw new ArrivalError(heapBudgetMessage(meter.max), []);
        }
        node = node.cdr;
      } else {
        invariant(node instanceof ANil, `${name}: can't convert improper list`);
        break;
      }
    }
    return result;
  };
}
const listToArray = to_array("list->array");

function arrayToList(array: SchemeValue[]): SchemeValue {
  return APair.fromArray(CONSTANT_CTX, array);
}

function isProperList(obj: SchemeValue): boolean {
  // A circular list is NOT a proper list (R7RS). Detect runtime cycles.
  if (obj instanceof APair && isCircularList(obj)) {
    return false;
  }
  let node = obj;
  while (true) {
    if (node instanceof ANil) return true;
    if (!(node instanceof APair)) return false;
    if (node.have_cycles("cdr")) return false;
    node = node.cdr;
  }
}

// `length` carries the Tier-2 speculation marker: the evaluator's dispatch choke
// leaves a still-filling collection's HalfBaked UNFORCED for ops whose impl has
// [SPECULATE]=true, so length reads the lazy cardinality interval itself instead
// of a settled value (see evaluator.ts dispatch).
const lengthImpl = (obj: unknown): SchemeValue => {
  // R7RS length is an exact integer — box to AExact, matching string-length.
  if (obj == null) return new AExact(CONSTANT_CTX, 0n);
  // Tier 2 speculation: length of a still-filling collection is its narrowing
  // cardinality INTERVAL, surfaced as a number-domain HalfBaked the comparison ops
  // read for early collapse (reached only when speculation is on).
  if (is_half_baked(obj)) {
    return obj.toCardinalityNumber();
  }
  // Dispatch to the operand's OWN arrival/tagless-final/length — the per-primitive count
  // carries the ELEMENTS' unioned provenance and levies the circular-list check. TOTALIC:
  // a receiver with no length algebra is a type error, never a silent 0. A non-term
  // carrier with a bare `.length` (a membrane-wrapped JS array) falls back to that property.
  const m = (obj as Record<string, unknown>)[tf("length")];
  if (typeof m === "function") {
    return (m as () => SchemeValue).call(obj);
  }
  if (typeof obj === "object" && "length" in obj) {
    const len = obj.length;
    if (typeof len === "number") return withInputProvenance([obj], new AExact(CONSTANT_CTX, BigInt(len)));
  }
  throw new TypeError(`length: the ${typeof obj} operand does not support length (no arrival/tagless-final/length).`);
};
(lengthImpl as { [SPECULATE]?: boolean })[SPECULATE] = true;

// Multi-list `map` is a ZIP (not a Functor op): apply fn to corresponding elements
// across the lists, truncating to the shortest. Speculation rides here too
// (cardBounds [1,1], the count is exact up front), carrying early-collapse through
// a multi-list map.
function multiListMap(
  fn: AProcedure,
  lists: readonly AList[],
  runCtx: RunContext,
): SchemeValue | Promise<SchemeValue> {
  if (lists.some((list) => list instanceof ANil)) return nil;
  const arrays = lists.map((l) => listToArray(l));
  const len = Math.min(...arrays.map((a) => a.length));
  const results: SchemeValue[] = [];
  for (let i = 0; i < len; i++) {
    results.push(
      call_function(
        fn,
        arrays.map((a) => a[i]),
        { runCtx },
      ),
    );
  }
  if (runCtx?.speculate && results.some(is_promise)) {
    const slots = results.map((r) => Promise.resolve(r).then((v) => [v as SchemeValue]));
    return AHalfBaked.collection(ctxOf(lists[0]), slots, () => [1, 1]);
  }
  if (results.some(is_promise)) {
    return (promise_all(results) as Promise<unknown[]>).then((resolved) =>
      APair.fromArray(ctxOf(lists[0]), resolved as SchemeValue[]),
    );
  }
  return APair.fromArray(ctxOf(lists[0]), results);
}

// `mapImpl` — the parallel zip-map that `for-each` runs for its side effects (it
// discards the result list). Overlaps `multiListMap` above but is kept separate:
// mapImpl's per-arg `isProperList` cycle-check raises "map: argument N is not a
// list", whereas multiListMap lets listToArray raise its own circular-list error.
// Unifying the two is a deferred behavior-preserving cleanup.
function mapImpl(fn: SchemeValue, ...lists: Array<AList>): SchemeValue | Promise<SchemeValue> {
  // `typecheck` guarantees callability at runtime but is not a TS guard; re-state it
  // as a type-level assertion so `call_function` sees the JS-callable it needs.
  invariant(is_callable(fn), `map: the first argument is not a procedure`);
  const is_list = isProperList;
  for (const [i, arg] of lists.entries()) {
    // detect cycles
    invariant(!(arg instanceof APair) || is_list(arg), `map: argument ${i + 1} is not a list`);
  }
  if (lists.length === 0 || lists.some((list) => list instanceof ANil)) {
    return nil;
  }

  // Convert lists to arrays for parallel processing
  const arrays = lists.map((l) => listToArray(l));
  const length = Math.min(...arrays.map((a: SchemeValue[]) => a.length));

  const results: SchemeValue[] = [];
  for (let i = 0; i < length; i++) {
    const args = arrays.map((arr: SchemeValue[]) => arr[i]);
    results.push(call_function(fn, args, {}));
  }

  const hasPromises = results.some(is_promise);
  // Tier-2 speculation: map's count is exact up front (one output per input →
  // bounds [1,1]), so its HalfBaked interval is already a point — length is
  // decidable immediately while values still resolve.
  // Speculation is run-constant; read it off the operand (lists[0] is a non-nil pair here,
  // so it carries the run's RunContext). for-each discards this result, so the HalfBaked vs
  // eager-list choice is inert for correctness — behavior-shape preserved.
  if (hasPromises && ctxOf(lists[0]).speculate) {
    const slots = results.map((r) => Promise.resolve(r).then((v) => [v as SchemeValue]));
    return AHalfBaked.collection(ctxOf(lists[0]), slots, () => [1, 1]);
  }
  if (hasPromises) {
    return (promise_all(results) as Promise<unknown[]>).then((resolved) =>
      APair.fromArray(ctxOf(lists[0]), resolved as SchemeValue[]),
    );
  }
  return APair.fromArray(ctxOf(lists[0]), results);
}

export default new EnvCapability("scheme/lists", {
  symbols: {
    // R7RS 6.10 — map. A combinator: ONE list dispatches to the operand's own arrival/tagless-final/
    // map (Pair preserves boxes + speculates [1,1]; Vector strips boxes, eager) — the term owns the
    // algebra + its eval strategy; SEVERAL lists is a zip (multiListMap). ctx-aware for runCtx.
    map: symbol.sequence`map: fn over one list (its own term map — box discipline + speculation) or a zip over several`(
      // fn is the fixed HEAD; the further lists/vectors are the variadic TAIL —
      // `symbol.sequence`'s factory type has no Rest generic, so a hand-authored
      // z.tuple(fixed, rest) is the only available shape (matches srfi-1.ts's filter).
      // The rest is z.value, NOT z.union([z.pair, z.nil]): a further "list" argument here
      // is any sequence answering arrival/tagless-final/map (Pair, Nil, OR Vector — see
      // the impl's single-list dispatch below), so a pair|nil union would wrongly exclude
      // the vector case. Output is z.value: both dispatch paths (the tf("map") protocol
      // member, and multiListMap) declare SchemeValue | Promise<SchemeValue>, never a
      // raw-primitive leak.
      // The z.custom callable head is UNREPRESENTABLE to the harvest printer, collapsing
      // signatureOf to the catch-all `(...args: unknown[]) => unknown`. `type` author-
      // asserts the real shape: fn-first over a REPRESENTATION-AGNOSTIC sequence rest —
      // map dispatches to Pair/Nil/Vector terms, so narrowing the rest to a List would be
      // false (it would exclude the vector case).
      {
        input: z.tuple([z.lambda], z.value),
        output: [z.value],
        fanout: true,
        type: "<R>(fn: (...args: unknown[]) => R, ...lists: unknown[]) => R[]",
      },
      (args, runCtx) => {
        const [fn, ...lists] = args;
        if (lists.length === 1) {
          const seq = lists[0];
          const m = resolveMethod(seq, tf("map"));
          if (m === undefined) {
            throw new TypeError(
              `map: the ${seq == null ? String(seq) : typeof seq} operand does not support map (no ${tf("map")}).`,
            );
          }
          // The tagless-final map/vector-map term algebra declares SchemeValue | Promise<SchemeValue>
          // (this file's own header comment) — `resolveMethod`'s TermMethod return is `unknown` (it
          // resolves ANY term method, not just this one's specific protocol), so the assertion states
          // that documented, real invariant rather than widening the contract's own DecodedReturn.
          return m.call(seq, fn, runCtx) as MaybePromise<SchemeValue>;
        }
        return multiListMap(fn, lists as readonly AList[], runCtx);
      },
    ),
    // R7RS 6.4 — for-each: like map but run for side effects, returning unspecified.
    "for-each": symbol.native`for-each: apply fn to corresponding elements of one or more lists, for side effects`(
      // fn is the fixed HEAD (`input`); the spread lists are the variadic TAIL (`inputRest`) —
      // mirrors apply's own head/rest split, using the callable-schema convention
      // (z.custom<(...args) => T>()) established by vector-map/vector-for-each/curry. Each
      // rest element is genuinely a proper list (typecheck'd below), so inputRest is
      // z.union([z.pair, z.nil]) — NOT map's agnostic z.value, since for-each is list-only.
      // Output is UNSPECIFIED (R7RS §6.4) — z.undefinedResult, matching string-for-each/
      // vector-for-each.
      {
        input: [z.lambda],
        inputRest: z.union([z.pair, z.nil]),
        output: [z.undefinedResult],
        // The z.custom callable head collapses signatureOf to the catch-all. `type`
        // author-asserts fn-first over a list-only rest (`Cons<unknown> | null`) → `void`.
        type: "(fn: (...args: unknown[]) => unknown, ...lists: (Cons<unknown> | null)[]) => void",
      },
      // Runs mapImpl for its side effects and discards the result list.
      (fn, ...lists) => {
        const ret = mapImpl(fn, ...lists);
        // R7RS "unspecified" is theVoid on the scheme face (Face split; the bare JS
        // undefined return relied on downstream boxing).
        if (is_promise(ret)) {
          return ret.then(() => theVoid);
        }
        return theVoid;
      },
    ),
    // R7RS 6.4 Pairs and lists
    cons: symbol.native`cons: a pair (car . cdr) — the fundamental list constructor`(
      // car/cdr are any scheme value — the whole point of cons is to hold arbitrary
      // scheme values, so z.value (SchemeValue identity) is the honest domain.
      { input: [z.value, z.value], output: [z.pair] },
      // A constructor: unions both inputs' provenance over the produced cell
      // (parallel to make-list / list, which stamp only the produced Pair).
      (car, cdr) => withInputProvenance([car, cdr], new APair(CONSTANT_CTX, car as SchemeValue, cdr as SchemeValue)),
    ),

    // R7RS 6.4 — `list` builds a proper list of its arguments. A constructor, so —
    // like cons and make-list — it unions the inputs' provenance over the produced
    // head only.
    list: symbol.native`list: a proper list of its arguments`(
      { input: z.array(z.value), output: [z.value] },
      (...args: SchemeValue[]): SchemeValue => {
        const result = args.reduceRight((list, item) => new APair(CONSTANT_CTX, item, list), nil);
        return withInputProvenance(args, result);
      },
    ),

    // ── PURITY DOORS — pair/list mutators OMITTED by design (R7RS §6.4) ──────────
    // arrival values are frozen: a writing method would falsify the construction-site
    // provenance every value carries. These doors (errors-as-doors) teach the why and
    // route to the fresh-allocation alternative.
    "set-car!": symbol.notImplemented`set-car!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (cons / list)`,
    "set-cdr!": symbol.notImplemented`set-cdr!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (cons / list)`,
    "append!": symbol.notImplemented`append!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (append, which builds a fresh list)`,

    // R7RS 6.4 — length is the speculation-marked impl declared at module scope above
    // (the inline arrow form cannot carry the [SPECULATE] symbol the dispatch choke reads).
    length: symbol.native`length: the number of elements in a proper list (or any .length carrier)`(
      { input: [z.value], output: [z.value] },
      lengthImpl,
    ),

    apply: symbol.native`apply: call fn with the leading args prepended to the final list argument`(
      // R7RS §6.10: (apply proc arg₁ … argₙ arg-list) ≡ (proc arg₁ … argₙ . arg-list), n ≥ 0.
      // The callable is the fixed HEAD (`input`); the leading args AND the final list are the
      // variadic TAIL (`inputRest`) — apply's own shape for the `Contract.inputRest` mechanism.
      // The last tail element is the list to splice; everything before it is prepended verbatim.
      {
        input: [z.lambda],
        inputRest: z.value,
        output: [z.value],
        type: "<T>(proc: (...args: unknown[]) => T, ...argsThenList: unknown[]) => T",
      },
      // The final tail element must be a PROPER list — `listToArray` (pack-local, the same
      // to_array the bridge used) is the door: it rejects an improper/atom final arg loudly
      // ("can't convert improper list") rather than crashing on a non-iterable spread.
      function (this: CallCtx, fn: unknown, ...rest: unknown[]) {
        invariant(rest.length > 0, "apply: requires an argument list as the final argument");
        const spread = listToArray(rest[rest.length - 1] as AList);
        // Seam-routed: `fn` is a callable VALUE (ANativeProcedure/lambda) now, not a bare fn.
        // applyCallback pins canBounce=false, so a Bounce never reaches here — the CallResult
        // narrows to value-or-promise.
        return applyCallback(fn, [...rest.slice(0, -1), ...spread], this.runCtx) as SchemeValue | Promise<SchemeValue>;
      },
    ),

    "make-list": symbol.native`make-list: build a list of k copies of fill (default #f)`(
      // fill is any scheme value (z.value) — matches cons's car/cdr reasoning. Output is
      // z.union([z.pair, z.nil]), not the wider z.value: make-list is a CONSTRUCTOR that
      // ALWAYS produces a well-formed proper list (nil when k=0, else a pair chain) —
      // unlike list-tail/list-copy (which can inherit an improper tail from their INPUT) or
      // list-ref (which extracts a single element), so pair|nil is the honest, runtime-
      // testable ceiling (see lists-contract-precision.test.ts).
      { input: [z.schemeNumber, z.value.optional()], output: [z.union([z.pair, z.nil])] },
      (k: unknown, fill?: unknown): AList => {
        const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
        // The default fill is #f — the flyweight ABool (Face split), not a raw JS false.
        const value: SchemeValue = fill === undefined ? schemeFalse : (fill as SchemeValue);
        let result: AList = nil;
        for (let i = 0; i < count; i++) {
          result = new APair(CONSTANT_CTX, value, result);
        }
        // Stamp the head Pair only — internal cons cells share the same lineage
        // by definition; downstream traversal reads provenance off whichever pair
        // is bound. Parallel to lips.ts \`cons\` which only stamps the produced cell.
        return withInputProvenance(fill === undefined ? [k] : [k, fill], result);
      },
    ),

    "list-tail": symbol.native`list-tail: the sublist obtained by dropping the first k elements`(
      // Output is z.value, NOT narrowed to z.union([z.pair, z.nil]): the walked-to position
      // can be an IMPROPER list's dangling tail (e.g. (list-tail '(1 2 . 3) 2) => 3, a bare
      // number), so z.value is the honest ceiling (matches list-ref/list-copy below).
      { input: [z.union([z.pair, z.nil]), z.schemeNumber], output: [z.value] },
      function (list, k) {
        const count = k.valueOf();
        let current: SchemeValue = list;
        for (let i = 0; i < count; i++) {
          TypeError.invariant(current instanceof APair, `list-tail: list too short`);
          current = current.cdr;
        }
        return current;
      },
    ),

    "list-ref": symbol.native`list-ref: the element at index k`(
      // Output is z.value: the element at an index is any scheme value (e.g.
      // (list-ref '(1 2 3) 0) => 1, a bare number, not a list), not a pair|nil union.
      { input: [z.union([z.pair, z.nil]), z.schemeNumber], output: [z.value] },
      (list, k) => {
        const count = k.valueOf();
        let current: SchemeValue = list;
        for (let i = 0; i < count; i++) {
          TypeError.invariant(current instanceof APair, `list-ref: list too short`);
          current = current.cdr;
        }
        TypeError.invariant(current instanceof APair, `list-ref: index out of bounds`);
        return current.car;
      },
    ),

    // list-set! is doored: the last surviving in-place spine mutator (set!/set-car!/
    // set-cdr!/vector-set!/string-fill! are all doored by the same purity invariant) —
    // an in-place write falsifies the construction-site provenance the spine carries.
    "list-set!": symbol.notImplemented`list-set!: every value is frozen by design — mutating a list in place would falsify the provenance lineage its spine carries; build the updated list instead (e.g. (append (list-head lst k) (list obj) (list-tail lst (+ k 1))))`,

    "list-copy": symbol.native`list-copy: a fresh copy of the list spine (R7RS freshness)`(
      // Output is z.value: like list-tail, list-copy explicitly tolerates an IMPROPER
      // list (the !(lst instanceof APair) branch below returns the dangling tail as-is).
      { input: [z.union([z.pair, z.nil])], output: [z.value] },
      (list) => {
        // === nil would miss Nil CLONES (singletons minted via withProvenance by the
        // evaluator's control-flow provenance pass): a clone would bypass this guard,
        // fall to the improper-list branch below, and alias the input by reference —
        // violating list-copy's fresh-allocation contract. instanceof ANil catches both
        // the singleton and any clones.
        if (list instanceof ANil) return nil;
        if (!(list instanceof APair)) return list;
        TypeError.invariant(!isCircularList(list), "list-copy: circular list");
        const copy = (lst: SchemeValue): SchemeValue => {
          // Same clone-aware check at the recursion base — see the top-level guard above.
          if (lst instanceof ANil) return nil;
          if (!(lst instanceof APair)) return lst; // improper list tail
          return new APair(CONSTANT_CTX, lst.car, copy(lst.cdr));
        };
        // Copy is a fresh allocation but semantically the same lineage as `list`.
        return withInputProvenance([list], copy(list));
      },
    ),

    // R7RS 6.4 List searching functions.
    //
    // memq/memv/assq/assv/member/assoc's output — all six — is z.union([z.value,
    // z.booleanFalse]), not a bare z.value: each returns EITHER a matched sublist/entry
    // OR a raw, unboxed JS `false` sentinel on no-match (the interpreter boxes it
    // downstream — the same pattern used pervasively across this codebase). z.value
    // alone would silently exclude the real false-return path.
    memq: symbol.native`memq: first sublist whose car is eq? to obj, else #f`(
      // obj stays z.value BY DESIGN: eq?'s raw === identity compare is the canonical
      // representation-blind case (scheme-zod.ts's own doc comment: "a predicate that
      // classifies host JS too — eq?, bytevector?") — not imprecision to fix.
      { input: [z.value], inputRest: z.pair, output: [z.union([z.pair, z.booleanFalse])] },
      (obj, list) => {
        let current: unknown = list;
        TypeError.invariant(!isCircularList(list), "memq: circular list");
        while (current instanceof APair) {
          // eq? comparison (object identity)
          if (current.car === obj) return current;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    memv: symbol.native`memv: first sublist whose car is eqv? to obj, else #f`(
      // `eqv` compares Scheme values, so the search key is `z.value` (not the
      // representation-blind `z.unknown` memq uses for its `===` identity test).
      { input: [z.value, z.union([z.pair, z.nil])], output: [z.union([z.value, z.booleanFalse])] },
      (obj, list) => {
        let current: unknown = list;
        TypeError.invariant(!isCircularList(list), "memv: circular list");
        while (current instanceof APair) {
          if (eqv(current.car, obj)) return current;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    assq: symbol.native`assq: first alist entry whose car is eq? to obj, else #f`(
      // obj stays z.value BY DESIGN — same eq? reasoning as memq above.
      { input: [z.value, z.union([z.pair, z.nil])], output: [z.union([z.value, z.booleanFalse])] },
      (obj, alist) => {
        let current: unknown = alist;
        TypeError.invariant(!isCircularList(alist), "assq: circular list");
        while (current instanceof APair) {
          const pair = current.car;
          if (pair instanceof APair && pair.car === obj) return pair;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    assv: symbol.native`assv: first alist entry whose car is eqv? to obj, else #f`(
      // `eqv` compares Scheme values → the search key is `z.value` (cf. assq's `===`).
      { input: [z.value, z.union([z.pair, z.nil])], output: [z.union([z.value, z.booleanFalse])] },
      (obj, alist) => {
        let current: unknown = alist;
        TypeError.invariant(!isCircularList(alist), "assv: circular list");
        while (current instanceof APair) {
          const pair = current.car;
          if (pair instanceof APair && eqv(pair.car, obj)) return pair;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    // member uses equal? (deep structural equality) — obj is z.value, matching memv/assv
    // (unlike memq/assq's raw === identity). compare's declared return is `unknown`, not
    // `boolean`: a user-supplied Scheme predicate returns a boxed SchemeBool post-L1 (a
    // truthy JS object), so the body routes it through is_false rather than trusting it
    // as a raw JS boolean.
    member: symbol.native`member: first sublist whose car is equal? to obj (or per compare), else #f`(
      {
        input: [z.value, z.union([z.pair, z.nil]), z.lambda.optional()],
        output: [z.union([z.value, z.booleanFalse])],
        // The optional z.custom compare collapses signatureOf to the catch-all; `type` restores
        // the real shape — same as the non-degraded memq/memv siblings (obj + `Cons<unknown> |
        // null` list → `unknown | false`), plus the optional binary comparator.
        type: "(obj: unknown, list: Cons<unknown> | null, compare?: (a: unknown, b: unknown) => unknown) => unknown | false",
      },
      (obj, list, compare = structuralEqual) => {
        let current: unknown = list;
        TypeError.invariant(!isCircularList(list), "member: circular list");
        while (current instanceof APair) {
          // `cmp` may be a user-supplied Scheme predicate whose result is a boxed
          // SchemeBool post-L1 (a truthy JS object); route through is_false.
          if (!is_false(compare(obj, current.car))) return current;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    // assoc uses equal? (deep structural equality) — same obj/compare/output precision as
    // member above. R7RS §6.4 (assq/assv/assoc trio) — assq/assv live above; this is the
    // structural-equality member of the trio, not a LIPS extension.
    assoc: symbol.native`assoc: first alist entry whose car is equal? to obj (or per compare), else #f`(
      {
        input: [z.value, z.union([z.pair, z.nil]), z.lambda.optional()],
        output: [z.union([z.value, z.booleanFalse])],
        // Same degrade + author-assertion as `member` above (the alist search twin).
        type: "(obj: unknown, alist: Cons<unknown> | null, compare?: (a: unknown, b: unknown) => unknown) => unknown | false",
      },
      (obj, alist, compare = structuralEqual) => {
        let current: unknown = alist;
        TypeError.invariant(!isCircularList(alist), "assoc: circular list");
        while (current instanceof APair) {
          const pair = current.car;
          // `compare` may be a user-supplied Scheme predicate → boxed SchemeBool post-L1.
          if (pair instanceof APair && !is_false(compare(obj, pair.car))) return pair;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    append: symbol.native`append: a fresh list splicing all argument lists (R7RS, last arg may be improper)`(
      { input: z.array(z.value), output: [z.value] },
      (...items: SchemeValue[]): SchemeValue => {
        // `append` builds a FRESH list (pure): it clones every segment first, then splices
        // the CLONES together. Because every cell touched is a clone, no caller-visible
        // value is mutated — the result is the only new thing (`append!`, the destructive
        // sibling, is doored above; this inlines its splice logic over clones instead).
        const is_list = isProperList;
        const cloned = items.map((item) => (item instanceof APair ? item.clone() : item));
        return cloned.reduce((acc, item, idx) => {
          // R7RS: last argument can be any value (creates improper list)
          const isLast = idx === cloned.length - 1;
          if (!isLast && (item instanceof APair || item instanceof ANil) && !is_list(item)) {
            throw new Error("append: Invalid argument, value is not a list");
          }
          if (acc instanceof ANil) {
            return item instanceof ANil ? nil : item;
          }
          if (item instanceof ANil) {
            return acc;
          }
          return concatPair(ctxOf(item), acc, item);
        }, nil);
      },
    ),

    reverse: symbol.native`reverse: the list reversed`(
      // pair | nil ONLY — the impl below has no raw-array branch (unlike nth/array->list),
      // so z.union([z.nil, z.pair]) is the honest input domain, not a representation-blind
      // z.value; a bare array throws (the impl's own final `else` branch).
      { input: [z.union([z.nil, z.pair])], output: [z.value] },
      (arg) => {
        if (arg instanceof ANil) {
          return nil;
        }
        if (arg instanceof APair) {
          const arr = listToArray(arg).toReversed();
          return arrayToList(arr);
        }
        throw new TypeError(typeErrorMessage("reverse", type(arg), "array or pair"));
      },
    ),

    nth: symbol.native`nth: the element at index (LIPS-polymorphic over array/pair)`(
      // index is z.schemeNumber (not z.value) — it's coerced via Number(index) below,
      // exactly the same domain list-tail/list-ref/list-set!'s own k argument already uses.
      // obj (2nd arg) and the output STAY z.value: nth is genuinely LIPS-polymorphic over
      // pair | raw JS array, and the array branch (`obj[idx]`, `Array.isArray(obj)`) can
      // return arbitrary host data (a borrowed array isn't a SchemeValue) — matches
      // `reverse`'s own established representation-blind precedent in this exact file, so
      // z.value would be dishonest here (it would silently exclude that real return path).
      { input: [z.schemeNumber, z.value], output: [z.value], type: "<T>(index: number, list: T[]): T | null" },
      (index, obj) => {
        // `index` is a Scheme/JS number; coerce the count to a primitive (a boxed
        // AExact resolves through valueOf), exactly as the bare `count < index` did.
        const idx = Number(index);
        if (obj instanceof APair) {
          let node: APair<SchemeValue, SchemeValue> = obj;
          let count = 0;
          while (count < idx) {
            const next = node.cdr;
            if (!next || next instanceof ANil || node.have_cycles("cdr")) {
              return nil;
            }
            // An improper tail at the index reproduces the old `(<non-pair>).car`
            // read — bare `undefined`, which the membrane boxed to void.
            if (!(next instanceof APair)) {
              return theVoid;
            }
            node = next;
            count++;
          }
          return node.car;
        } else if (Array.isArray(obj)) {
          return obj[idx];
        } else {
          throw new TypeError(typeErrorMessage("nth", type(obj), "array or pair", 2));
        }
      },
    ),
  },
});
