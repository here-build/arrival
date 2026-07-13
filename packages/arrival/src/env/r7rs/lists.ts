/**
 * List ops — the R7RS § 6.4 pairs-and-lists cluster: constructors, accessors,
 * mutators (doored), copy, and the search functions (memq/memv/assq/assv/
 * member/assoc). The c[ad]+r accessor family is intentionally NOT declared here
 * — those are served by a resolver, not this pack.
 *
 * Each op declares a SCHEME-IDENTITY zod contract (no codec, no runtime
 * validation — "zod for types purely") and an impl that receives Scheme values
 * as-is (bound as a first-class ANativeProcedure — capability.ts). List args are
 * typed `Pair | Nil` (the proper-list domain; the defensive improper-list
 * passthrough is robustness, not the declared domain), indices are the
 * `schemeNumber` tower, the searched object and copied/returned cells are
 * representation-blind (`z.value`), and the optional user comparator is the
 * types-only `z.custom` binary predicate.
 */
//
// This pack carries zero `symbol.define`/`symbol.defineSyntax` — every symbol is
// `symbol.native` or `symbol.sequence` (`map`), contract-authored per-define, plus
// the four `symbol.notImplemented` purity doors (`set-car!`/`set-cdr!`/`append!`/
// `list-set!`). Nothing here is FV-walked, so no `deps` edge is ever required OF
// this pack — it is instead a `deps` TARGET: `scheme/srfi-235` declares
// `deps: […, lists]`, so `base-packs.ts` positions `lists`/`polyglot` last in
// `BASE_PACKS` — the C3 linearization needs `lists` already resolved before
// `srfi-235` loads onto it.

// Installs the global \`TypeError.invariant\` assertion helper used by the
// list-bounds and circular-list guards below (side-effect import).
import "@here.build/error-invariant";
import dedent from "dedent";
import { type RunContext } from "../../values/primitives/RunContext.js";
import { applyCallback } from "../../values/primitives/ACallable.js";
import { CallCtx } from "../../common/symbols/_bake.js";

import * as z from "../../common/scheme-zod.js";
import { type MaybePromise, resolveMethod, symbol } from "../../common/symbol.js";
import { schemeFalse, withInputProvenance } from "../../values/op-helpers.js";
import invariant from "tiny-invariant";
import { APair, concatPair, isCircularList } from "../../values/primitives/APair.js";
import { ctxOf } from "../../values/primitives/AValue.js";
import { is_false, is_function, is_promise } from "../../eval/guards.js";
import { is_callable_value } from "../../values/value-guards.js";
import { type, typeErrorMessage } from "../../utils/typecheck.js";
import { heapBudgetMessage } from "../../heap-budget.js";
import { ArrivalError } from "../../eval/evaluator.js";
import { CarrierMismatchError } from "../../errors.js";
import { eqv, structuralEqual } from "../../values/structural-equal.js";
import { to_array } from "../pack-helpers.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { type AVoid, theVoid } from "../../values/primitives/AVoid.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AVector } from "../../values/primitives/AVector.js";
import { AString } from "../../values/primitives/AString.js";
import { ABytevector } from "../../values/primitives/ABytevector.js";
import { EnvCapability } from "../../common/capability.js";
import { call_function } from "../../eval/call-function.js";
import { promise_all } from "../../utils/promises.js";
import { tf } from "../../values/tagless-final.js";
import type { AList, AListAlike, AProcedure, SchemeValue } from "../../values/types.js";

// A JS value used as a Scheme procedure IS the SchemeValue function member
// `(...args: SchemeValue[]) => SchemeValue` (types.ts). `is_function`/`typeof`
// over `unknown` only yield the bare `Function` type, which lacks the call
// signature `call_function`/`apply` need — this refines the predicate to the
// procedure shape the union already names.
const is_callable = (o: unknown): o is (...args: SchemeValue[]) => SchemeValue => is_function(o);

