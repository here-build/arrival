/**
 * List ops — the R7RS § 6.4 pairs-and-lists cluster (the list constructors,
 * accessors, mutators, copy, and the search functions: memq/memv/assq/assv/
 * member/assoc), carved
 * VERBATIM out of \`wrappedOps\` in \`../bridge.ts\`. These are behavior-preserving
 * copies of the interpreter's hot-path list builtins; the implementations —
 * including their inline comments — are otherwise identical to the source. The
 * only change from the bridge originals is that cross-cutting helpers come
 * from their own leaf modules rather than being referenced as bridge locals:
 * \`withInputProvenance\` from \`../op-helpers.js\`; \`eqv\` (the canonical R7RS
 * \`eqv?\`, shared by \`eq?\`) and \`structuralEqual\` from \`../structural-equal.js\`;
 * the value-type classes (\`Pair\`/\`isCircularList\`, \`Nil\`/\`nil\`) from their own
 * leaf modules; and \`is_false\` from \`../guards.js\`. \`TypeError\`
 * carries its \`.invariant\` assertion via the side-effect import below. The
 * c[ad]+r accessor family is intentionally NOT declared here — those are served
 * by a resolver, not by \`wrappedOps\`.
 *
 * MIGRATED to the \`symbol.native\` API: each op declares a SCHEME-IDENTITY zod
 * contract (no codec, no validation — "zod for types purely") and an impl bound
 * raw exactly as the old \`{ value }\` form. List args are typed \`Pair | Nil\` (the
 * proper-list domain; the defensive improper-list passthrough is robustness, not
 * the declared domain), indices are the \`schemeNumber\` tower, the searched object
 * and copied/returned cells are representation-blind (\`z.value\`), and the
 * optional user comparator is the types-only \`z.custom\` binary predicate. Bodies
 * are reproduced byte-for-byte.
 */

// Installs the global \`TypeError.invariant\` assertion helper used by the
// list-bounds and circular-list guards below (side-effect import).
import "@here.build/error-invariant";
import { CONSTANT_CTX, type RunContext } from "../../values/primitives/RunContext.js";
import { applyCallback } from "../../values/primitives/ACallable.js";

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
import type { AProcedure, SchemeValue } from "../../values/types.js";

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
// `deep` decides the ELEMENT type: a shallow walk yields a flat `SchemeValue[]`
// (each list element is a value); a deep walk splices nested lists in as nested
// JS arrays, so an element is `SchemeValue | NestedArray` — captured by the
// recursive `NestedArray` (a value, or an array of such). A flat `SchemeValue[]`
// is itself a valid `NestedArray[]`, so the shallow caller (`listToArray`) keeps
// its precise `SchemeValue[]` while the deep caller (`treeToArray`) gets the tree.
type NestedArray = SchemeValue | NestedArray[];
/** Structural check mirroring `NestedArray` exactly: a plain array recurses into every
 *  element; a non-array is accepted as a leaf (it can be ANY SchemeValue — the same
 *  representation-blind-leaf convention `z.value`/`flatten`'s output union already use
 *  in this file). Used as `tree->array`'s output element validator, below. */
