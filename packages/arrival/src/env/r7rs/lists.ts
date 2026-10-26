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
 * representation-blind (`z.schemeValue`), and the optional user comparator is the
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

// Installs the global `TypeError.invariant` assertion helper used by the
// list-bounds and circular-list guards below (side-effect import).
import "@here.build/error-invariant";
import { adoptSpine } from "../../membrane/adopt-spine.js";
import dedent from "dedent";
import { CONSTANT_CTX, type RunContext } from "../../run/RunContext.js";
import { applyCallback, type ACallable } from "../../values/primitives/ACallable.js";
import type { MaybePromise } from "../../types/utility.js";
import { assertAllocatable, toIndex, withInputProvenance } from "../../values/op-helpers.js";
import { schemeFalse } from "../../values/primitives/ABool.js";
import invariant from "tiny-invariant";
import { APair, concatPair, isCircularList } from "../../values/primitives/APair.js";
import { is_applyable, is_false, is_lambda, is_promise } from "../../values/value-guards.js";
import { type, typeErrorMessage } from "../../membrane/typecheck.js";
import { attachOffendingValue, CarrierMismatchError } from "../../errors.js";
import { eqv, structuralEqual } from "../../values/structural-equal.js";
import { asReceiver, exactly, freshBinding, provesArray, to_array } from "../pack-helpers.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { printValue } from "../../values/print.js";
import { theVoid } from "../../values/primitives/AVoid.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AVector } from "../../values/primitives/AVector.js";
import { AString } from "../../values/primitives/AString.js";
import { ABytevector } from "../../values/primitives/ABytevector.js";
import { EnvCapability } from "../../common/capability.js";
import { call_function } from "../../eval/call-function.js";
import { maybeThen, settleAll } from "../../utils/promises.js";
import { tf } from "../../values/tagless-final.js";
import type { AListAlike, SchemeValue } from "../../values/types.js";
// TYPE-ONLY import of the compiler-facing Contract.emit surface (emit-rule.ts
// imports nothing back from this tree).
import type { EmitRule } from "../../emit/emit-rule.js";
import {
  ArrayLit,
  Arrow,
  Bin,
  Call,
  Index,
  Lit,
  Member,
  Method,
  Ref,
  Spread,
  type BinOp,
  type R,
} from "../../emit/residual-lite.js";

// Default equal? path for member/assoc: call structuralEqual directly — a bare
// JS function is refused by call_function. User-supplied compare stays ACallable.
const listToArray = to_array("list->array");

function arrayToList(ctx: RunContext, array: SchemeValue[]): SchemeValue {
  return APair.fromArray(ctx, array);
}

/**
 * Search-family list door — memq / memv / member / assq / assv / assoc.
 *
 * These six walk `while (current instanceof APair) { … } return #f`. A non-list
 * argument never enters the loop and answers the same `#f` as "not found" — a
 * silent lie. Contracts are type-only at bake, so the declared `z.listAlike`
 * does not stop a non-list at runtime; adoption has already projected borrowed
 * arrays onto spine views, so a failure here is a genuine type error.
 */
function requireListArg(verb: string, list: unknown): void {
  if (list instanceof APair || list instanceof ANil) return;
  throw attachOffendingValue(
    new TypeError(
      `${verb}: expected a list, got ${type(list)}: ${String(printValue(list)).slice(0, 60)}. ` +
        `(${verb} returns #f for "not found" — so a non-list here would have silently answered "not found" ` +
        `about a value it never searched.)`,
    ),
    list,
  );
}

/** Index/count door shared by make-list / list-ref / list-tail: a negative or fractional
 *  index must not fall out of a `for (i < count)` loop as "0 steps" or "ceil(count) steps". */