// `member`/`assoc`'s optional `compare` decodes to the z.lambda scheme face
// `(...args: unknown[]) => unknown` — `structuralEqual`'s own signature
// `(a: any, b: any, seen?: SeenMap) => boolean` isn't directly assignable as a default
// value for that parameter (its optional 3rd param is narrower than the rest tuple's
// `unknown`), so this two-arg adapter is the exact contracted shape.
const defaultCompare = (a: unknown, b: unknown): unknown => structuralEqual(a, b);

// list<->array bridge: the shared env-layer helper (pack-helpers.ts) — was a
// pack-local copy triplicated across lists/strings/srfi-13; the old comment's
// "stdlib originals stay in stdlib.ts" referenced a file deleted long ago.
const listToArray = to_array("list->array");

function arrayToList(ctx: RunContext, array: SchemeValue[]): SchemeValue {
  return APair.fromArray(ctx, array);
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

// P5 door for `append`'s non-last operands: every argument but the last must be
// a proper list (R7RS §6.4) — append walks its car-spine to splice each element,
// so a non-pair/non-nil operand there can't silently contribute "nothing" or
// silently become the whole result (the bug this door closes: concatPair's `a`
// side vanishing when it isn't a Pair). Names the carrier-specific concatenation
// verb that actually exists for that value, so the failure teaches the fix
// instead of just refusing (`CarrierMismatchError`, errors.ts).
function nonListAppendOperandError(item: SchemeValue): CarrierMismatchError {
  if (item instanceof AVector) return new CarrierMismatchError("append", "vector", "vector-append");
  if (item instanceof AString) return new CarrierMismatchError("append", "string", "string-append");
  if (item instanceof ABytevector) return new CarrierMismatchError("append", "bytevector", "bytevector-append");
  return new CarrierMismatchError("append", type(item));
}

const lengthImpl = function (this: CallCtx, obj: unknown): AExact | AInexact {
  // R7RS length is an exact integer — box to AExact, matching string-length.
  if (obj == null) return new AExact(this.runCtx, 0n);
  // Dispatch to the operand's OWN arrival/tagless-final/length — the per-primitive count
  // carries the ELEMENTS' unioned provenance and levies the circular-list check. TOTALIC:
  // a receiver with no length algebra is a type error, never a silent 0. A non-term
  // carrier with a bare `.length` (a membrane-wrapped JS array) falls back to that property.
  const m = (obj as Record<string, unknown>)[tf("length")];
  if (typeof m === "function") {
    const result: unknown = m.call(obj);
    // The protocol's own declared shape (`AValue | number`, AValue.ts) is wider than what
    // any implementor may honestly produce post bare-value purge (A4/P4): `withInputProvenance`
    // (op-helpers.ts) no longer has a raw-scalar tolerance, and ANil's own length boxes its
    // empty-provenance zero — so every real term now returns an AExact/AInexact, never a raw
    // number. A raw number reaching here would be a P4 violation in whichever term produced
    // it (the sibling class of the `number->string` bug); fail loudly (P5) rather
    // than silently re-boxing it.
    invariant(
      result instanceof AExact || result instanceof AInexact,
      `length: a term's own length must be a boxed count (bare-value-purge/P4) — got ${typeof result}`,
    );
    return result;
  }
  if (typeof obj === "object" && "length" in obj) {
    const len = obj.length;
    if (typeof len === "number") return withInputProvenance([obj], new AExact(this.runCtx, BigInt(len)));
  }
  throw new TypeError(`length: the ${typeof obj} operand does not support length (no arrival/tagless-final/length).`);
};

// Multi-list `map` is a ZIP (not a Functor op): apply fn to corresponding elements
// across the lists, truncating to the shortest.
function multiListMap(
  fn: AProcedure,
  lists: readonly AListAlike[],
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
//
// `runCtx` is a real, required parameter (not the rest tail) — Wave 0 of the
// CONSTANT_CTX rework (docs/working-proposals/arrival-constant-ctx-audit-2026-07-11.md
// §2.1, "fires today"): the sole caller (for-each's impl, below) now threads its own
// `this.runCtx`, closing the bug where every for-each callback ran under CONSTANT_CTX
// (`call_function(fn, args, {})`) — no abort signal, no heap meter, forced non-strict.
function mapImpl(
  runCtx: RunContext,
  fn: SchemeValue,
  lists: readonly AListAlike[],
): SchemeValue | Promise<SchemeValue> {
  // `typecheck` guarantees callability at runtime but is not a TS guard; re-state it
  // as a type-level assertion so `call_function` sees a shape it can invoke. Callable
  // VALUES (ANativeProcedure — e.g. the kernel-synthesized cxr accessors — /ALambda)
  // are first-class here: `call_function` routes them through the applyCallback seam.
  invariant(is_callable(fn) || is_callable_value(fn), `map: the first argument is not a procedure`);
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
    results.push(call_function(fn, args, { runCtx }));
  }

  const hasPromises = results.some(is_promise);
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
    // map (Pair preserves boxes; Vector strips boxes) — the term owns the
    // algebra + its eval strategy; SEVERAL lists is a zip (multiListMap). ctx-aware for runCtx.
    map: symbol.sequence`map: fn over one list (its own term map — box discipline) or a zip over several`(
      // fn is the fixed HEAD; the further lists/vectors are the variadic TAIL —
      // `symbol.sequence`'s factory type has no Rest generic, so a hand-authored
      // z.tuple(fixed, rest) is the only available shape (srfi-1.ts's filter, the
      // one-time sibling example, has since narrowed to a plain fixed 2-tuple).
      // The rest is z.value, NOT z.union([z.pair, z.nil]): a further "list" argument here
      // is any sequence answering arrival/tagless-final/map (Pair, Nil, OR Vector — see
      // the impl's single-list dispatch below), so a pair|nil union would wrongly exclude
      // the vector case. Output is z.value: both dispatch paths (the tf("map") protocol
      // member, and multiListMap) declare SchemeValue | Promise<SchemeValue>, never a
      // raw-primitive leak.
      // Harvest: faithful List|vector dual generics (inline type:), not R[]/unknown.
      {
        input: z.tuple([z.lambda], z.value),
        output: [z.value],
        provenance: "fan",
        type: dedent`
          {
            <T, B>(f: (x: T) => B, xs: List<T>): List<B>;
            <T, B>(f: (x: T) => B, xs: readonly T[]): readonly B[];
            <A, B, R>(f: (a: A, b: B) => R, as: List<A>, bs: List<B>): List<R>;
            <A, B, R>(f: (a: A, b: B) => R, as: readonly A[], bs: readonly B[]): readonly R[];
            <A, B, C, R>(f: (a: A, b: B, c: C) => R, as: List<A>, bs: List<B>, cs: List<C>): List<R>;
            <A, B, C, R>(f: (a: A, b: B, c: C) => R, as: readonly A[], bs: readonly B[], cs: readonly C[]): readonly R[];
          }
        `,
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
          // (AValue.ts's protocol declaration) — `resolveMethod`'s TermMethod return is `unknown` (it
          // resolves ANY term method, not just this one's specific protocol), so the assertion states
          // that documented, real invariant rather than widening the contract's own DecodedReturn.
          return m.call(seq, fn, runCtx) as MaybePromise<SchemeValue>;
        }
        return multiListMap(fn, lists as readonly AListAlike[], runCtx);
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
        type: dedent`
          {
            <T>(f: (x: T) => unknown, xs: List<T>): void;
            <A, B>(f: (a: A, b: B) => unknown, as: List<A>, bs: List<B>): void;
            <A, B, C>(f: (a: A, b: B, c: C) => unknown, as: List<A>, bs: List<B>, cs: List<C>): void;
          }
        `,
      },
      // Runs mapImpl for its side effects and discards the result list. `this: CallCtx`
      // (not an arrow) — the dispatch-delivered `this.runCtx` is threaded into mapImpl so
      // every for-each callback observes the run's real signal/meter/strict, not
      // CONSTANT_CTX (Wave 0, arrival-constant-ctx-audit-2026-07-11.md §2.1).
      function (this: CallCtx, fn, ...lists) {
        const ret = mapImpl(this.runCtx, fn, lists);
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
      {
        input: [z.value, z.value],
        output: [z.pair],
        // Harvest mirrors carriers.ts: list-prepend vs dotted pair.
        type: dedent`
          {
            <H, T>(h: H, t: List<T>): List<H | T>;
            <H, T>(h: H, t: T): Pair<H, T>;
          }
        `,
      },
      // A constructor: unions both inputs' provenance over the produced cell
      // (parallel to make-list / list, which stamp only the produced Pair).
      function (this: CallCtx, car, cdr) { return withInputProvenance([car, cdr], new APair(this.runCtx, car as SchemeValue, cdr as SchemeValue)); },
    ),

    // R7RS 6.4 — `list` builds a proper list of its arguments. A constructor, so —
    // like cons and make-list — it unions the inputs' provenance over the produced
    // head only.
    list: symbol.native`list: a proper list of its arguments`(
      {
        input: z.array(z.value),
        output: [z.value],
        type: dedent`
          {
            <T>(...xs: T[]): List<T>;
          }
        `,
      },
      function (this: CallCtx, ...args: SchemeValue[]): SchemeValue {
        const result = args.reduceRight((list, item) => new APair(this.runCtx, item, list), nil);
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

    // R7RS 6.4 — length is the impl declared at module scope above. Output is
    // z.schemeNumber: length always returns a settled AExact/AInexact, never a
    // still-filling speculative carrier.
    length: symbol.native`length: the number of elements in a proper list (or any .length carrier)`(
      {
        input: [z.value],
        output: [z.schemeNumber],
        // carriers.ts length over List | vector | string.
        type: dedent`
          {
            (xs: List<unknown> | readonly unknown[] | string): number;
          }
        `,
      },
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
        type: dedent`
          {
            <R>(proc: () => R, args: List<never>): R;
            <A, R>(proc: (a: A) => R, args: List<A>): R;
            <A, B, R>(proc: (a: A, b: B) => R, a: A, args: List<B>): R;
            <A, R>(proc: (...args: A[]) => R, ...argsThenList: [...A[], List<A>]): R;
          }
        `,
      },
      // The final tail element must be a PROPER list — `listToArray` (the shared
      // pack-helpers `to_array`) is the door: it rejects an improper/atom final arg loudly
      // ("can't convert improper list") rather than crashing on a non-iterable spread.
      function (this: CallCtx, fn: unknown, ...rest: unknown[]) {
        invariant(rest.length > 0, "apply: requires an argument list as the final argument");
        const spread = listToArray(rest[rest.length - 1] as AListAlike);
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
      {
        input: [z.schemeNumber, z.value.optional()],
        output: [z.union([z.pair, z.nil])],
        type: dedent`
          {
            <T>(k: number, fill?: T): List<T>;
          }
        `,
      },
      function (this: CallCtx, k: unknown, fill?: unknown): AListAlike {
        const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
        // The default fill is #f — the flyweight ABool (Face split), not a raw JS false.
        const value: SchemeValue = fill === undefined ? schemeFalse : (fill as SchemeValue);
        let result: AListAlike = nil;
        for (let i = 0; i < count; i++) {
          result = new APair(this.runCtx, value, result);
        }
        // Stamp the head Pair only — internal cons cells share the same lineage
        // by definition; downstream traversal reads provenance off whichever pair
        // is bound. Parallel to this pack's \`cons\` above, which only stamps the produced cell.
        return withInputProvenance(fill === undefined ? [k] : [k, fill], result);
      },
    ),

    "list-tail": symbol.native`list-tail: the sublist obtained by dropping the first k elements`(
      // Output is z.value, NOT narrowed to z.union([z.pair, z.nil]): the walked-to position
      // can be an IMPROPER list's dangling tail (e.g. (list-tail '(1 2 . 3) 2) => 3, a bare
      // number), so z.value is the honest ceiling (matches list-ref/list-copy below).
      // Harvest models the proper-list case (List<T>); improper tails stay a runtime residue.
      {
        input: [z.union([z.pair, z.nil]), z.schemeNumber],
        output: [z.value],
        type: dedent`
          {
            <T>(xs: List<T>, k: number): List<T>;
          }
        `,
      },
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
      {
        input: [z.union([z.pair, z.nil]), z.schemeNumber],
        output: [z.value],
        type: dedent`
          {
            <T>(xs: List<T>, k: number): T;
          }
        `,
      },
      function (this: CallCtx, list, k) {
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
      {
        input: [z.union([z.pair, z.nil])],
        output: [z.value],
        type: dedent`
          {
            <T>(xs: List<T>): List<T>;
          }
        `,
      },
      function (this: CallCtx, list) {
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
          return new APair(this.runCtx, lst.car, copy(lst.cdr));
        };
        // Copy is a fresh allocation but semantically the same lineage as `list`.
        return withInputProvenance([list], copy(list));
      },
    ),

    // R7RS 6.4 List searching functions.
    //
    // memq/memv/assq/assv/member/assoc's output — all six — unions the match arm with
    // z.booleanFalse (memq narrows its match arm to z.pair, the matched sublist; the
    // other five use z.value), never a bare match arm: each returns EITHER a matched
    // sublist/entry OR a raw, unboxed JS `false` sentinel on no-match (the interpreter
    // boxes it downstream — the same pattern used pervasively across this codebase).
    // The match arm alone would silently exclude the real false-return path.
    memq: symbol.native`memq: first sublist whose car is eq? to obj, else #f`(
      // obj stays z.value BY DESIGN: eq?'s raw === identity compare is the canonical
      // representation-blind case — not imprecision to fix.
      {
        input: [z.value],
        inputRest: z.pair,
        output: [z.union([z.pair, z.booleanFalse])],
        type: dedent`
          {
            <T>(obj: T, list: List<T>): List<T> | false;
          }
        `,
      },
      function (this: CallCtx, obj, list) {
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
      // `eqv` compares Scheme values, so the search key is `z.value` — the same
      // schema memq declares, there read representation-blind for its `===` identity test.
      {
        input: [z.value, z.union([z.pair, z.nil])],
        output: [z.union([z.value, z.booleanFalse])],
        type: dedent`
          {
            <T>(obj: T, list: List<T>): List<T> | false;
          }
        `,
      },
      function (this: CallCtx, obj, list) {
        let current: unknown = list;
        // `list` decodes to the honest `AListAlike` (ANil | APair) — isCircularList only
        // accepts a Pair (an ANil head can never be circular), so the ANil arm short-circuits
        // the check to `false`, matching the prior behavior exactly.
        TypeError.invariant(!(list instanceof APair && isCircularList(list)), "memv: circular list");
        while (current instanceof APair) {
          if (eqv(current.car, obj)) return current;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    assq: symbol.native`assq: first alist entry whose car is eq? to obj, else #f`(
      // obj stays z.value BY DESIGN — same eq? reasoning as memq above.
      {
        input: [z.value, z.union([z.pair, z.nil])],
        output: [z.union([z.value, z.booleanFalse])],
        type: dedent`
          {
            <K, V>(obj: K, alist: List<[K, V]>): [K, V] | false;
          }
        `,
      },
      function (this: CallCtx, obj, alist) {
        let current: unknown = alist;
        // Same ANil-short-circuit reasoning as memv above — isCircularList needs a Pair.
        TypeError.invariant(!(alist instanceof APair && isCircularList(alist)), "assq: circular list");
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
      {
        input: [z.value, z.union([z.pair, z.nil])],
        output: [z.union([z.value, z.booleanFalse])],
        type: dedent`
          {
            <K, V>(obj: K, alist: List<[K, V]>): [K, V] | false;
          }
        `,
      },
      function (this: CallCtx, obj, alist) {
        let current: unknown = alist;
        // Same ANil-short-circuit reasoning as memv above — isCircularList needs a Pair.
        TypeError.invariant(!(alist instanceof APair && isCircularList(alist)), "assv: circular list");
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
        type: dedent`
          {
            <T>(obj: T, list: List<T>): List<T> | false;
            <T>(obj: T, list: List<T>, compare: (a: T, b: T) => unknown): List<T> | false;
          }
        `,
        // callbackRoles DECLARED: pipe host with value egress — shape underdetermines.
        // compare is `control` (boolean-returning equality selector: its verdict decides
        // WHICH sublist egresses). Roles align with LAMBDA arms — compare is arm 0
        // despite input position 2.
        callbackRoles: ["control"],
      },
      // `this: CallCtx` (not an arrow) — Wave 0 of the CONSTANT_CTX rework
      // (arrival-constant-ctx-audit-2026-07-11.md §2.1): the dispatch-delivered
      // `this.runCtx` is threaded to `call_function` so a user-supplied `compare`
      // observes the run's real signal/meter/strict.
      function (this: CallCtx, obj, list, compare = defaultCompare) {
        let current: unknown = list;
        // Same ANil-short-circuit reasoning as memv above — isCircularList needs a Pair.
        TypeError.invariant(!(list instanceof APair && isCircularList(list)), "member: circular list");
        while (current instanceof APair) {
          // `compare` is a callable VALUE when user-supplied (ANativeProcedure/ALambda), not
          // a bare JS function — invoke it through the seam (`call_function`, the same
          // chokepoint mapImpl/multiListMap use above), not a raw JS call (which throws
          // "compare is not a function" on any boxed scheme procedure). Its result may be a
          // boxed SchemeBool post-L1 (a truthy JS object); route through is_false.
          if (!is_false(call_function(compare, [obj, current.car], { runCtx: this.runCtx }))) return current;
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
        type: dedent`
          {
            <K, V>(obj: K, alist: List<[K, V]>): [K, V] | false;
            <K, V>(obj: K, alist: List<[K, V]>, compare: (a: K, b: K) => unknown): [K, V] | false;
          }
        `,
        // Same `control` declaration as `member` above — the alist search twin's
        // compare is the same equality selector.
        callbackRoles: ["control"],
      },
      // `this: CallCtx` (not an arrow) — same threading as `member` above.
      function (this: CallCtx, obj, alist, compare = defaultCompare) {
        let current: unknown = alist;
        // Same ANil-short-circuit reasoning as memv above — isCircularList needs a Pair.
        TypeError.invariant(!(alist instanceof APair && isCircularList(alist)), "assoc: circular list");
        while (current instanceof APair) {
          const pair = current.car;
          // Same seam-routing as member above — `compare` is a callable VALUE when
          // user-supplied, invoked via `call_function`, not a raw JS call. Its result may
          // be a boxed SchemeBool post-L1 (a truthy JS object) → route through is_false.
          if (pair instanceof APair && !is_false(call_function(compare, [obj, pair.car], { runCtx: this.runCtx }))) return pair;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    append: symbol.native`append: a fresh list splicing all argument lists (R7RS, last arg may be improper)`(
      {
        input: z.array(z.value),
        output: [z.value],
        // Proper-list zip is List<T>; improper last arg is the R7RS residue (second arm).
        type: dedent`
          {
            <T>(...lists: List<T>[]): List<T>;
            <T, U>(...lists: [...List<T>[], U]): List<T> | U;
          }
        `,
      },
      function (this: CallCtx, ...items: SchemeValue[]): SchemeValue {
        // `append` builds a FRESH list (pure): it clones every segment first, then splices
        // the CLONES together. Because every cell touched is a clone, no caller-visible
        // value is mutated — the result is the only new thing (`append!`, the destructive
        // sibling, is doored above; this inlines its splice logic over clones instead).
        const is_list = isProperList;
        const cloned = items.map((item) => (item instanceof APair ? item.clone() : item));
        return cloned.reduce((acc, item, idx) => {
          // R7RS: last argument can be any value (creates improper list). Every
          // EARLIER argument must be a proper list (nil or a non-circular Pair
          // spine) — append walks it to splice its elements, so anything else
          // there is a P5 violation: fail loudly, naming the real verb, instead
          // of the item silently contributing nothing (or silently becoming the
          // whole result when it lands as `acc`).
          const isLast = idx === cloned.length - 1;
          if (!isLast && !(item instanceof ANil)) {
            if (!(item instanceof APair)) {
              throw nonListAppendOperandError(item);
            }
            if (!is_list(item)) {
              throw new Error("append: Invalid argument, value is not a list");
            }
          }
          if (acc instanceof ANil) {
            return item instanceof ANil ? nil : item;
          }
          if (item instanceof ANil) {
            return acc;
          }
          // concatPair's `Cdr extends AListAlike` bound is narrower than its actual behavior:
          // its body embeds `b` as an opaque tail (`let result: AListAlike = b ?? nil`, then
          // conses onto it — APair.ts) without ever inspecting its shape. append's own contract
          // (z.array(z.value)) genuinely allows a non-list LAST argument (R7RS §6.4's improper-
          // tail form), so `item` here can be a bare SchemeValue — the cast matches concatPair's
          // real runtime contract, not just its (over-narrow) declared one.
          return concatPair(ctxOf(item), acc, item as AListAlike);
        }, nil);
      },
    ),

    reverse: symbol.native`reverse: the list reversed`(
      // pair | nil ONLY — the impl below has no raw-array branch (unlike nth/array->list),
      // so z.union([z.nil, z.pair]) is the honest input domain, not a representation-blind
      // z.value; a bare array throws (the impl's own final `else` branch).
      {
        input: [z.union([z.nil, z.pair])],
        output: [z.value],
        type: dedent`
          {
            <T>(xs: List<T>): List<T>;
          }
        `,
      },
      function (this: CallCtx, arg) {
        if (arg instanceof ANil) {
          return nil;
        }
        if (arg instanceof APair) {
          const arr = listToArray(arg).toReversed();
          return arrayToList(this.runCtx, arr);
        }
        throw new TypeError(typeErrorMessage("reverse", type(arg), "array or pair"));
      },
    ),

    nth: symbol.native`nth: the element at index (LIPS-polymorphic over array/pair)`(
      // index is z.schemeNumber (not z.value) — it's coerced via Number(index) below,
      // exactly the same domain list-tail/list-ref's own k argument already uses.
      // obj (2nd arg) and the output STAY z.value: nth is genuinely LIPS-polymorphic over
      // pair | raw JS array, and the array branch (`obj[idx]`, `Array.isArray(obj)`) can
      // return arbitrary host data (a borrowed array isn't a SchemeValue) — unlike
      // `reverse` above (pair|nil only; its raw-array branch is gone), nth keeps its
      // array branch, so a pair|nil narrowing would be dishonest here (it would
      // silently exclude that real array path).
      { input: [z.schemeNumber, z.value], output: [z.value], type: dedent`
          {
            <T>(index: number, list: List<T>): T | null;
            <T>(index: number, list: readonly T[]): T | null;
          }
        ` },
      function (this: CallCtx, index, obj) {
        // `index` is a Scheme/JS number; coerce the count to a primitive (a boxed
        // AExact resolves through valueOf), exactly as the bare `count < index` did.
        const idx = Number(index);
        if (obj instanceof APair) {
          let node = obj;
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
