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
 * and copied/returned cells are representation-blind (\`z.unknown()\`), and the
 * optional user comparator is the types-only \`z.custom\` binary predicate. Bodies
 * are reproduced byte-for-byte.
 */

// Installs the global \`TypeError.invariant\` assertion helper used by the
// list-bounds and circular-list guards below (side-effect import).
import "@here.build/error-invariant";
import { CONSTANT_CTX, type RunContext } from "../../values/primitives/RunContext.js";

import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { withInputProvenance } from "../../values/op-helpers.js";
import invariant from "tiny-invariant";
import { isCircularList, APair, concatPair } from "../../values/primitives/APair.js";
import { ctxOf } from "../../values/primitives/AValue.js";
import { is_pair, is_nil, is_null } from "../../eval/guards.js";
import { type, typecheck, typeErrorMessage } from "../../utils/typecheck.js";
import { findHeapMeter, heapBudgetMessage } from "../../heap-budget.js";
import { currentRunEnv, ArrivalError } from "../../eval/evaluator.js";
import { eqv, structuralEqual } from "../../values/structural-equal.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { is_false, is_promise } from "../../eval/guards.js";
import { EnvCapability } from "../../common/capability.js";
import { AHalfBaked, is_half_baked } from "../../values/primitives/AHalfBaked.js";
import { SPECULATE } from "../../well-known-symbols.js";
import { call_function } from "../../eval/call-function.js";
import { promise_all } from "../../utils/promises.js";
import { tf } from "../../values/tagless-final.js";

// Scheme is inherently dynamic at these interop boundaries — the relocated
// LIPS-era list builtins below typecheck their args at runtime; the param
// types use `any` intentionally (as in the stdlib originals).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemeValue = any;

// Pack-local copies of the list<->array bridge helpers. The stdlib originals
// (`listToArray`/`arrayToList`/`to_array`/`isProperList`) stay in stdlib.ts for
// its remaining consumers; these reproduce the same logic byte-for-byte (incl.
// the per-run heap-meter charge `to_array` levies at the collection choke) so
// the relocated defs are behavior-identical.
function to_array(name: string, deep = false): (list: SchemeValue) => SchemeValue[] {
  return function recur(list: SchemeValue): SchemeValue[] {
    typecheck(name, list, ["pair", "nil"]);
    if (is_nil(list)) {
      return [];
    }
    invariant(!isCircularList(list), `${name}: can't convert a circular list`);
    const runEnv = currentRunEnv();
    const meter = findHeapMeter(runEnv ?? null);
    const result: SchemeValue[] = [];
    let node = list;
    while (true) {
      if (is_pair(node)) {
        if (node.have_cycles("cdr")) {
          break;
        }
        let car = node.car;
        if (deep && is_pair(car)) {
          car = recur(car);
        }
        result.push(car);
        if (meter !== undefined && ++meter.used > meter.max) {
          throw new ArrivalError(heapBudgetMessage(meter.max), []);
        }
        node = node.cdr;
      } else {
        invariant(is_nil(node), `${name}: can't convert improper list`);
        break;
      }
    }
    return result;
  };
}
const listToArray = to_array("list->array");
const treeToArray = to_array("tree->array", true);

function arrayToList(array: SchemeValue): SchemeValue {
  typecheck("array->list", array, "array");
  return APair.fromArray(CONSTANT_CTX, array);
}

function isProperList(obj: SchemeValue): SchemeValue {
  // A circular list is NOT a proper list (R7RS). Detect runtime cycles.
  if (is_pair(obj) && isCircularList(obj)) {
    return false;
  }
  let node = obj;
  while (true) {
    if (is_nil(node)) return true;
    if (!is_pair(node)) return false;
    if (node.have_cycles("cdr")) return false;
    node = node.cdr;
  }
}