function listIndex(verb: string, k: unknown): number {
  const n = toIndex(k);
  if (!Number.isInteger(n) || n < 0) {
    throw attachOffendingValue(
      new TypeError(`${verb}: expected a non-negative exact integer, got ${String(printValue(k)).slice(0, 60)}`),
      k,
    );
  }
  return n;
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

// P5 door for `append`'s non-last operands (R7RS §6.4): must be proper lists —
// a non-pair/non-nil there would silently contribute nothing or become the whole
// result. Names the carrier-specific concat verb when one exists.
function nonListAppendOperandError(item: SchemeValue): CarrierMismatchError {
  if (item instanceof AVector) return new CarrierMismatchError("append", "vector", "vector-append");
  if (item instanceof AString) return new CarrierMismatchError("append", "string", "string-append");
  if (item instanceof ABytevector) return new CarrierMismatchError("append", "bytevector", "bytevector-append");
  return new CarrierMismatchError("append", type(item));
}

// Multi-list `map` is a ZIP: corresponding elements, truncate to shortest.
function multiListMap(fn: ACallable, lists: readonly SchemeValue[], runCtx: RunContext): MaybePromise<SchemeValue> {
  if (lists.some((list) => list instanceof ANil)) return nil;
  const arrays = lists.map((l) => listToArray(l));
  const len = Math.min(...arrays.map((a) => a.length));
  const results: MaybePromise<SchemeValue>[] = [];
  for (let i = 0; i < len; i++) {
    results.push(
      call_function(
        fn,
        arrays.map((a) => a[i]),
        { runCtx },
      ),
    );
  }
  return maybeThen(settleAll(results), (resolved) => APair.fromArray(CONSTANT_CTX, resolved));
}

// mapImpl vs multiListMap differ on improper-list error text: mapImpl's per-arg
// isProperList raises "map: argument N is not a list"; multiListMap lets listToArray
// raise its own circular-list error. for-each must thread `this.runCtx`, never CONSTANT_CTX.
function mapImpl(runCtx: RunContext, fn: ACallable, lists: readonly AListAlike[]): MaybePromise<SchemeValue> {
  // Contracts are type-only: the runtime procedure check stays.
  invariant(is_applyable(fn), `map: the first argument is not a procedure`);
  const is_list = isProperList;
  for (const [i, arg] of lists.entries()) {
    invariant(!(arg instanceof APair) || is_list(arg), `map: argument ${i + 1} is not a list`);
  }
  if (lists.length === 0 || lists.some((list) => list instanceof ANil)) {
    return nil;
  }

  const arrays = lists.map((l) => listToArray(l));
  const length = Math.min(...arrays.map((a) => a.length));

  const results: MaybePromise<SchemeValue>[] = [];
  for (let i = 0; i < length; i++) {
    const args = arrays.map((arr) => arr[i]);
    results.push(call_function(fn, args, { runCtx }));
  }
  return maybeThen(settleAll(results), (resolved) => APair.fromArray(CONSTANT_CTX, resolved));
}

// ════════════════════════════════════════════════════════════════════════════
// Contract.emit — cons / map / apply / length / list-ref
// Residual selection keys on ARGUMENT facts or arity (Law A), never result types
// or source syntax. Residual-lite constructors from emit/.
//
// Law A is not uniform:
//   cons — three-way gate on the TAIL's fact (provesArray / provesScalar / unknown)
//   map / apply — fact-blind; branch on ARITY (map) or lowered operator residual
//     tag (apply fold of +/*). Generic apply spreads the final list.
//   length / list-ref — provesArray: proven → direct property/index; unknown → shim.
// ════════════════════════════════════════════════════════════════════════════

// ── cons — representation collapse, three-way tail gate ────────────────────────────
// Lists/pairs/vectors lower to arrays, but list-tail and dotted-tail need DIFFERENT
// array literals: list tail → `[x, ...xs]` (spread); scalar tail → `[x, xs]` (no
// spread). Spreading a non-array throws ("not iterable") or char-explodes a string —
// the `(cons 'key value)` alist shape. Tail fact (`ctx.argFacts[1]`, Law A):
//   provesArray  → spread
//   provesScalar → 2-element literal
//   unknown      → runtime `cons` shim (Array.isArray at runtime)
// Unconditional spread on unknown reintroduces that crash.
/** Disjoint complement of provesArray: a scalar fact rules OUT array-shape. A mixed
 *  union (`string | number[]`) claims neither (∀-walk) and falls to the shim. */
const provesScalar = (f: { stringy?: true; numeric?: true; boolean?: true } | undefined): boolean =>
  f?.stringy === true || f?.numeric === true || f?.boolean === true;

const consEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [x, xs] = exactly(ctx, "cons", args, 2);
    const tail = ctx.argFacts[1];
    if (provesArray(tail)) return ArrayLit([x!, Spread(xs!)]);
    if (provesScalar(tail)) return ArrayLit([x!, xs!]);
    return Call(ctx.runtime("cons"), [x!, xs!]);
  },
};

