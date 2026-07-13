// SRFI-1 — list library completion. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via `allSrfi`) and evals it
// (via initBridge's assembleEnv), so this module is the sole definition site.
//
// SCOPE: the whole SRFI-1 surface lives here — the *completion* set (take-while …
// length+), `remove` (relocated from arrival-extensions, beside its `delete` twin),
// and the "missing third" + parallel-list utilities (iota, range — iota's [0,stop)
// wrapper, delete-duplicates, filter-map, count, append-map, some/every, zip,
// list-index, unfold) plus the safe list-head accessors first?/first-or — relocated
// here from the dissolved arrival-extensions pack as the falsy/default-on-empty twins of
// SRFI-1 `first`, a contract loose `car` cannot supply (it projects to truthy nil).
//
// DEPS: the define bodies below freely reference
//   • `not`/`equal?`/`eq?`/`pair?`/`null?`  → scheme/equality   (NATIVE_PACKS)
//   • `<=`/`<`/`>=`/`=`/`+`/`-`/`*`         → scheme/numeric    (NATIVE_PACKS)
//   • `error`                               → scheme/exceptions (BASE_PACKS)
//   • `cons`/`reverse`/`append`/`member`/`length`/`map`/`apply`/`list` → scheme/lists (BASE_PACKS)
// `deps: [equality, numeric, exceptions, lists]`.
// span/break/partition return `(list a b)` (multi-return doored on binding).
// `car`/`cdr`/`cadr` need no edge: the cxr synth family is a kernel resolver, in
// the bake allowlist by construction (define-bake.ts's CXR_RE).
//
// CONTRACT CONVENTIONS (the judgment calls, so the next author doesn't re-derive
// them):
//   - list slots: `z.union([z.pair, z.nil])` — the SHALLOW pair-or-nil identity union
//     (this file's own `listAlike`), NEVER `z.list`: the list codec WALKS the spine
//     on decode (O(n) per call) and throws on circular/improper input — but
//     `length+` exists to ANSWER circular lists, and SRFI-1 blesses dotted tails
//     for `take`/`drop` ("(take '(1 2 3 . d) 2) ⇒ (1 2)"). The shallow union is
//     the honest boundary for a family whose bodies own the deep structure
//     handling.
//   - xs slots that tolerate ANY value by spec (%list-nth's not-a-pair→error branch,
//     first?/first-or's whole falsy-on-empty purpose): `z.value` — tolerance IS the
//     declared contract there, not looseness. (take/drop ALSO declare xs as `z.value`,
//     but for a different reason now — see the tagless-final dispatcher convention
//     note below; SRFI-1's own any-value-at-n=0 tolerance is deliberately NOT
//     preserved there anymore.)
//   - two-list products (span/break/partition): `output: [listAlike]` — `(list a b)`.
//   - fresh-list outputs built via `reverse`/`cons` chains: `z.union([z.pair, z.nil])`.
//     Tail-returning outputs (drop/drop-while/append-reverse/concatenate — the result
//     embeds a caller-supplied tail the shallow input contract cannot promise is
//     proper): `z.value`, documented per site.
//   - counts/indices: `z.exact` where built purely from exact literals + `+`/`-`
//     (list-index, length+'s n), `z.schemeNumber` where the value is another
//     verb's output (`count` returns `length`'s result, and length's own
//     declared output is `z.schemeNumber`).
//   - some/every: `z.boolean` — arrival's historical some/every return #t/#f, NOT
//     SRFI's last-pred-value (only #f is falsy here — ANil is truthy — so the `and`
//     chain in %every can only ever egress #t or #f). Deviation preserved 1:1.
//
// PERF PROTOCOL (the hot-path judgment this pack is the flagship for): the
// contract wrapper costs one `z.decode` + one async hop PER CALL THROUGH THE
// BOUND SYMBOL. Most of this pack's defines recurse via named `let` — their
// recursion never re-crosses the boundary, so they pay ONE decode per outer call
// (cold; enforcement is effectively free against interpretation cost). The
// direct self-recursers (%list-nth, %any-null?, %some, %every, zip) are written
// in that same named-let idiom deliberately: a body that self-recursed through
// its own bound wrapper would pay a decode + async hop PER ELEMENT instead. (take
// and drop LEFT this list — they're tagless-final dispatchers now, not scheme
// named-lets; their per-element cost lives on the receiver's own term, outside
// this wrapper's boundary entirely.) The one remaining per-element boundary
// crossing is compositional — %some/%every call the validated `%any-null?`
// sibling once per element-tuple, and zip's loop calls validated `some` per
// element — negligible against interpretation cost, so the `validate:false`
// valve stays unused, reached for only when evidence demands it.
import { type CallCtx, type MaybePromise, resolveMethod, symbol, withCallbackRoles } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import { is_false } from "../../eval/guards.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { maybeThen } from "../../utils/promises.js";
import { applyCallback } from "../../values/primitives/ACallable.js";
import { type RunContext } from "../../values/primitives/RunContext.js";
import * as z from "../../common/scheme-zod.js";
import { tf } from "../../values/tagless-final.js";
import type { AListAlike, SchemeValue } from "../../values/types.js";
import equality from "../r7rs/equality.js";
import exceptions from "../r7rs/exceptions.js";
import lists from "../r7rs/lists.js";
import numeric from "../r7rs/numeric.js";