// `length` carries the Tier-2 speculation marker: the evaluator's dispatch choke
// leaves a still-filling collection's HalfBaked UNFORCED for ops whose impl has
// [SPECULATE]=true, so length reads the lazy cardinality interval itself instead of a
// settled value (see evaluator.ts dispatch). Relocated VERBATIM from stdlib.ts
// global_env, where the `speculative()` helper set the same symbol on the bound fn.
const lengthImpl = (obj: SchemeValue): SchemeValue => {
  if (obj == null) return 0;
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
  const m = (obj as Record<string, unknown>)["arrival/tagless-final/length"];
  if (typeof m === "function") {
    return (m as () => SchemeValue).call(obj);
  }
  if (typeof obj === "object" && "length" in obj) {
    return withInputProvenance([obj], obj.length);
  }
  throw new TypeError(`length: the ${typeof obj} operand does not support length (no arrival/tagless-final/length).`);
};
(lengthImpl as { [SPECULATE]?: boolean })[SPECULATE] = true;

const MAP_METHOD = tf("map");

// Multi-list `map` is a ZIP (not a Functor op): apply fn to corresponding elements across the lists,
// truncating to the shortest. PACK-LOCAL — uses lists.ts's own listToArray + call_function, so §6.10
// map carries NO global_env capture (the lazy builtinMap grab fl-interop needed is gone). Speculation
// rides here too (cardBounds [1,1], the count is exact up front), carrying early-collapse through a
// multi-list map.
function multiListMap(fn: SchemeValue, lists: SchemeValue[], runCtx: RunContext): SchemeValue {
  for (const [i, arg] of lists.entries()) {
    typecheck("map", arg, ["pair", "nil"], i + 1);
  }
  if (lists.some(is_nil)) return nil;
  const arrays = lists.map((l) => listToArray(l));
  const len = Math.min(...arrays.map((a) => a.length));
  const results: SchemeValue[] = [];
  for (let i = 0; i < len; i++) {
    results.push(call_function(fn, arrays.map((a) => a[i]), {}));
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

export default new EnvCapability("scheme/lists", {
  symbols: {
    // R7RS 6.10 — map. A combinator: ONE list dispatches to the operand's own arrival/tagless-final/
    // map (Pair preserves boxes + speculates [1,1]; Vector strips boxes, eager) — the term owns the
    // algebra + its eval strategy; SEVERAL lists is a zip (multiListMap). ctx-aware for runCtx.
    map: symbol.sequence`map: fn over one list (its own term map — box discipline + speculation) or a zip over several`(
      { input: z.tuple([z.unknown()], z.unknown()), output: [z.unknown()] },
      (args, runCtx) => {
        const [fn, ...lists] = args;
        if (lists.length === 1) {
          const seq = lists[0];
          const m = (seq as Record<string, unknown> | null | undefined)?.[MAP_METHOD];
          if (typeof m !== "function") {
            throw new TypeError(`map: the ${seq == null ? String(seq) : typeof seq} operand does not support map (no ${MAP_METHOD}).`);
          }
          return (m as (...a: unknown[]) => unknown).call(seq, fn, runCtx);
        }
        return multiListMap(fn, lists, runCtx);
      },
    ),
    // R7RS 6.4 Pairs and lists
    cons: symbol.native`cons: a pair (car . cdr) — the fundamental list constructor`(
      { input: [z.unknown(), z.unknown()], output: [z.pair] },
      // Byte-identical to the stdlib global_env body it relocates: a constructor,
      // so it unions both inputs' provenance over the produced cell (parallel to
      // make-list / list, which stamp only the produced Pair).
      (car: unknown, cdr: unknown): APair =>
        withInputProvenance([car, cdr], new APair(CONSTANT_CTX, car, cdr)),
    ),

    // R7RS 6.4 — `list` builds a proper list of its arguments. Relocated VERBATIM
    // from stdlib.ts global_env (husk dissolution): a constructor, so — like cons
    // and make-list — it unions the inputs' provenance over the produced head only.
    list: symbol.native`list: a proper list of its arguments`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
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
    // the type. (`list-set!` above stays a working spine-mutator — pre-existing, not in
    // the doored set; flagged for review.)
    "set-car!": symbol.notImplemented`set-car!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (cons / list)`,
    "set-cdr!": symbol.notImplemented`set-cdr!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (cons / list)`,
    "append!": symbol.notImplemented`append!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (append, which builds a fresh list)`,

    // R7RS 6.4 — length is the speculation-marked impl declared at module scope above
    // (the inline arrow form cannot carry the [SPECULATE] symbol the dispatch choke reads).
    "length": symbol.native`length: the number of elements in a proper list (or any .length carrier)`(
      { input: [z.unknown()], output: [z.unknown()] },
      lengthImpl,
    ),

    apply: symbol.native`apply: call fn with args, the last of which is a list spliced in`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      // Relocated VERBATIM from stdlib.ts global_env (husk dissolution). The legacy
      // body took `this: Environment` but never read it — apply's env-as-this was
      // already erased, so the native bind (this === undefined) is behavior-identical.
      // Uses the pack-local `listToArray` (same byte-for-byte to_array the bridge used).
      (fn: SchemeValue, ...args: SchemeValue[]): SchemeValue => {
        typecheck("apply", fn, "function", 1);
        const last = args.pop();
        typecheck("apply", last, ["pair", "nil"], args.length + 2);
        args = args.concat(listToArray(last));
        return fn.apply(undefined, args);
      },
    ),

    "make-list": symbol.native`make-list: build a list of k copies of fill (default #f)`(
      { input: [z.schemeNumber, z.unknown().optional()], output: [z.unknown()] },
      (k: unknown, fill?: unknown): unknown => {
        const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
        const value = fill === undefined ? false : fill;
        let result: unknown = nil;
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
      { input: [z.union([z.pair, z.nil]), z.schemeNumber], output: [z.unknown()] },
      (list: unknown, k: unknown): unknown => {
        const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
        let current = list;
        for (let i = 0; i < count; i++) {
          TypeError.invariant(current instanceof APair, `list-tail: list too short`);
          current = current.cdr;
        }
        return current;
      },
    ),

    "list-ref": symbol.native`list-ref: the element at index k`(
      { input: [z.union([z.pair, z.nil]), z.schemeNumber], output: [z.unknown()] },
      (list: unknown, k: unknown): unknown => {
        const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
        let current = list;
        for (let i = 0; i < count; i++) {
          TypeError.invariant(current instanceof APair, `list-ref: list too short`);
          current = current.cdr;
        }
        TypeError.invariant(current instanceof APair, `list-ref: index out of bounds`);
        return current.car;
      },
    ),

    "list-set!": symbol.native`list-set!: store obj at index k (mutates the spine)`(
      { input: [z.union([z.pair, z.nil]), z.schemeNumber, z.unknown()], output: [z.void()] },
      (list: unknown, k: unknown, obj: unknown): void => {
        const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
        let current = list;
        for (let i = 0; i < count; i++) {
          TypeError.invariant(current instanceof APair, `list-set!: list too short`);
          current = current.cdr;
        }
        TypeError.invariant(current instanceof APair, `list-set!: index out of bounds`);
        current.car = obj;
      },
    ),

    "list-copy": symbol.native`list-copy: a fresh copy of the list spine (R7RS freshness)`(
      { input: [z.union([z.pair, z.nil])], output: [z.unknown()] },
      (list: unknown): unknown => {
        // \`=== nil\` would miss Nil clones (singletons minted via withProvenance by
        // the evaluator's control-flow provenance pass). A clone bypassed the
        // guard, fell to the \`!(instanceof Pair)\` improper-list branch on the next
        // line, and aliased the input by reference — violating R7RS list-copy's
        // fresh-allocation contract. \`instanceof Nil\` keeps the freshness story
        // intact for both the singleton and any clones.
        if (list instanceof ANil) return nil;
        if (!(list instanceof APair)) return list;
        TypeError.invariant(!isCircularList(list), "list-copy: circular list");
        // Deep copy the spine of the list
        const copy = (lst: unknown): unknown => {
          // Same clone-aware check at the recursion base: a Nil clone in the cdr
          // would otherwise be preserved as an improper-list tail.
          if (lst instanceof ANil) return nil;
          if (!(lst instanceof APair)) return lst; // improper list tail
          return new APair(CONSTANT_CTX, lst.car, copy(lst.cdr));
        };
        // Copy is a fresh allocation but semantically the same lineage as \`list\`.
        return withInputProvenance([list], copy(list));
      },
    ),

    // R7RS 6.4 List searching functions
    memq: symbol.native`memq: first sublist whose car is eq? to obj, else #f`(
      { input: [z.unknown(), z.union([z.pair, z.nil])], output: [z.unknown()] },
      (obj: unknown, list: unknown): unknown => {
        let current = list;
        TypeError.invariant(!isCircularList(list), "memq: circular list");
        while (current instanceof APair) {
          // eq? comparison (object identity)
          if (current.car === obj) return current;
          current = current.cdr;
        }
        return false;
      },
    ),

    memv: symbol.native`memv: first sublist whose car is eqv? to obj, else #f`(
      { input: [z.unknown(), z.union([z.pair, z.nil])], output: [z.unknown()] },
      (obj: unknown, list: unknown): unknown => {
        let current = list;
        TypeError.invariant(!isCircularList(list), "memv: circular list");
        while (current instanceof APair) {
          if (eqv(current.car, obj)) return current;
          current = current.cdr;
        }
        return false;
      },
    ),

    assq: symbol.native`assq: first alist entry whose car is eq? to obj, else #f`(
      { input: [z.unknown(), z.union([z.pair, z.nil])], output: [z.unknown()] },
      (obj: unknown, alist: unknown): unknown => {
        let current = alist;
        TypeError.invariant(!isCircularList(alist), "assq: circular list");
        while (current instanceof APair) {
          const pair = current.car;
          if (pair instanceof APair && pair.car === obj) return pair;
          current = current.cdr;
        }
        return false;
      },
    ),

    assv: symbol.native`assv: first alist entry whose car is eqv? to obj, else #f`(
      { input: [z.unknown(), z.union([z.pair, z.nil])], output: [z.unknown()] },
      (obj: unknown, alist: unknown): unknown => {
        let current = alist;
        TypeError.invariant(!isCircularList(alist), "assv: circular list");
        while (current instanceof APair) {
          const pair = current.car;
          if (pair instanceof APair && eqv(pair.car, obj)) return pair;
          current = current.cdr;
        }
        return false;
      },
    ),

    // member uses equal? (deep structural equality)
    member: symbol.native`member: first sublist whose car is equal? to obj (or per compare), else #f`(
      {
        input: [z.unknown(), z.union([z.pair, z.nil]), z.custom<(a: unknown, b: unknown) => boolean>().optional()],
        output: [z.unknown()],
      },
      (obj: unknown, list: unknown, compare?: (a: unknown, b: unknown) => boolean): unknown => {
        const cmp = compare || ((a: unknown, b: unknown) => structuralEqual(a, b));
        let current = list;
        TypeError.invariant(!isCircularList(list), "member: circular list");
        while (current instanceof APair) {
          // \`cmp\` may be a user-supplied Scheme predicate whose result is a boxed
          // SchemeBool post-L1 (a truthy JS object); route through is_false.
          if (!is_false(cmp(obj, current.car))) return current;
          current = current.cdr;
        }
        return false;
      },
    ),

    // assoc uses equal? (deep structural equality)
    assoc: symbol.native`assoc: first alist entry whose car is equal? to obj (or per compare), else #f`(
      {
        input: [z.unknown(), z.union([z.pair, z.nil]), z.custom<(a: unknown, b: unknown) => boolean>().optional()],
        output: [z.unknown()],
      },
      (obj: unknown, alist: unknown, compare?: (a: unknown, b: unknown) => boolean): unknown => {
        const cmp = compare || ((a: unknown, b: unknown) => structuralEqual(a, b));
        let current = alist;
        TypeError.invariant(!isCircularList(alist), "assoc: circular list");
        while (current instanceof APair) {
          const pair = current.car;
          // \`cmp\` may be a user-supplied Scheme predicate → boxed SchemeBool post-L1.
          if (pair instanceof APair && !is_false(cmp(obj, pair.car))) return pair;
          current = current.cdr;
        }
        return false;
      },
    ),

    // ---------------------------------------------------------------------
    // LIPS-era list builtins relocated from stdlib.ts global_env (stdlib
    // elimination). These are polymorphic / non-R7RS extensions (`reverse`,
    // `nth` accept arrays as well as pairs; `clone`/`flatten`/`tree->array`/
    // `array->list`/`list->array` are LIPS extensions). Bodies reproduced
    // byte-for-byte; runtime `typecheck` guards preserved. `native` means the
    // (identity) zod contract never runs — the impls receive Scheme values
    // exactly as the old `doc({ value })` form did.
    // ---------------------------------------------------------------------
    clone: symbol.native`clone: a deep copy of the list spine (LIPS extension)`(
      { input: [z.unknown()], output: [z.unknown()] },
      (list: SchemeValue): SchemeValue => {
        typecheck("clone", list, "pair");
        return list.clone();
      },
    ),

    append: symbol.native`append: a fresh list splicing all argument lists (R7RS, last arg may be improper)`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      (...items: SchemeValue[]): SchemeValue => {
        // `append` builds a FRESH list (pure). It clones every segment first, then
        // splices the CLONES together via Pair.append. Because every cell touched
        // is a clone, no caller-visible value is mutated — the result is the only
        // new thing. (The destructive `append!` builtin this used to delegate to is
        // OMITTED by the purity invariant — doored above. Its splice
        // logic is inlined here, operating on clones, so it stays pure.)
        const is_list = isProperList;
        const cloned = items.map((item) => (is_pair(item) ? item.clone() : item));
        return cloned.reduce((acc, item, idx) => {
          typecheck("append", acc, ["nil", "pair"]);
          // R7RS: last argument can be any value (creates improper list)
          const isLast = idx === cloned.length - 1;
          if (!isLast && (is_pair(item) || is_nil(item)) && !is_list(item)) {
            throw new Error("append: Invalid argument, value is not a list");
          }
          if (is_nil(acc)) {
            return is_nil(item) ? nil : item;
          }
          if (is_null(item)) {
            return acc;
          }
          return concatPair(ctxOf(item), acc, item);
        }, nil);
      },
    ),

    reverse: symbol.native`reverse: the list (or array) reversed (LIPS-polymorphic)`(
      { input: [z.unknown()], output: [z.unknown()] },
      (arg: SchemeValue): SchemeValue => {
        typecheck("reverse", arg, ["array", "pair", "nil"]);
        if (is_nil(arg)) {
          return nil;
        }
        if (is_pair(arg)) {
          const arr = listToArray(arg).toReversed();
          return arrayToList(arr);
        } else if (Array.isArray(arg)) {
          return arg.toReversed();
        } else {
          throw new TypeError(typeErrorMessage("reverse", type(arg), "array or pair"));
        }
      },
    ),

    nth: symbol.native`nth: the element at index (LIPS-polymorphic over array/pair)`(
      { input: [z.unknown(), z.unknown()], output: [z.unknown()] },
      (index: SchemeValue, obj: SchemeValue): SchemeValue => {
        typecheck("nth", index, "number");
        typecheck("nth", obj, ["array", "pair"]);
        if (is_pair(obj)) {
          let node = obj;
          let count = 0;
          while (count < index) {
            if (!node.cdr || is_nil(node.cdr) || node.have_cycles("cdr")) {
              return nil;
            }
            node = node.cdr as APair;
            count++;
          }
          return node.car;
        } else if (Array.isArray(obj)) {
          return obj[index];
        } else {
          throw new TypeError(typeErrorMessage("nth", type(obj), "array or pair", 2));
        }
      },
    ),

    flatten: symbol.native`flatten: the list with nested lists spliced in (LIPS extension)`(
      { input: [z.unknown()], output: [z.unknown()] },
      (list: SchemeValue): SchemeValue => {
        typecheck("flatten", list, "pair");
        return list.flatten();
      },
    ),

    "array->list": symbol.native`array->list: a proper list built from a JS array`(
      { input: [z.unknown()], output: [z.unknown()] },
      (array: SchemeValue): SchemeValue => arrayToList(array),
    ),

    "tree->array": symbol.native`tree->array: a nested JS array built from a tree of pairs`(
      { input: [z.unknown()], output: [z.unknown()] },
      (list: SchemeValue): SchemeValue => treeToArray(list),
    ),

    "list->array": symbol.native`list->array: a JS array built from a proper list`(
      { input: [z.unknown()], output: [z.unknown()] },
      (list: SchemeValue): SchemeValue => listToArray(list),
    ),
  },
});