// ── map — arity bridge, always sync-shaped (Law W) ──────────────────────────────────
// Single-list → Array.prototype.map; multi-list → index-zip arrow off lists[0].length.
// Async f is ASYNC-IFY's problem at the consuming edge, not this rule's.
const mapEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    if (args.length < 2)
      ctx.door(
        `\`map\` wants a function and at least one list, got ${args.length} argument${args.length === 1 ? "" : "s"}`,
      );
    const [f, ...lists] = args;
    if (lists.length === 1) return Method(lists[0]!, "map", [f!]);
    const el = freshBinding(ctx, "item");
    const idx = freshBinding(ctx, "i");
    const rest = lists.slice(1).map((l) => Index(l, Ref(idx)));
    return Method(lists[0]!, "map", [Arrow([el, idx], Call(f!, [Ref(el), ...rest]))]);
  },
};

// ── apply — fold / arity bridge ─────────────────────────────────────────────────────
// `(apply + xs)` → reduce with identity, recognized STRUCTURALLY on the already-
// lowered operator residual (`RuntimeRef("+")`). Law A forbids syntax/result peeks,
// not residual-plane recognition of the value in hand.
// Generic `(apply f a b xs)` → `f(a, b, ...xs)` (spread, not f.apply).
const FOLD_OPS: Readonly<Record<string, { readonly op: BinOp; readonly identity: number }>> = {
  "+": { op: "+", identity: 0 },
  "*": { op: "*", identity: 1 },
};

const applyEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    if (args.length < 2) ctx.door("`apply` wants a function and a trailing argument list");
    const f = args[0]!;
    const last = args.at(-1)!;
    if (args.length === 2 && f.t === "RuntimeRef") {
      const fold = FOLD_OPS[f.symbol];
      if (fold !== undefined) {
        const acc = freshBinding(ctx, "acc");
        const item = freshBinding(ctx, "item");
        return Method(last, "reduce", [Arrow([acc, item], Bin(fold.op, Ref(acc), Ref(item))), Lit(fold.identity)]);
      }
    }
    return Call(f, [...args.slice(1, -1), Spread(last)]);
  },
};

// ── length / list-ref — same provesArray gate as cons ───────────────────────────────
// Proven → direct `.length` / `[k]`; unknown → runtime shim (wider carrier domain).
// OOB (list-ref only, intentional): proven-array `xs[k]` OOB → JS undefined; interpreter
// spine walk throws. Fast path optimizes the value-producing case — same stance as
// quotient/modulo not replicating divide-by-zero throws.
const lengthEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [xs] = exactly(ctx, "length", args, 1);
    return provesArray(ctx.argFacts[0]) ? Member(xs!, "length") : Call(ctx.runtime("length"), [xs!]);
  },
};

const listRefEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [xs, k] = exactly(ctx, "list-ref", args, 2);
    return provesArray(ctx.argFacts[0]) ? Index(xs!, k!) : Call(ctx.runtime("list-ref"), [xs!, k!]);
  },
};