function to_array(name: string): (list: APair | ANil) => SchemeValue[];
function to_array(name: string, deep: true): (list: APair | ANil) => NestedArray[];
function to_array(name: string, deep = false): (list: APair | ANil) => NestedArray[] {
  return function recur(list: APair | ANil): NestedArray[] {
    if (list instanceof ANil) {
      return [];
    }
    invariant(!isCircularList(list), `${name}: can't convert a circular list`);
    // Heap meter off the OPERAND's ctx (the run-built list carries the run's RunContext;
    // a quoted-literal carries CONSTANT_CTX → no meter, and is parse-bounded anyway). The
    // designed operand-ctx read (RunContext.ts §what-lives-here), replacing the retired
    // `currentRunEnv()` env back-channel.
    const meter = ctxOf(list).heapMeter;
    const result: NestedArray[] = [];
    let node: unknown = list;
    while (true) {
      if (node instanceof APair) {
        if (node.have_cycles("cdr")) {
          break;
        }
        let car: NestedArray = node.car;
        if (deep && car instanceof APair) {
          car = recur(car);
        }
        result.push(car);
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
const treeToArray = to_array("tree->array", true);

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
// [SPECULATE]=true, so length reads the lazy cardinality interval itself instead of a
// settled value (see evaluator.ts dispatch). Relocated VERBATIM from stdlib.ts
// global_env, where the `speculative()` helper set the same symbol on the bound fn.
const lengthImpl = (obj: unknown): SchemeValue => {
  // R7RS length is an exact integer. The relocated body returned raw JS numbers (the
  // membrane boxed them downstream); box to AExact here so the value IS a SchemeValue,
  // matching the string-length sibling (`new AExact(ctx, BigInt(...))`).
  if (obj == null) return new AExact(CONSTANT_CTX, 0n);
  // Tier 2 speculation: length of a still-filling collection is its narrowing cardinality INTERVAL,
  // surfaced as a number-domain HalfBaked the comparison ops read for early collapse (reached only
  // when speculation is on — the choke leaves a HalfBaked unforced solely for this marked op).
  if (is_half_baked(obj)) {
    return obj.toCardinalityNumber();
  }
  // Dispatch to the operand's OWN arrival/tagless-final/length — the per-primitive count carrying
  // the ELEMENTS' unioned provenance (the element-union DISSOLVED from fl-interop's length overlay
  // onto each term; the term also levies the circular-list check). TOTALIC: a receiver with no
  // length algebra is a type error, never a silent 0. A non-term carrier with a bare `.length`
  // (a membrane-wrapped JS array) falls back to that property.
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

// Multi-list `map` is a ZIP (not a Functor op): apply fn to corresponding elements across the lists,
// truncating to the shortest. PACK-LOCAL — uses lists.ts's own listToArray + call_function, so §6.10
// map carries NO global_env capture (the lazy builtinMap grab fl-interop needed is gone). Speculation
// rides here too (cardBounds [1,1], the count is exact up front), carrying early-collapse through a
// multi-list map.
function multiListMap(
  fn: AProcedure,
  lists: readonly (APair | ANil)[],
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
// discards the result list). Relocated VERBATIM from stdlib.ts (husk dissolution),
// over this pack's own listToArray/isProperList. It overlaps `multiListMap` above
// but is kept separate to preserve byte-identical behavior: mapImpl's per-arg
// `isProperList` cycle-check raises "map: argument N is not a list", whereas
// multiListMap lets listToArray raise its own circular-list error. Unifying the
// two is a deferred behavior-preserving cleanup.
function mapImpl(fn: SchemeValue, ...lists: Array<APair | ANil>): SchemeValue | Promise<SchemeValue> {
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
      // fn is the fixed HEAD, the further lists/vectors are the variadic TAIL — `symbol.sequence`'s
      // own factory type is `Contract<I, O>` (no `Rest` generic — see sequence.ts/_bake.ts's
      // SequenceInput), so a hand-authored `z.tuple(fixed, rest)` is the only available shape
      // (matches this exact file's own doc precedent, and srfi-1.ts's filter). The head uses the
      // established callable-schema convention (z.custom<(...args) => SchemeValue>(), matching
      // vector-map's OWN choice for a data-producing HOF — its mapped result becomes output
      // elements, unlike a truthiness-only predicate like filter's, which uses `=> unknown`). The
      // rest is z.value, not z.union([z.pair, z.nil]): a further "list" argument here is actually
      // ANY sequence answering arrival/tagless-final/map (Pair, Nil, OR Vector — see the impl's own
      // single-list dispatch), so z.union([pair,nil]) would wrongly exclude the vector case; z.value
      // is the honest ceiling (matches vector-map's own choice of NOT over-narrowing its rest either).
      // Output is z.value: both dispatch paths (the tf("map") protocol member, and multiListMap)
      // declare SchemeValue | Promise<SchemeValue> — never a raw-primitive leak (unlike length's
      // arrival/tagless-final/length, which honestly admits `AValue | number`).
      // The z.custom callable head is UNREPRESENTABLE to the harvest printer, collapsing
      // signatureOf to the catch-all `(...args: unknown[]) => unknown`. `type` author-asserts
      // the real shape: fn-first, then a REPRESENTATION-AGNOSTIC sequence rest. Like srfi-95
      // `sort` (and unlike list-only `find`/`for-each`), map dispatches to Pair/Nil/Vector
      // terms — so the receiver + return stay `unknown`; narrowing to a List would be FALSE
      // (it would exclude the vector case, exactly the z.value-not-z.union reasoning above).
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
        return multiListMap(fn, lists as readonly (APair | ANil)[], runCtx);
      },
    ),
    // R7RS 6.4 — for-each: like map but run for side effects, returning unspecified.
    "for-each": symbol.native`for-each: apply fn to corresponding elements of one or more lists, for side effects`(
      // fn is the fixed HEAD (`input`); the spread lists are the variadic TAIL (`inputRest`) —
      // mirrors apply's own head/rest split. The head uses the callable-schema convention
      // established by vector-map/vector-for-each/curry/call-with-values/member's compare
      // (z.custom<(...args) => T>()), not apply's plain z.value — apply's own doc comment
      // frames that as illustrating the split mechanism, not a "callables are z.value" rule.
      // Each rest element is genuinely a proper list (typecheck'd below as "pair"|"nil"), so
      // inputRest is z.union([z.pair, z.nil]) — the same "this is a list" schema this file
      // already uses elsewhere (list-tail/list-ref/memq/…), not the representation-blind
      // z.value. Output is UNSPECIFIED (R7RS §6.4), not a returned value — z.undefinedResult, matching
      // the convention string-for-each/vector-for-each already use.
      {
        input: [z.lambda],
        inputRest: z.union([z.pair, z.nil]),
        output: [z.undefinedResult],
        // The z.custom callable head collapses signatureOf to the catch-all `(...args:
        // unknown[]) => unknown`. `type` author-asserts fn-first over a LIST-ONLY rest (its
        // schema IS z.union([pair,nil]), unlike map's agnostic z.value → so `Cons<unknown> |
        // null`, the image this file's own non-degraded list ops harvest as) → `void` (R7RS
        // unspecified; bare `void` as in env/core/core.ts's own hand-written type).
        type: "(fn: (...args: unknown[]) => unknown, ...lists: (Cons<unknown> | null)[]) => void",
      },
      // Relocated from stdlib.ts global_env (husk dissolution): runs mapImpl for its
      // side effects and discards the result list. The legacy `.call(this)` was a
      // babel-weakBind workaround — this pack is tsc/ES2022, so a direct call is
      // behavior-identical (mapImpl never reads `this`).
      //
      // Return: `void | Promise<void>`, matching the now-precise `z.undefinedResult` output (fixed
      // alongside the head/rest input above). Previously this impl explicitly constructed
      // `theVoid` (an AVoid instance) because the OLD contract declared `output: [z.value]`
      // (a SchemeValue return demanded an actual scheme value). `z.undefinedResult`'s decoded type is
      // the bare TS `void` — which only a literal `undefined` satisfies — so the impl now
      // returns bare `undefined` instead, exactly mirroring vector-for-each/string-for-each's
      // OWN established idiom (both already fall through to implicit `undefined` on the
      // sync path and `.then(() => undefined)` on the async path). This is NOT an
      // observable behavior change: the interpreter's dispatch already boxes a native impl's
      // raw `undefined` return into the scheme `theVoid` value for the caller (this is the
      // SAME boxing vector-for-each's sync path already relies on today, unmodified).
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
      // car/cdr are any scheme value — the whole point of cons is to hold arbitrary scheme
      // values, so z.value (SchemeValue identity) replaces the old z.value; zero runtime
      // difference (native ops run no validation; z.value carries no refinement either), a
      // purely static precision improvement for the .d.ts harvest surface.
      { input: [z.value, z.value], output: [z.pair] },
      // Byte-identical to the stdlib global_env body it relocates: a constructor,
      // so it unions both inputs' provenance over the produced cell (parallel to
      // make-list / list, which stamp only the produced Pair).
      (car: unknown, cdr: unknown): APair =>
        withInputProvenance([car, cdr], new APair(CONSTANT_CTX, car as SchemeValue, cdr as SchemeValue)),
    ),

    // R7RS 6.4 — `list` builds a proper list of its arguments. Relocated VERBATIM
    // from stdlib.ts global_env (husk dissolution): a constructor, so — like cons
    // and make-list — it unions the inputs' provenance over the produced head only.
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
    // route to the fresh-allocation alternative — dissolved here from the deleted
    // core.ts purity-door manifesto, co-located with the pairs-and-lists pack that owns
    // the type. (`list-set!` joined the doored set 2026-07-07 — the review this comment
    // used to flag resolved in favor of the invariant.)
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
      function (this: { ctx?: { runCtx?: RunContext } }, fn: unknown, ...rest: unknown[]) {
        invariant(rest.length > 0, "apply: requires an argument list as the final argument");
        const spread = listToArray(rest[rest.length - 1] as APair | ANil);
        // Seam-routed: `fn` is a callable VALUE (ANativeProcedure/lambda) now, not a bare fn.
        // applyCallback pins canBounce=false, so a Bounce never reaches here — the CallResult
        // narrows to value-or-promise.
        return applyCallback(fn, [...rest.slice(0, -1), ...spread], this?.ctx?.runCtx ?? CONSTANT_CTX) as
          | SchemeValue
          | Promise<SchemeValue>;
      },
    ),

    "make-list": symbol.native`make-list: build a list of k copies of fill (default #f)`(
      // fill is any scheme value (z.value, not z.value) — matches cons's car/cdr reasoning.
      // Output is now z.union([z.pair, z.nil]) rather than a bare z.value/z.value: make-list
      // is a CONSTRUCTOR that ALWAYS produces a well-formed proper list (nil when k=0, else a
      // pair chain) — unlike list-tail/list-copy (which can inherit an improper tail from their
      // INPUT) or list-ref (which extracts a single element), there is no way for make-list to
      // return anything outside {pair, nil}. This is also the file's own established "this is a
      // list" vocabulary (list-tail/list-ref/list-set!/list-copy's inputs already use this exact
      // union) — and, unlike z.value, z.pair/z.nil carry a REAL instanceof refinement, so this is
      // genuinely runtime-testable (see lists-contract-precision.test.ts).
      { input: [z.schemeNumber, z.value.optional()], output: [z.union([z.pair, z.nil])] },
      (k: unknown, fill?: unknown): APair | ANil => {
        const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
        // The default fill is #f — the flyweight ABool (Face split), not a raw JS false.
        const value: SchemeValue = fill === undefined ? schemeFalse : (fill as SchemeValue);
        let result: APair | ANil = nil;
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
      // Output is z.value (SchemeValue), not z.value — but NOT narrowed further to
      // z.union([z.pair, z.nil]): the walked-to position can be an IMPROPER list's dangling
      // tail (e.g. (list-tail '(1 2 . 3) 2) => 3, a bare number), so z.value is the honest
      // ceiling, matching list-ref/list-copy's own reasoning below.
      { input: [z.union([z.pair, z.nil]), z.schemeNumber], output: [z.value] },
      (list: SchemeValue, k: unknown): SchemeValue => {
        const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
        let current: SchemeValue = list;
        for (let i = 0; i < count; i++) {
          // `is_pair` (the file-local SchemeValue-narrowing shadow, line ~60) replaces the raw
          // `current instanceof APair` here — byte-identical runtime check (is_pair_raw IS
          // `instanceof APair`), but narrows `.cdr` to SchemeValue instead of APair<unknown,
          // unknown>'s default `unknown`, which the tightened `SchemeValue` return type needs.
          TypeError.invariant(current instanceof APair, `list-tail: list too short`);
          current = current.cdr;
        }
        return current;
      },
    ),

    "list-ref": symbol.native`list-ref: the element at index k`(
      // Output is z.value, not z.value — the element at an index is any scheme value
      // (e.g. (list-ref '(1 2 3) 0) => 1, a bare number, not a list), so z.value is the
      // honest ceiling (not a pair|nil union).
      { input: [z.union([z.pair, z.nil]), z.schemeNumber], output: [z.value] },
      (list: SchemeValue, k: unknown): SchemeValue => {
        const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
        let current: SchemeValue = list;
        for (let i = 0; i < count; i++) {
          // is_pair swap — see list-tail's identical note just above.
          TypeError.invariant(current instanceof APair, `list-ref: list too short`);
          current = current.cdr;
        }
        TypeError.invariant(current instanceof APair, `list-ref: index out of bounds`);
        return current.car;
      },
    ),

    // list-set! DOORED (2026-07-07, V's call): it was the last surviving in-place spine
    // mutator — set!/set-car!/set-cdr!/vector-set!/string-fill! are all doored by the same
    // purity invariant, and its survival was a LIPS-relocation oversight, not a design
    // decision. An in-place write falsifies the construction-site provenance the spine carries.
    "list-set!": symbol.notImplemented`list-set!: every value is frozen by design — mutating a list in place would falsify the provenance lineage its spine carries; build the updated list instead (e.g. (append (list-head lst k) (list obj) (list-tail lst (+ k 1))))`,

    "list-copy": symbol.native`list-copy: a fresh copy of the list spine (R7RS freshness)`(
      // Output is z.value, not z.value — like list-tail, list-copy explicitly tolerates an
      // IMPROPER list (the !(lst instanceof APair) branch below returns the dangling tail
      // as-is), so the result can be any scheme value, not just a pair|nil.
      { input: [z.union([z.pair, z.nil])], output: [z.value] },
      (list: SchemeValue): SchemeValue => {
        // === nil would miss Nil clones (singletons minted via withProvenance by
        // the evaluator's control-flow provenance pass). A clone bypassed the
        // guard, fell to the !(instanceof Pair) improper-list branch on the next
        // line, and aliased the input by reference — violating R7RS list-copy's
        // fresh-allocation contract. instanceof Nil keeps the freshness story
        // intact for both the singleton and any clones.
        if (list instanceof ANil) return nil;
        if (!(list instanceof APair)) return list;
        TypeError.invariant(!isCircularList(list), "list-copy: circular list");
        // Deep copy the spine of the list. is_nil/is_pair (the file-local SchemeValue-
        // narrowing shadow) replace the raw instanceof checks here ONLY (byte-identical
        // runtime check — is_nil/is_pair ARE instanceof ANil/APair) so .car/.cdr narrow to
        // SchemeValue instead of APair<unknown,unknown>'s default unknown, letting the
        // recursive call and the tightened SchemeValue return type both typecheck.
        const copy = (lst: SchemeValue): SchemeValue => {
          // Same clone-aware check at the recursion base: a Nil clone in the cdr
          // would otherwise be preserved as an improper-list tail.
          if (lst instanceof ANil) return nil;
          if (!(lst instanceof APair)) return lst; // improper list tail
          return new APair(CONSTANT_CTX, lst.car, copy(lst.cdr));
        };
        // Copy is a fresh allocation but semantically the same lineage as `list`.
        return withInputProvenance([list], copy(list));
      },
    ),

    // R7RS 6.4 List searching functions
    //
    // memq/memv/assq/assv/member/assoc's output — all six — is z.union([z.value, z.booleanFalse]),
    // not a bare z.value: every one of them returns EITHER a matched sublist/entry (a real
    // scheme value) OR a raw, unboxed JS `false` sentinel on no-match (relying on the
    // interpreter's downstream boxing — the SAME established "return false;"/"the membrane
    // boxes it downstream" pattern used pervasively across this codebase: chars.ts, equality.ts,
    // numeric.ts, strings.ts, and this file's own isProperList/length). z.value alone would be
    // DISHONEST here (it would silently exclude the real, intentional false return path);
    // z.value would be needlessly loose. Neither the z.value arm nor z.booleanFalse block
    // any REAL call (native ops skip validation regardless) — this is a static/.d.ts-harvest
    // precision fix documenting the actual two-shape domain.
    memq: symbol.native`memq: first sublist whose car is eq? to obj, else #f`(
      // obj stays z.value BY DESIGN: eq?'s raw === identity compare is the CANONICAL
      // genuinely-representation-blind case scheme-zod.ts's own doc comment names ("a predicate
      // that classifies host JS too — eq?, bytevector?") — not imprecision to fix.
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
      (obj: SchemeValue, list: unknown): SchemeValue => {
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
      (obj: unknown, alist: unknown): SchemeValue => {
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
      (obj: SchemeValue, alist: unknown): SchemeValue => {
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

    // member uses equal? (deep structural equality). obj is z.value (not z.value) —
    // structuralEqual is a genuine scheme-value compare (matches memv/assv's own obj, unlike
    // memq/assq's raw === identity, which stays z.value). compare's return type is now
    // `unknown`, not `boolean`: the body's own is_false guard right below proves the return
    // is NOT always a raw JS boolean (a user-supplied Scheme predicate returns a boxed
    // SchemeBool post-L1, a truthy JS object) — `boolean` was an honest-looking but incorrect
    // annotation; `unknown` matches srfi-1.ts's filter predicate (the established convention
    // for a scheme-callable whose result is truthiness-tested via is_false, not used as data).
    member: symbol.native`member: first sublist whose car is equal? to obj (or per compare), else #f`(
      {
        input: [z.value, z.union([z.pair, z.nil]), z.lambda.optional()],
        output: [z.union([z.value, z.booleanFalse])],
        // The optional z.custom compare collapses signatureOf to the catch-all; `type` restores
        // the real shape — same as the non-degraded memq/memv siblings (obj + `Cons<unknown> |
        // null` list → `unknown | false`), plus the optional binary comparator.
        type: "(obj: unknown, list: Cons<unknown> | null, compare?: (a: unknown, b: unknown) => unknown) => unknown | false",
      },
      (obj: unknown, list: unknown, compare?: (a: unknown, b: unknown) => unknown): SchemeValue => {
        const cmp = compare || ((a: unknown, b: unknown) => structuralEqual(a, b));
        let current: unknown = list;
        TypeError.invariant(!isCircularList(list), "member: circular list");
        while (current instanceof APair) {
          // `cmp` may be a user-supplied Scheme predicate whose result is a boxed
          // SchemeBool post-L1 (a truthy JS object); route through is_false.
          if (!is_false(cmp(obj, current.car))) return current;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    // assoc uses equal? (deep structural equality) — same obj/compare/output precision as
    // member above.
    assoc: symbol.native`assoc: first alist entry whose car is equal? to obj (or per compare), else #f`(
      {
        input: [z.value, z.union([z.pair, z.nil]), z.lambda.optional()],
        output: [z.union([z.value, z.booleanFalse])],
        // Same degrade + author-assertion as `member` above (the alist search twin).
        type: "(obj: unknown, alist: Cons<unknown> | null, compare?: (a: unknown, b: unknown) => unknown) => unknown | false",
      },
      (obj: unknown, alist: unknown, compare?: (a: unknown, b: unknown) => unknown): SchemeValue => {
        const cmp = compare || ((a: unknown, b: unknown) => structuralEqual(a, b));
        let current: unknown = alist;
        TypeError.invariant(!isCircularList(alist), "assoc: circular list");
        while (current instanceof APair) {
          const pair = current.car;
          // `cmp` may be a user-supplied Scheme predicate → boxed SchemeBool post-L1.
          if (pair instanceof APair && !is_false(cmp(obj, pair.car))) return pair;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    append: symbol.native`append: a fresh list splicing all argument lists (R7RS, last arg may be improper)`(
      { input: z.array(z.value), output: [z.value] },
      (...items: SchemeValue[]): SchemeValue => {
        // `append` builds a FRESH list (pure). It clones every segment first, then
        // splices the CLONES together via Pair.append. Because every cell touched
        // is a clone, no caller-visible value is mutated — the result is the only
        // new thing. (The destructive `append!` builtin this used to delegate to is
        // OMITTED by the purity invariant — doored above. Its splice
        // logic is inlined here, operating on clones, so it stays pure.)
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

    flatten: symbol.native`flatten: the list with nested lists spliced in (LIPS extension)`(
      // `.flatten()`'s own declared TS return type is `APair | ANil | unknown[]` (APair.ts) —
      // a bare z.value was looser than that. z.union([z.pair, z.nil, z.array(z.value)])
      // mirrors it exactly (the array arm's ELEMENTS genuinely can be arbitrary host data —
      // `.flatten()` itself types them `unknown[]`, not `SchemeValue[]` — so z.array(z.value)
      // is the honest ceiling there, not z.array(z.value)). Unlike z.value, z.pair/z.nil/z.array
      // all carry real zod refinements, so this rejects e.g. a bare scalar the old z.value
      // accepted (see lists-contract-precision.test.ts).
      { input: [z.value], output: [z.union([z.pair, z.nil, z.array(z.value)])] },
      (list: SchemeValue): APair | ANil | SchemeValue[] => {
        // `typecheck` proves pairhood at runtime but is not a TS guard; re-state it so
        // `.flatten()` (an APair method) resolves on the narrowed receiver.
        invariant(list instanceof APair, () => typeErrorMessage("flatten", type(list), "pair"));
        return list.flatten() as APair | ANil | SchemeValue[];
      },
    ),

    "array->list": symbol.native`array->list: a proper list built from a JS array`(
      // Input is a borrowed JS array (not a SchemeValue); output is a real list.
      { input: [z.value], output: [z.value] },
      (array: unknown): SchemeValue => arrayToList(array as SchemeValue[]),
    ),

    "tree->array": symbol.native`tree->array: a nested JS array built from a tree of pairs`(
      // Output is z.array(...) over the file-local recursive NestedArray element type — matches
      // treeToArray's own declared TS return type (NestedArray[], from the to_array(name, true)
      // overload above) exactly, tighter than a bare z.value (z.array's Array.isArray check
      // is a real refinement — rejects a non-array the old z.value accepted).
      // The z.custom<NestedArray> ELEMENT of the output array is unrepresentable to the harvest
      // printer, collapsing signatureOf to the catch-all `(...args: unknown[]) => unknown` (losing
      // both the single-arg arity and the array output). `type` restores it: one tree arg → a
      // nested JS array (`unknown[]`, the honest image of the NestedArray element).
      // `isNestedArray` (above) actually REJECTS a malformed nested array (one that isn't
      // recursively well-formed), unlike a no-op `z.custom<NestedArray>()`.
      {
        input: [z.value],
        output: [z.array(z.array(z.value))],
        type: "(tree: unknown) => unknown[]",
      },
      // NestedArray is the RECURSIVE truth; the contract's z.array(z.array(z.value)) is its
      // 2-level printable approximation — assert across that known gap.
      ((list: unknown): NestedArray[] => treeToArray(list as APair | ANil)) as unknown as (
        list: SchemeValue,
      ) => SchemeValue[][],
    ),

    "list->array": symbol.native`list->array: a JS array built from a proper list`(
      // Output is z.array(z.value) (SchemeValue[]) — matches listToArray's own declared TS
      // return type (from the to_array(name) overload above) exactly, tighter than a bare
      // z.value (a real Array.isArray refinement).
      { input: [z.value], output: [z.array(z.value)] },
      (list: unknown): SchemeValue[] => listToArray(list as APair | ANil),
    ),
  },
});