// The shallow pair-or-nil list identity (see CONTRACT CONVENTIONS above) — one shared
// instance so the harvest prints one name and the decode path is one union.
const listAlike = z.union([z.pair, z.nil]);

// reduce — SRFI-1's higher-order list fold, a pure `symbol.tagless` dispatcher: no impl,
// forwards to the receiver's own `arrival/tagless-final/reduce` term (APair/AVector left-fold;
// ANil returns the seed), threading the run ctx. Scheme places the collection LAST —
// `(reduce f ridentity xs)` — so the dispatcher's last-arg-is-receiver convention lands the
// list/vector/nil as the receiver and passes [f, ridentity] through. The element-first fold
// convention (`fn(element, acc)`, NOT the FL acc-first) lives ON the terms.
//
// find — SRFI-1 first-match search: a JS `symbol.native` (not a scheme `symbol.define` like
// `find-tail`) because it recurses over the predicate and unwraps an async generator-lambda
// result. Procedure-only matcher (no host RegExp).
//
// Precision-typed to match its own Contract (below): `arg` is the callable-schema convention
// (z.custom<(...args)=>T>(), matching filter/vector-map/vector-for-each). `list`'s car/cdr
// decode `unknown` off `z.pair`'s default `APair<unknown, unknown>` generic (the SAME shared
// identity primitive lists.ts's list ops use) — every recursive/return site that hands a car/cdr
// back through this SchemeValue-returning fn casts it. findImpl carries no runtime pair-or-nil
// check of its own (an earlier revision's `typecheck(...)` guards were removed; `symbol.native`
// contracts are TYPE-ONLY and never validated at runtime — see string-split's comment in
// srfi-13.ts), so the cast restates the TS-declared `AListAlike` shape, not a runtime-verified one.
// `runCtx` is a required parameter (not a defaulted CONSTANT_CTX) — a plain recursive
// call (not a dispatch-bound `this: CallCtx`) can't recover the live ctx any other
// way, so it's threaded explicitly through every recursive step (THREADING GAP,
// arrival-constant-ctx-audit-2026-07-11.md §2.4, srfi-1.ts:117). The `find` binding
// below is the thin dispatch-bound wrapper that supplies it from `this.runCtx`.
function findImpl(arg: (...args: unknown[]) => unknown, list: AListAlike, runCtx: RunContext): SchemeValue {
  if (list instanceof ANil) {
    return nil;
  }
  // Seam-routed: `arg` is a callable VALUE now (ANativeProcedure), not a bare fn.
  return maybeThen(applyCallback(arg, [list.car], runCtx), function (value) {
    if (!is_false(value) && !(value instanceof ANil)) {
      return list.car;
    }
    return findImpl(arg, list.cdr as AListAlike, runCtx);
  }) as SchemeValue;
}