export default EnvCapability.define("scheme/lists", {
  symbols: (symbol, z) => ({
    // R7RS 6.10 — one list: operand's own tf(map); several: zip (multiListMap).
    map: symbol.sequence`map: fn over one list (its own term map — box discipline) or a zip over several`(
      // HEAD = fn; TAIL = sequences answering tf(map) (Pair/Nil/Vector) → z.schemeValue,
      // not pair|nil. Output z.schemeValue (SchemeValue | Promise, no raw-primitive leak).
      {
        input: z.tuple([z.lambda], z.schemeValue),
        output: [z.schemeValue],
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
        emit: mapEmitRule,
      },
      (args, runCtx) => {
        const [fn, ...lists] = args;
        if (lists.length === 1) {
          const seq = lists[0];
          const m = asReceiver(seq)?.[tf("map")];
          if (m === undefined) {
            // Same taught error as requireTerm (whose untyped return would need a cast).
            throw attachOffendingValue(
              new TypeError(`map: the ${typeof seq} operand does not support map (no ${tf("map")}).`),
              seq,
            );
          }
          return m.call(seq, fn, runCtx);
        }
        return multiListMap(fn, lists, runCtx);
      },
    ),
    // R7RS 6.4 — for-each: map for side effects, unspecified result.
    "for-each": symbol.native`for-each: apply fn to corresponding elements of one or more lists, for side effects`(
      // fn = fixed HEAD; lists = variadic TAIL (list-only, not map's z.schemeValue).
      // Output UNSPECIFIED → z.undefinedResult.
      {
        input: [z.lambda],
        inputRest: z.listAlike,
        output: [z.undefinedResult],
        // P18: for-each is a fan whose tracks are the callback applications; its callback is an
        // `effect` (void egress — no product wire). Order among tracks is not observable.
        provenance: "fan",
        callbackRoles: ["effect"],
        type: dedent`
          {
            <T>(f: (x: T) => unknown, xs: List<T>): void;
            <A, B>(f: (a: A, b: B) => unknown, as: List<A>, bs: List<B>): void;
            <A, B, C>(f: (a: A, b: B, c: C) => unknown, as: List<A>, bs: List<B>, cs: List<C>): void;
          }
        `,
      },
      // Thread `this.runCtx` into mapImpl (not CONSTANT_CTX).
      function (fn, ...lists) {
        const ret = mapImpl(this.runCtx, fn, lists);
        // R7RS unspecified → theVoid on the scheme face.
        if (is_promise(ret)) {
          return ret.then(() => theVoid);
        }
        return theVoid;
      },
    ),
    // R7RS 6.4
    cons: symbol.native`cons: a pair (car . cdr) — the fundamental list constructor`(
      {
        input: [z.schemeValue, z.schemeValue],
        output: [z.pair],
        type: dedent`
          {
            <H, T>(h: H, t: List<T>): List<H | T>;
            <H, T>(h: H, t: T): Tuple<H, T>;
          }
        `,
        emit: consEmitRule,
      },
      function (car, cdr) {
        return withInputProvenance(this.runCtx, [car, cdr], new APair(car, cdr));
      },
    ),

    // R7RS 6.4 — constructor; stamps provenance on the produced head only.
    list: symbol.native`list: a proper list of its arguments`(
      {
        input: z.array(z.schemeValue),
        output: [z.schemeValue],
        type: dedent`
          {
            <T>(...xs: T[]): List<T>;
          }
        `,
      },
      function (...args) {
        const result = args.reduceRight((list, item) => new APair(item, list), nil);
        return withInputProvenance(this.runCtx, args, result);
      },
    ),

    // ── PURITY DOORS — pair/list mutators omitted (R7RS §6.4) ──────────────────
    // Values are frozen; a write would falsify construction-site provenance.
    "set-car!": symbol.notImplemented`set-car!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (cons / list)`,
    "set-cdr!": symbol.notImplemented`set-cdr!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (cons / list)`,
    "append!": symbol.notImplemented`append!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (append, which builds a fresh list)`,

    // R7RS 6.4 — settled AExact/AInexact (z.schemeNumber), never a speculative carrier.
    length: symbol.native`length: the number of elements in a proper list (or any .length carrier)`(
      {
        input: [z.schemeValue],
        output: [z.schemeNumber],
        type: dedent`
          {
            (xs: List<unknown> | readonly unknown[] | string): number;
          }
        `,
        emit: lengthEmitRule,
      },
      function (obj) {
        // R7RS length is an exact integer — box to AExact, matching string-length.
        if (obj == null) return new AExact(0);
        // Operand's own `arrival/tagless-final/length` — carries element provenance and
        // circular-list check. TOTALIC: no length algebra → type error, never silent 0.
        // Bare `.length` fallback for non-term carriers (membrane-wrapped JS arrays).
        const m = asReceiver(obj)?.[tf("length")];
        if (m !== undefined) {
          const result = m.call(obj, this.runCtx);
          // Real terms return AExact/AInexact only (P4). A raw number here is a producer
          // bug — fail loudly rather than re-box.
          invariant(
            result instanceof AExact || result instanceof AInexact,
            `length: a term's own length must be a boxed count (bare-value-purge/P4) — got ${typeof result}`,
          );
          return result;
        }
        if (typeof obj === "object" && "length" in obj) {
          const len = obj.length;
          if (typeof len === "number") return withInputProvenance(this.runCtx, [obj], new AExact(len));
        }
        throw attachOffendingValue(
          new TypeError(`length: the ${typeof obj} operand does not support length (no arrival/tagless-final/length).`),
          obj,
        );
      },
    ),

    apply: symbol.native`apply: call fn with the leading args prepended to the final list argument`(
      // R7RS §6.10: (apply proc arg₁ … argₙ arg-list). HEAD = callable; TAIL = leading
      // args + final list to splice.
      {
        input: [z.lambda],
        inputRest: z.schemeValue,
        output: [z.schemeValue],
        type: dedent`
          {
            <R>(proc: () => R, args: List<never>): R;
            <A, R>(proc: (a: A) => R, args: List<A>): R;
            <A, B, R>(proc: (a: A, b: B) => R, a: A, args: List<B>): R;
            <A, R>(proc: (...args: A[]) => R, ...argsThenList: [...A[], List<A>]): R;
          }
        `,
        emit: applyEmitRule,
      },
      // listToArray doors improper/atom final arg (no non-iterable spread crash).
      function (fn, ...rest) {
        const last = rest.at(-1);
        invariant(last !== undefined, "apply: requires an argument list as the final argument");
        const spread = listToArray(last);
        const args = [...rest.slice(0, -1), ...spread];
        // Tail position (R7RS §3.5): the evaluator granted `canBounce`, so a lambda callee hands
        // back its body generator for the caller's trampoline instead of nesting a run() per
        // level (which overflowed the host stack at ~20k). The grant is consumed here, not
        // forwarded: `fn` sees an ordinary ctx.
        if (this.canBounce === true && is_lambda(fn)) {
          const { canBounce: _granted, ...calleeCtx } = this;
          // Cast: Impl's return type has no bounce-marker arm; ANativeProcedure's apply passes the marker through.
          return fn[tf("apply")](args, calleeCtx, true) as MaybePromise<SchemeValue>;
        }
        // Thread whole CallCtx (not just runCtx) so invocation provenance reaches fn.
        return applyCallback(fn, args, this);
      },
    ),

    "make-list": symbol.native`make-list: build a list of k copies of fill (default #f)`(
      // Constructor always yields proper list → pair|nil, not open schemeValue.
      {
        input: [z.schemeNumber, z.schemeValue.optional()],
        output: [z.union([z.pair, z.nil])],
        type: dedent`
          {
            <T>(k: number, fill?: T): List<T>;
          }
        `,
      },
      function (k, fill) {
        const count = listIndex("make-list", k);
        // O(1) cap check BEFORE the cons loop materializes `count` cells — see assertAllocatable.
        assertAllocatable(count, "make-list");
        const value = fill === undefined ? schemeFalse : fill;
        let result: AListAlike = nil;
        for (let i = 0; i < count; i++) {
          result = new APair(value, result);
        }
        // Stamp head only — internal cells share lineage.
        return withInputProvenance(this.runCtx, fill === undefined ? [k] : [k, fill], result);
      },
    ),

    "list-tail": symbol.native`list-tail: the sublist obtained by dropping the first k elements`(
      // z.schemeValue: walked-to position may be an improper list's dangling tail.
      {
        input: [z.listAlike, z.schemeNumber],
        output: [z.schemeValue],
        type: dedent`
          {
            <T>(xs: List<T>, k: number): List<T>;
          }
        `,
      },
      function (list, k) {
        const count = listIndex("list-tail", k);
        let current: SchemeValue = list;
        for (let i = 0; i < count; i++) {
          TypeError.invariant(current instanceof APair, `list-tail: list too short`);
          current = current.cdr;
        }
        return current;
      },
    ),

    "list-ref": symbol.native`list-ref: the element at index k`(
      {
        input: [z.listAlike, z.schemeNumber],
        output: [z.schemeValue],
        type: dedent`
          {
            <T>(xs: List<T>, k: number): T;
          }
        `,
        emit: listRefEmitRule,
      },
      function (list, k) {
        const count = listIndex("list-ref", k);
        let current: SchemeValue = list;
        for (let i = 0; i < count; i++) {
          TypeError.invariant(current instanceof APair, `list-ref: list too short`);
          current = current.cdr;
        }
        TypeError.invariant(current instanceof APair, `list-ref: index out of bounds`);
        return current.car;
      },
    ),

    // Purity door — in-place spine write falsifies construction-site provenance.
    "list-set!": symbol.notImplemented`list-set!: every value is frozen by design — mutating a list in place would falsify the provenance lineage its spine carries; build the updated list instead (e.g. (append (list-head lst k) (list obj) (list-tail lst (+ k 1))))`,

    "list-copy": symbol.native`list-copy: a fresh copy of the list spine (R7RS freshness)`(
      // z.schemeValue: tolerates improper list (dangling tail returned as-is).
      {
        input: [z.listAlike],
        output: [z.schemeValue],
        type: dedent`
          {
            <T>(xs: List<T>): List<T>;
          }
        `,
      },
      function (list) {
        // instanceof ANil (not === nil): Nil clones from provenance stamping must
        // not fall through to the improper-list alias branch.
        if (list instanceof ANil) return nil;
        if (!(list instanceof APair)) return list;
        TypeError.invariant(!isCircularList(list), "list-copy: circular list");
        // Iterative (a recursive copy overflows the stack on long lists): collect cars,
        // then cons them back onto the original dangling tail (nil, or an improper tail).
        const cars: SchemeValue[] = [];
        let tail: SchemeValue = list;
        while (tail instanceof APair) {
          cars.push(tail.car);
          tail = tail.cdr;
        }
        let copy: SchemeValue = tail instanceof ANil ? nil : tail;
        for (let i = cars.length - 1; i >= 0; i--) copy = new APair(cars[i], copy);
        return withInputProvenance(this.runCtx, [list], copy);
      },
    ),

    // R7RS 6.4 search — match arm ∪ z.booleanFalse (no-match sentinel), never match alone.
    memq: symbol.native`memq: first sublist whose car is eq? to obj, else #f`(
      // obj is z.schemeValue BY DESIGN: eq? is representation-blind ===.
      {
        input: [z.schemeValue],
        inputRest: z.pair,
        output: [z.union([z.pair, z.booleanFalse])],
        type: dedent`
          {
            <T>(obj: T, list: List<T>): List<T> | false;
          }
        `,
      },
      function (obj, list) {
        let current: SchemeValue = list;
        requireListArg("memq", list);
        TypeError.invariant(!isCircularList(list), "memq: circular list");
        while (current instanceof APair) {
          if (current.car === obj) return current;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    memv: symbol.native`memv: first sublist whose car is eqv? to obj, else #f`(
      {
        input: [z.schemeValue, z.listAlike],
        output: [z.union([z.schemeValue, z.booleanFalse])],
        type: dedent`
          {
            <T>(obj: T, list: List<T>): List<T> | false;
          }
        `,
      },
      function (obj, list) {
        let current: SchemeValue = list;
        // isCircularList needs a Pair — ANil short-circuits.
        requireListArg("memv", list);
        TypeError.invariant(!(list instanceof APair && isCircularList(list)), "memv: circular list");
        while (current instanceof APair) {
          if (eqv(current.car, obj)) return current;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    assq: symbol.native`assq: first alist entry whose car is eq? to obj, else #f`(
      {
        input: [z.schemeValue, z.listAlike],
        output: [z.union([z.schemeValue, z.booleanFalse])],
        type: dedent`
          {
            <K, V>(obj: K, alist: List<[K, V]>): [K, V] | false;
          }
        `,
      },
      function (obj, alist) {
        let current: SchemeValue = alist;
        TypeError.invariant(!(alist instanceof APair && isCircularList(alist)), "assq: circular list");
        requireListArg("assq", alist);
        while (current instanceof APair) {
          // ENTRY ADOPTION: a tool-returned alist is JSON arrays-of-arrays (AJSArray),
          // not APair — without adoptSpine every entry is skipped → silent "#f not found".
          // adoptSpine projects borrowed arrays onto the spine chart (O(1)); genuine
          // cons cells and non-pair entries pass through (R7RS leniency on bare values).
          // Affordance at point of use — does not promote alists to dicts.
          const pair = adoptSpine(current.car);
          if (pair instanceof APair && pair.car === obj) return pair;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    assv: symbol.native`assv: first alist entry whose car is eqv? to obj, else #f`(
      {
        input: [z.schemeValue, z.listAlike],
        output: [z.union([z.schemeValue, z.booleanFalse])],
        type: dedent`
          {
            <K, V>(obj: K, alist: List<[K, V]>): [K, V] | false;
          }
        `,
      },
      function (obj, alist) {
        let current: SchemeValue = alist;
        TypeError.invariant(!(alist instanceof APair && isCircularList(alist)), "assv: circular list");
        requireListArg("assv", alist);
        while (current instanceof APair) {
          // ENTRY ADOPTION — see assq.
          const pair = adoptSpine(current.car);
          if (pair instanceof APair && eqv(pair.car, obj)) return pair;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    // equal?-grade search. compare returns unknown (boxed SchemeBool) → is_false, not raw boolean.
    member: symbol.native`member: first sublist whose car is equal? to obj (or per compare), else #f`(
      {
        input: [z.schemeValue, z.listAlike, z.lambda.optional()],
        output: [z.union([z.schemeValue, z.booleanFalse])],
        type: dedent`
          {
            <T>(obj: T, list: List<T>): List<T> | false;
            <T>(obj: T, list: List<T>, compare: (a: T, b: T) => unknown): List<T> | false;
          }
        `,
        // compare is `control` (equality selector decides which sublist egresses).
        callbackRoles: ["control"],
      },
      function (obj, list, compare) {
        let current: SchemeValue = list;
        requireListArg("member", list);
        TypeError.invariant(!(list instanceof APair && isCircularList(list)), "member: circular list");
        while (current instanceof APair) {
          const hit =
            compare === undefined
              ? structuralEqual(obj, current.car)
              : !is_false(
                  call_function(compare, [obj, current.car], {
                    runCtx: this.runCtx,
                  }),
                );
          if (hit) return current;
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    // R7RS §6.4 structural-equality member of the assq/assv/assoc trio.
    assoc: symbol.native`assoc: first alist entry whose car is equal? to obj (or per compare), else #f`(
      {
        input: [z.schemeValue, z.listAlike, z.lambda.optional()],
        output: [z.union([z.schemeValue, z.booleanFalse])],
        type: dedent`
          {
            <K, V>(obj: K, alist: List<[K, V]>): [K, V] | false;
            <K, V>(obj: K, alist: List<[K, V]>, compare: (a: K, b: K) => unknown): [K, V] | false;
          }
        `,
        callbackRoles: ["control"],
      },
      function (obj, alist, compare) {
        let current: SchemeValue = alist;
        TypeError.invariant(!(alist instanceof APair && isCircularList(alist)), "assoc: circular list");
        requireListArg("assoc", alist);
        while (current instanceof APair) {
          // ENTRY ADOPTION — see assq.
          const pair = adoptSpine(current.car);
          if (pair instanceof APair) {
            const hit =
              compare === undefined
                ? structuralEqual(obj, pair.car)
                : !is_false(
                    call_function(compare, [obj, pair.car], {
                      runCtx: this.runCtx,
                    }),
                  );
            if (hit) return pair;
          }
          current = current.cdr;
        }
        return schemeFalse;
      },
    ),

    append: symbol.native`append: a fresh list splicing all argument lists (R7RS, last arg may be improper)`(
      {
        input: z.array(z.schemeValue),
        output: [z.schemeValue],
        type: dedent`
          {
            <T>(...lists: List<T>[]): List<T>;
            <T, U>(...lists: [...List<T>[], U]): List<T> | U;
          }
        `,
      },
      function (...items) {
        // Fresh list: clone every segment, then splice clones (append! is doored).
        const is_list = isProperList;
        // Spine adoption HERE: contract is z.array(z.schemeValue) (last arg may be
        // non-list — R7RS improper-tail form), so no per-slot schema. EVERY arg adopts,
        // including the last — a borrowed JS array or boxed vector read as spine splices
        // as a list; a non-sequence last arg is untouched, so `(append '(1 2) 3)` still
        // builds `(1 2 . 3)`.
        items = items.map((item) => adoptSpine(item));
        const cloned = items.map((item) => (item instanceof APair ? item.clone() : item));
        return cloned.reduce((acc, item, idx) => {
          // Non-last must be proper lists (P5); last may be any value (improper tail).
          const isLast = idx === cloned.length - 1;
          if (!isLast && !(item instanceof ANil)) {
            if (!(item instanceof APair)) {
              throw attachOffendingValue(nonListAppendOperandError(item), item);
            }
            if (!is_list(item)) {
              throw attachOffendingValue(new Error("append: Invalid argument, value is not a list"), item);
            }
          }
          if (acc instanceof ANil) {
            return item instanceof ANil ? nil : item;
          }
          if (item instanceof ANil) {
            return acc;
          }
          // concatPair embeds `b` as opaque tail without inspecting shape; cast matches
          // runtime (last arg may be non-list), not the over-narrow Cdr bound.
          return concatPair(acc, item as AListAlike);
        }, nil);
      },
    ),

    reverse: symbol.native`reverse: the list reversed`(
      // pair|nil only — no raw-array branch.
      {
        input: [z.listAlike],
        output: [z.schemeValue],
        type: dedent`
          {
            <T>(xs: List<T>): List<T>;
          }
        `,
      },
      function (arg) {
        if (arg instanceof ANil) {
          return nil;
        }
        if (arg instanceof APair) {
          const arr = listToArray(arg).toReversed();
          return arrayToList(this.runCtx, arr);
        }
        throw attachOffendingValue(new TypeError(typeErrorMessage("reverse", type(arg), "array or pair")), arg);
      },
    ),
    // `nth` (index-first, array|pair) is Clojure — scheme/polyglot-clojure, not R7RS.
    // R7RS indexed access is `list-ref` (list first).
  }),
});