export default new EnvCapability("scheme/srfi-1", {
  // See the file header: the complete cross-capability free-name set of the define
  // bodies below, order-matched to base-packs.ts's C3 tail (exceptions, lists).
  deps: [equality, numeric, exceptions, lists],
  symbols: {
    // input is a plain FIXED 2-tuple (pred, seq) — NOT z.tuple([z.value], z.value)'s
    // unbounded rest (filter's impl is strictly binary: `const [pred, seq] = args`, always
    // exactly 2). pred uses the established callable-schema convention (z.custom<(...args)
    // => T>(), matching vector-map/vector-for-each); seq stays z.value — it's dispatched
    // via tf("filter") term-lookup, representation-agnostic. `symbol.sequence`'s impl signature
    // is always `(args: unknown[], runCtx)` regardless of the contract shape (see
    // SequenceImpl in _bake.ts), so this is a declaration-only fix — the impl is unchanged.
    filter:
      symbol.sequence`filter: keep elements matching a pred (or RegExp); term-dispatch, totalic — the term charges its own heap`(
        // Output is `z.value` (the representation-BLIND scheme-value identity), NOT a "proper
        // list" type: `filter` is genuinely polymorphic over the RECEIVER's own representation
        // (list, vector, …) — it dispatches to whatever `arrival/tagless-final/filter` term the
        // `seq` operand implements and returns a value in THAT SAME representation, so there is
        // no single richer scheme-zod collection type honest for every call site.
        // callbackRoles OVERRIDE: filter's contract is shape-identical to map's (fan
        // host, lambda + value in, value out), so extraction's fan default would say
        // element-transformer — but the pred is a SELECTOR: its verdict decides
        // membership (a length-changing verb), the merged selector+decision role
        // this codebase calls `control`.
        { input: [z.lambda, z.value], output: [z.value], provenance: "fan", callbackRoles: ["control"] },
        (args, runCtx) => {
          const [pred, seq] = args;
          const m = resolveMethod(seq, tf("filter"));
          if (m === undefined) {
            throw new TypeError(
              `filter: the ${seq == null ? String(seq) : typeof seq} operand does not support filter (no ${(tf("filter"))}).`,
            );
          }
          // `resolveMethod`'s own return type is `unknown` (it's a bare tagless-final term
          // lookup, possibly async) — the cast states what the `filter` term contract actually
          // guarantees (a scheme value, or a promise of one, in the receiver's own
          // representation), mirroring this file's established "typecheck is not a TS guard;
          // re-state it" idiom (see `findImpl` above).
          return m.call(seq, pred, runCtx) as MaybePromise<SchemeValue>;
        },
      ),
    // The DECLARED acc-chain marker ("fold declares acc chain"): reduce's f is the
    // fold-shaped `accumulator` callback,
    // the source of CHAINED track composition (`egress(Tᵢ) → ingress(Tᵢ₊₁)`, the only
    // sanctioned inter-track edge — the track-separation law's one exception). A tagless
    // def is contract-less (shapeless `z.array(z.value)` in), so declaration is the ONLY
    // channel — `withCallbackRoles`, not a Contract field.
    reduce: withCallbackRoles(
      symbol.tagless`reduce: left fold in scheme convention fn(element, acc); ridentity if empty`,
      ["accumulator"],
    ),
    // fold — SRFI-1's bare LEFT fold is deliberately NOT bound under this name: `reduce`
    // (above) IS the left fold here, same fn(element, acc) convention with an explicit
    // seed, and `fold-right` (symbol.define below) covers the right-associative shape. A
    // teaching door beside its family (errors-as-doors), not a silent absence — formerly
    // the one "famous-but-absent" row of the dissolved polyglot-rich-errors registry,
    // now DECLARED capability data resolving through the ordinary chain (which also
    // makes it typo-suggestible for free — see src/unbound-variable.ts).
    fold: symbol.notImplemented`fold: SRFI-1's bare fold is not bound under this name — use reduce (left fold, fn(element, acc) convention, explicit seed) or fold-right (right-associative); both are bound here`,
    find: symbol.native`find: first list element matching the predicate, else nil`(
      {
        input: [z.lambda, z.union([z.pair, z.nil])],
        output: [z.value],
        // The z.custom predicate arg is unrepresentable to the harvest printer, collapsing the WHOLE
        // signature to the degrade path `(...args: unknown[]) => unknown`. Author-assert the real
        // shape (checkable by eye against findImpl): the receiver is `List<unknown>` — findImpl is
        // list-only (its `list` parameter is typed `AListAlike`, i.e. pair-or-nil), NOT
        // representation-agnostic like filter/sort — the predicate is a one-arg callable, and the
        // result is the matched car or nil (any value).
        type: "(pred: (x: unknown) => unknown, list: List<unknown>) => unknown",
        // callbackRoles DECLARED: the host is a pipe (not fan) with value egress, so
        // shape underdetermines the pred's role. It is `control` — a boolean-returning
        // selector deciding WHICH element egresses (the merged selector+decision role).
        callbackRoles: ["control"],
      },
      // Thin dispatch-bound wrapper: supplies the recursive findImpl with the live
      // `this.runCtx` (findImpl itself recurses via a plain call, so it cannot recover
      // ctx off `this`).
      function (this: CallCtx, arg: (...args: unknown[]) => unknown, list: AListAlike) {
        return findImpl(arg, list, this.runCtx);
      },
    ),

    // ============ SRFI-1 (list library completion) ============

    // take-while / drop-while — tagless-final dispatchers, NOT scheme-spine bodies: the
    // old `(and (pair? xs) …)` named-let was #f on a vector (`pair?` never holds), so a
    // tool-result vector silently answered '() instead of raising — a real production
    // bug, not a hypothetical one. Receiver-LAST, exactly like `reduce` above (scheme
    // surface is `(take-while pred xs)`; symbol.tagless's convention takes the LAST
    // scheme arg as receiver, so `xs` lands there and `pred` passes through leading).
    // The term (`arrival/tagless-final/take-while` — AValue.ts) OWNS the algebra: list
    // AND vector both answer (list→fresh list; vector→fresh vector, same-kind), and a
    // receiver declaring NEITHER hits `symbol.tagless`'s own TaglessProtocolError door —
    // loud, not the old silent '(). pred's role is "control": a selector deciding
    // prefix membership, the same override reasoning as `filter`'s callbackRoles above.
    "take-while": withCallbackRoles(
      symbol.tagless`take-while: longest prefix of xs satisfying pred, in xs's own representation (list→fresh list, vector→fresh vector)`,
      ["control"],
    ),
    // drop-while — the take-while remainder, same receiver-last/term-owns-algebra/loud-
    // crash reasoning as take-while directly above (see that comment).
    "drop-while": withCallbackRoles(
      symbol.tagless`drop-while: xs with the take-while prefix removed, in xs's own representation (list: a shared tail of xs)`,
      ["control"],
    ),

    // take / drop — tagless-final dispatchers via symbol.sequence, NOT symbol.tagless:
    // scheme surface is `(take xs n)` — xs is FIRST, not last, so symbol.tagless's
    // last-arg-is-receiver convention cannot serve here. Mirrors this file's own
    // `filter` above / lists.ts's `map` instead: `resolveMethod`/`tf` term-lookup IS
    // the type gate, and a receiver declaring no `arrival/tagless-final/take|drop`
    // term crashes loudly (TypeError) rather than the old silent '() on a non-pair
    // (the same production bug take-while/drop-while had — `pair?` is #f on a vector).
    // The receiver slot stays `z.value` (filter/map's representation-agnostic idiom):
    // the result is in the RECEIVER'S OWN representation (list or vector), so no
    // richer scheme-zod collection type is honest for every call site. `n` normalizes
    // via `.valueOf()`, the vectors.ts `vector-ref` idiom.
    //
    // DELIBERATE BEHAVIOR CHANGE from the old scheme body: SRFI-1's "lis may be any
    // value once n hits 0" tolerance is GONE — `(take 5 0)` now crashes (does not
    // support take) instead of silently answering `'()`. Strict types over silent
    // tolerance: a silent '() on a non-list receiver was the disease this migration
    // cures, not a feature to preserve.
    take: symbol.sequence`take: the first n elements of xs, in xs's own representation (list→fresh list, dotted tails tolerated per SRFI-1; vector→fresh vector)`(
      { input: [z.value, z.schemeNumber], output: [z.value] },
      (args, runCtx) => {
        const [xs, n] = args;
        const m = resolveMethod(xs, tf("take"));
        if (m === undefined) {
          throw new TypeError(
            `take: the ${xs == null ? String(xs) : typeof xs} operand does not support take (no ${tf("take")}).`,
          );
        }
        const k = typeof n === "number" ? n : (n as { valueOf(): number }).valueOf();
        return m.call(xs, k, runCtx) as MaybePromise<SchemeValue>;
      },
    ),

    // drop — the take remainder; same dispatcher/loud-crash/behavior-change reasoning
    // as take directly above (see that comment). Output stays z.value (not listAlike):
    // list drop returns the n-th cdr of xs ITSELF (shares structure), vector drop
    // returns a fresh vector — both are the receiver's own representation, never a
    // guaranteed pair-or-nil shape.
    drop: symbol.sequence`drop: xs after the first n elements, in xs's own representation (list: the n-th cdr — shares structure with xs; vector→fresh vector)`(
      { input: [z.value, z.schemeNumber], output: [z.value] },
      (args, runCtx) => {
        const [xs, n] = args;
        const m = resolveMethod(xs, tf("drop"));
        if (m === undefined) {
          throw new TypeError(
            `drop: the ${xs == null ? String(xs) : typeof xs} operand does not support drop (no ${tf("drop")}).`,
          );
        }
        const k = typeof n === "number" ? n : (n as { valueOf(): number }).valueOf();
        return m.call(xs, k, runCtx) as MaybePromise<SchemeValue>;
      },
    ),

    span: symbol.define`span: (list (take-while pred xs) (drop-while pred xs)) in one pass`(
      { input: [z.lambda, listAlike], output: [listAlike] },
      `(lambda (pred xs)
         (let loop ((xs xs) (acc '()))
           (if (and (pair? xs) (pred (car xs)))
               (loop (cdr xs) (cons (car xs) acc))
               (list (reverse acc) xs))))`,
    ),

    break: symbol.define`break: span on the negation of pred — (list prefix-failing-pred rest)`(
      { input: [z.lambda, listAlike], output: [listAlike] },
      `(lambda (pred xs)
         (let loop ((xs xs) (acc '()))
           (if (and (pair? xs) (not (pred (car xs))))
               (loop (cdr xs) (cons (car xs) acc))
               (list (reverse acc) xs))))`,
    ),

    partition: symbol.define`partition: (list yes no) splitting xs by pred, order-preserving`(
      { input: [z.lambda, listAlike], output: [listAlike] },
      `(lambda (pred xs)
         (let loop ((xs xs) (yes '()) (no '()))
           (cond ((null? xs) (list (reverse yes) (reverse no)))
                 ((pred (car xs)) (loop (cdr xs) (cons (car xs) yes) no))
                 (else (loop (cdr xs) yes (cons (car xs) no))))))`,
    ),

    "find-tail": symbol.define`find-tail: first tail of xs whose car satisfies pred, else #f`(
      { input: [z.lambda, listAlike], output: [z.union([z.pair, z.booleanFalse])] },
      `(lambda (pred xs)
         (let loop ((xs xs))
           (cond ((null? xs) #f)
                 ((pred (car xs)) xs)
                 (else (loop (cdr xs))))))`,
    ),

    // z.pair input (SRFI-1: non-empty list required) — `(last-pair '())` is an
    // out-of-domain call that fails at the contract boundary with a clear
    // message, never mid-body.
    "last-pair": symbol.define`last-pair: the last pair of a non-empty (possibly dotted) list`(
      { input: [z.pair], output: [z.pair] },
      `(lambda (xs)
         (let loop ((xs xs))
           (if (pair? (cdr xs)) (loop (cdr xs)) xs)))`,
    ),

    last: symbol.define`last: the last element of a non-empty proper list`(
      { input: [z.pair], output: [z.value] },
      `(lambda (xs) (car (last-pair xs)))`,
    ),

    // %list-nth — private walker behind first…tenth: walks k cdrs, reports the
    // accessor's name on underflow. xs is z.value (its not-a-pair→error branch IS the
    // teaching surface first…tenth rely on). Named-let idiom (see the file header's
    // PERF PROTOCOL note); enforcement stays on.
    "%list-nth": symbol.define`%list-nth: the k-th element of xs, or (error msg) when xs is too short (private walker for first…tenth)`(
      { input: [z.value, z.schemeNumber, z.string], output: [z.value] },
      `(lambda (xs k msg)
         (let loop ((xs xs) (k k))
           (cond ((not (pair? xs)) (error msg))
                 ((= k 0) (car xs))
                 (else (loop (cdr xs) (- k 1))))))`,
    ),

    // first … tenth — SRFI-1 positional accessors: the nth element of a proper list.
    // A list too short for the requested position is an error (mirroring srfi-189's
    // `(error …)` style in this pack). The element is returned AS-IS — accessors don't
    // stamp provenance (cf. `find`, which returns its match unchanged). Input is
    // listAlike (not z.pair): '() must REACH %list-nth so the teaching message
    // ("first: list has no elements") stays the error surface, not a zod boundary.
    first: symbol.define`first: the 1st element of a proper list (errors if too short)`(
      { input: [listAlike], output: [z.value] },
      `(lambda (xs) (%list-nth xs 0 "first: list has no elements"))`,
    ),
    second: symbol.define`second: the 2nd element of a proper list (errors if too short)`(
      { input: [listAlike], output: [z.value] },
      `(lambda (xs) (%list-nth xs 1 "second: list has fewer than 2 elements"))`,
    ),
    third: symbol.define`third: the 3rd element of a proper list (errors if too short)`(
      { input: [listAlike], output: [z.value] },
      `(lambda (xs) (%list-nth xs 2 "third: list has fewer than 3 elements"))`,
    ),
    fourth: symbol.define`fourth: the 4th element of a proper list (errors if too short)`(
      { input: [listAlike], output: [z.value] },
      `(lambda (xs) (%list-nth xs 3 "fourth: list has fewer than 4 elements"))`,
    ),
    fifth: symbol.define`fifth: the 5th element of a proper list (errors if too short)`(
      { input: [listAlike], output: [z.value] },
      `(lambda (xs) (%list-nth xs 4 "fifth: list has fewer than 5 elements"))`,
    ),
    sixth: symbol.define`sixth: the 6th element of a proper list (errors if too short)`(
      { input: [listAlike], output: [z.value] },
      `(lambda (xs) (%list-nth xs 5 "sixth: list has fewer than 6 elements"))`,
    ),
    seventh: symbol.define`seventh: the 7th element of a proper list (errors if too short)`(
      { input: [listAlike], output: [z.value] },
      `(lambda (xs) (%list-nth xs 6 "seventh: list has fewer than 7 elements"))`,
    ),
    eighth: symbol.define`eighth: the 8th element of a proper list (errors if too short)`(
      { input: [listAlike], output: [z.value] },
      `(lambda (xs) (%list-nth xs 7 "eighth: list has fewer than 8 elements"))`,
    ),
    ninth: symbol.define`ninth: the 9th element of a proper list (errors if too short)`(
      { input: [listAlike], output: [z.value] },
      `(lambda (xs) (%list-nth xs 8 "ninth: list has fewer than 9 elements"))`,
    ),
    tenth: symbol.define`tenth: the 10th element of a proper list (errors if too short)`(
      { input: [listAlike], output: [z.value] },
      `(lambda (xs) (%list-nth xs 9 "tenth: list has fewer than 10 elements"))`,
    ),

    "list-tabulate": symbol.define`list-tabulate: (list (f 0) (f 1) … (f (- n 1)))`(
      { input: [z.schemeNumber, z.lambda], output: [listAlike] },
      `(lambda (n f)
         (let loop ((i (- n 1)) (acc '()))
           (if (< i 0) acc (loop (- i 1) (cons (f i) acc)))))`,
    ),

    "fold-right": symbol.define`fold-right: right-associative fold — (f x0 (f x1 … (f xn knil)))`(
      { input: [z.lambda, z.value, listAlike], output: [z.value] },
      `(lambda (f knil xs)
         (let loop ((xs xs))
           (if (null? xs) knil (f (car xs) (loop (cdr xs))))))`,
    ),

    "reduce-right": symbol.define`reduce-right: fold-right with the last element as the seed; ridentity if empty`(
      { input: [z.lambda, z.value, listAlike], output: [z.value] },
      `(lambda (f ridentity xs)
         (if (null? xs)
             ridentity
             (let loop ((xs xs))
               (if (null? (cdr xs))
                   (car xs)
                   (f (car xs) (loop (cdr xs)))))))`,
    ),

    // Output z.value: append's R7RS contract lets the LAST list be improper (the
    // result then embeds that tail) — the shallow input union can't rule it out.
    concatenate: symbol.define`concatenate: append a list of lists into one list`(
      { input: [listAlike], output: [z.value] },
      `(lambda (lists) (apply append lists))`,
    ),

    // Output z.value: the result is (reverse rev) grafted onto the caller's tail —
    // tail-typed, and SRFI-1 allows any tail object.
    "append-reverse": symbol.define`append-reverse: (append (reverse rev) tail), accumulator-friendly`(
      { input: [listAlike, z.value], output: [z.value] },
      `(lambda (rev tail)
         (let loop ((rev rev) (tail tail))
           (if (null? rev) tail (loop (cdr rev) (cons (car rev) tail)))))`,
    ),

    delete: symbol.define`delete: remove all elements equal? to x from xs, as a fresh list`(
      { input: [z.value, listAlike], output: [listAlike] },
      `(lambda (x xs)
         (let loop ((xs xs) (acc '()))
           (cond ((null? xs) (reverse acc))
                 ((equal? x (car xs)) (loop (cdr xs) acc))
                 (else (loop (cdr xs) (cons (car xs) acc))))))`,
    ),

    // remove — SRFI-1: keep the elements that do NOT satisfy pred (the predicate twin of
    // delete). The base sandbox carries no external collection library, so this is the sole
    // remove binding; the inference plane copies it by name (bridge.ts). Contract mirrors
    // `filter`'s representation-BLIND shape (z.value seq/out), NOT listAlike: the body
    // delegates to filter's term dispatch, so remove inherits filter's polymorphism over
    // the receiver's own representation — narrowing here would break what delegation buys.
    remove: symbol.define`remove: keep the elements NOT satisfying pred (predicate twin of delete; delegates to filter's term dispatch)`(
      { input: [z.lambda, z.value], output: [z.value] },
      `(lambda (pred xs)
         (filter (lambda (x) (not (pred x))) xs))`,
    ),

    // first? / first-or — safe list-head accessors: the head, or a falsy / default sentinel
    // on empty.
    //
    // NOT redundant with loose `car`, though both dodge the (car '()) crash: loose car on an
    // empty list projects to nil — an ANil OBJECT, which is Scheme-TRUTHY — so a guard like
    // (let ((p (car xs))) (if p …)) takes the present-branch on empty and then crashes on the
    // field access. first? returns #f (FALSY), so the same guard correctly skips. That falsy-
    // on-empty contract is the load-bearing semantics, and car cannot supply it — these are
    // the safe twins of SRFI-1 `first`, not crash-avoidance vestiges. (first-or is the
    // defaulted twin; it earns the same one-line home rather than a wrong (or (car xs) default)
    // derivation, which would mask a genuinely-falsy first element.) xs is z.value — TOTAL
    // tolerance (any non-pair → the sentinel) is the whole point, so it is the contract.
    "first?": symbol.define`first?: the head of xs, or #f (falsy!) when xs is not a pair — the safe guard twin of first`(
      { input: [z.value], output: [z.value] },
      `(lambda (xs) (if (pair? xs) (car xs) #f))`,
    ),
    "first-or": symbol.define`first-or: the head of xs, or default when xs is not a pair — the defaulted twin of first?`(
      { input: [z.value, z.value], output: [z.value] },
      `(lambda (xs default) (if (pair? xs) (car xs) default))`,
    ),

    // The shallow listAlike input is LOAD-BEARING here: z.list's spine-walking decode
    // would throw on exactly the circular lists this verb exists to answer.
    "length+": symbol.define`length+: list length, or #f for a circular list (Floyd cycle detection)`(
      { input: [listAlike], output: [z.union([z.exact, z.booleanFalse])] },
      `(lambda (xs)
         (let loop ((slow xs) (fast xs) (n 0))
           (cond ((null? fast) n)
                 ((not (pair? fast)) n)
                 ((null? (cdr fast)) (+ n 1))
                 ((not (pair? (cdr fast))) (+ n 1))
                 (else
                   (let ((slow2 (cdr slow)) (fast2 (cdr (cdr fast))))
                     (if (eq? slow2 fast2) #f (loop slow2 fast2 (+ n 2))))))))`,
    ),

    // ============ SRFI-1 (the missing third + parallel-list utilities) ============
    // Relocated here from the legacy core bootstrap so the whole SRFI-1 surface is
    // observable in one module. These retire the hand-rolled dedupe/member?/index-map
    // helpers that were reinvented across the pipeline.

    // (iota count [start step]) — start/step genuinely optional ⇒ inputRest. Elements
    // are (+ start (* i step)) — inexact whenever start/step are ⇒ the honest element
    // is a number, but the LIST shape is guaranteed fresh-proper.
    iota: symbol.define`iota: (iota count [start step]) — a list of count numbers from start by step`(
      { input: [z.schemeNumber], inputRest: z.schemeNumber, output: [listAlike] },
      `(lambda (count . rest)
         (let ((start (if (null? rest) 0 (car rest)))
               (step (if (or (null? rest) (null? (cdr rest))) 1 (cadr rest))))
           (let loop ((i 0) (acc '()))
             (if (>= i count) (reverse acc)
                 (loop (+ i 1) (cons (+ start (* i step)) acc))))))`,
    ),

    // range — arrival's [0, stop) integer list: exactly (iota stop). The single-arg form
    // is the only one used in practice (every spec site calls (range n)).
    range: symbol.define`range: arrival's [0, stop) integer list — exactly (iota stop)`(
      { input: [z.schemeNumber], output: [listAlike] },
      `(lambda (stop) (iota stop))`,
    ),

    "delete-duplicates": symbol.define`delete-duplicates: order-preserving dedup by equal? (retires the hand-rolled O(n²) dedupe)`(
      { input: [listAlike], output: [listAlike] },
      `(lambda (xs)
         (let loop ((xs xs) (seen '()) (acc '()))
           (if (null? xs) (reverse acc)
               (if (member (car xs) seen)
                   (loop (cdr xs) seen acc)
                   (loop (cdr xs) (cons (car xs) seen) (cons (car xs) acc))))))`,
    ),

    "filter-map": symbol.define`filter-map: map then drop the falsy results, in one pass the model can't mismatch`(
      { input: [z.lambda], inputRest: listAlike, output: [listAlike] },
      `(lambda (fn . lists)
         (filter (lambda (x) x) (apply map fn lists)))`,
    ),

    // Output z.schemeNumber, not z.exact: the value IS `length`'s return, and length's
    // own declared output is z.schemeNumber — match the verb we delegate to.
    count: symbol.define`count: how many element-tuples across the parallel lists satisfy pred`(
      { input: [z.lambda], inputRest: listAlike, output: [z.schemeNumber] },
      `(lambda (pred . lists)
         (length (filter (lambda (b) b) (apply map pred lists))))`,
    ),

    // Output z.value, as concatenate: the appended results may embed an improper tail.
    "append-map": symbol.define`append-map: map then append the result lists`(
      { input: [z.lambda], inputRest: listAlike, output: [z.value] },
      `(lambda (fn . lists)
         (apply append (apply map fn lists)))`,
    ),

    // some / every — existence and universal quantifiers over parallel lists. (some is
    // SRFI-1's `any`, kept under the Ramda-familiar name; both return #t/#f, arrival's
    // historical deviation from SRFI's last-pred-value, preserved 1:1.) %any-null?/
    // %some/%every are private helpers; some must precede zip and list-index, which
    // call it (forward references across defines in the same capability are legal —
    // checked eagerly, not by textual order). Bodies use the #t/#f LITERALS
    // directly, not core's `true`/`false` constant names — referencing those names
    // would add a `deps: [core]` edge on the C3 precedence FLOOR (core leads
    // BASE_PACKS; a tail-block repositioning of core is semantically absurd).
    // Named-let idiom on all three % helpers (see the file header's PERF
    // PROTOCOL note); enforcement stays on.
    "%any-null?": symbol.define`%any-null?: #t iff any of the parallel lists is exhausted (private helper for %some/%every)`(
      { input: [listAlike], output: [z.boolean] },
      `(lambda (lst)
         (let loop ((lst lst))
           (if (null? lst)
               #f
               (if (null? (car lst))
                   #t
                   (loop (cdr lst))))))`,
    ),

    "%some": symbol.define`%some: #t iff fn holds for some element-tuple of the parallel lists (private helper for some)`(
      { input: [z.lambda, listAlike], output: [z.boolean] },
      `(lambda (fn lists)
         (let loop ((lists lists))
           (if (or (null? lists) (%any-null? lists))
               #f
               (if (apply fn (map car lists))
                   #t
                   (loop (map cdr lists))))))`,
    ),

    some: symbol.define`some: #t iff pred holds for some element-tuple across the parallel lists (SRFI-1 any, Ramda-familiar name, #t/#f result)`(
      { input: [z.lambda], inputRest: listAlike, output: [z.boolean] },
      `(lambda (fn . lists)
         (%some fn lists))`,
    ),

    "%every": symbol.define`%every: #t iff fn holds for every element-tuple of the parallel lists (private helper for every)`(
      { input: [z.lambda, listAlike], output: [z.boolean] },
      `(lambda (fn lists)
         (let loop ((lists lists))
           (if (or (null? lists) (%any-null? lists))
               #t
               (if (apply fn (map car lists))
                   (loop (map cdr lists))
                   #f))))`,
    ),

    every: symbol.define`every: #t iff pred holds for every element-tuple across the parallel lists (#t/#f result; vacuously #t on empty)`(
      { input: [z.lambda], inputRest: listAlike, output: [z.boolean] },
      `(lambda (fn . lists)
         (%every fn lists))`,
    ),

    // Named-let idiom (see the file header's PERF PROTOCOL note) — a
    // self-recursive body would otherwise re-enter its own wrapper via
    // (apply zip …) per element. The loop's (some null? ls) sibling call still
    // crosses the boundary once per element — negligible against interpretation
    // cost; the validate:false valve stays unused.
    zip: symbol.define`zip: transpose parallel lists into a list of tuples; stops at the shortest`(
      { input: [], inputRest: listAlike, output: [listAlike] },
      `(lambda lists
         (let loop ((ls lists))
           (if (or (null? ls) (some null? ls))
               '()
               (cons (map car ls) (loop (map cdr ls))))))`,
    ),

    "list-index": symbol.define`list-index: index of the first element-tuple satisfying pred, or #f`(
      { input: [z.lambda], inputRest: listAlike, output: [z.union([z.exact, z.booleanFalse])] },
      `(lambda (pred . lists)
         (let loop ((i 0) (ls lists))
           (if (some null? ls) #f
               (if (apply pred (map car ls)) i
                   (loop (+ i 1) (map cdr ls))))))`,
    ),

    // NOT SRFI-1's four-procedure unfold — arrival's historical shape (fn returns
    // (head . next) or #f to stop), preserved 1:1.
    unfold: symbol.define`unfold: build a list by iterating fn from init; fn returns (head . next) or #f to stop`(
      { input: [z.lambda, z.value], output: [listAlike] },
      `(lambda (fn init)
         (let iter ((pair (fn init)) (result '()))
           (if (not pair)
               (reverse result)
               (iter (fn (cdr pair)) (cons (car pair) result)))))`,
    ),
  },
});
