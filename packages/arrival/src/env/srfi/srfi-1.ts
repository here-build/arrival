// SRFI-1 — list library completion. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles `SRFI1_SCM` and
// evals it (via initBridge's assembleEnv), so this module is the sole definition site.
//
// SCOPE: the whole SRFI-1 surface lives here — the *completion* set (take-while …
// length+), `remove` (relocated from arrival-extensions, beside its `delete` twin),
// and the "missing third" + parallel-list utilities (iota, range — iota's [0,stop)
// wrapper, delete-duplicates, filter-map, count, append-map, some/every, zip,
// list-index, unfold) plus the safe list-head accessors first?/first-or — relocated
// here from the dissolved arrival-extensions pack as the falsy/default-on-empty twins of
// SRFI-1 `first`, a contract loose `car` cannot supply (it projects to truthy nil).
import { type MaybePromise, resolveMethod, symbol } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import { is_false } from "../../eval/guards.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import type { APair } from "../../values/primitives/APair.js";
import { maybeThen } from "../../utils/promises.js";
import { applyCallback } from "../../values/primitives/ACallable.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import * as z from "../../common/scheme-zod.js";
import { tf } from "../../values/tagless-final.js";
import type { AList, AListAlike, SchemeValue } from "../../values/types.js";

// reduce — SRFI-1's higher-order list fold, a pure `symbol.tagless` dispatcher: no impl,
// forwards to the receiver's own `arrival/tagless-final/reduce` term (APair/AVector left-fold;
// ANil returns the seed), threading the run ctx. Scheme places the collection LAST —
// `(reduce f ridentity xs)` — so the dispatcher's last-arg-is-receiver convention lands the
// list/vector/nil as the receiver and passes [f, ridentity] through. The element-first fold
// convention (`fn(element, acc)`, NOT the FL acc-first) lives ON the terms.
//
// find — SRFI-1 first-match search: a JS `symbol.native` (not a scheme prelude define like
// `find-tail`) because it recurses over the predicate and unwraps an async generator-lambda
// result. Procedure-only matcher (no host RegExp).
//
// Precision-typed to match its own Contract (below): `arg` is the callable-schema convention
// (z.custom<(...args)=>T>(), matching filter/vector-map/vector-for-each/curry). `list`'s car/cdr
// decode `unknown` off `z.pair`'s default `APair<unknown, unknown>` generic (the SAME shared
// identity primitive lists.ts's list ops use) — every recursive/return site that hands a car/cdr
// back through this SchemeValue-returning fn casts it, mirroring lists.ts's established
// "typecheck is not a TS guard; re-state it" idiom: `typecheck` above already re-validates
// pair-or-nil on every recursive call, so the cast states a runtime-enforced invariant, not a blind one.
function findImpl(arg: (...args: unknown[]) => unknown, list: AListAlike): SchemeValue {
  if (list instanceof ANil) {
    return nil;
  }
  // Seam-routed: `arg` is a callable VALUE now (ANativeProcedure), not a bare fn.
  return maybeThen(applyCallback(arg, [list.car], CONSTANT_CTX), function (value) {
    if (!is_false(value) && !(value instanceof ANil)) {
      return list.car;
    }
    return findImpl(arg, list.cdr as AListAlike);
  }) as SchemeValue;
}

export default new EnvCapability("scheme/srfi-1", {
  symbols: {
    // input is a plain FIXED 2-tuple (pred, seq) — NOT z.tuple([z.value], z.value)'s
    // unbounded rest (filter's impl is strictly binary: `const [pred, seq] = args`, always
    // exactly 2). pred uses the established callable-schema convention (z.custom<(...args)
    // => T>(), matching vector-map/vector-for-each/curry); seq stays z.value — it's dispatched
    // via tf("filter") term-lookup, representation-agnostic. `symbol.sequence`'s impl signature
    // is always `(args: unknown[], runCtx)` regardless of the contract shape (see
    // SequenceInput in _bake.ts), so this is a declaration-only fix — the impl is unchanged.
    filter:
      symbol.sequence`filter: keep elements matching a pred (or RegExp); term-dispatch, totalic — the term charges its own heap`(
        // Output is `z.value` (the representation-BLIND scheme-value identity), NOT a "proper
        // list" type: `filter` is genuinely polymorphic over the RECEIVER's own representation
        // (list, vector, …) — it dispatches to whatever `arrival/tagless-final/filter` term the
        // `seq` operand implements and returns a value in THAT SAME representation, so there is
        // no single richer scheme-zod collection type honest for every call site.
        { input: [z.lambda, z.value], output: [z.value], fanout: true },
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
    reduce: symbol.tagless`reduce: left fold in scheme convention fn(element, acc); ridentity if empty`,
    find: symbol.native`find: first list element matching the predicate, else nil`(
      {
        input: [z.lambda, z.union([z.pair, z.nil])],
        output: [z.value],
        // The z.custom predicate arg is unrepresentable to the harvest printer, collapsing the WHOLE
        // signature to the degrade path `(...args: unknown[]) => unknown`. Author-assert the real
        // shape (checkable by eye against findImpl): the receiver is `List<unknown>` — findImpl is
        // list-only (`typecheck(list, ["pair","nil"])`), NOT representation-agnostic like filter/sort —
        // the predicate is a one-arg callable, and the result is the matched car or nil (any value).
        type: "(pred: (x: unknown) => unknown, list: List<unknown>) => unknown",
      },
      findImpl,
    ),
  },
  prelude: `
;; ============ SRFI-1 (list library completion) ============
;; take-while — longest prefix of xs satisfying pred.
(define (take-while pred xs)
  (let loop ((xs xs) (acc '()))
    (if (and (pair? xs) (pred (car xs)))
        (loop (cdr xs) (cons (car xs) acc))
        (reverse acc))))

;; drop-while — xs with the take-while prefix removed.
(define (drop-while pred xs)
  (let loop ((xs xs))
    (if (and (pair? xs) (pred (car xs)))
        (loop (cdr xs))
        xs)))

;; take — the first n elements of xs as a fresh list.
(define (take xs n)
  (if (or (<= n 0) (not (pair? xs)))
      '()
      (cons (car xs) (take (cdr xs) (- n 1)))))

;; drop — the sublist of xs after the first n elements.
(define (drop xs n)
  (if (or (<= n 0) (not (pair? xs)))
      xs
      (drop (cdr xs) (- n 1))))

;; span — (values (take-while pred xs) (drop-while pred xs)).
(define (span pred xs)
  (let loop ((xs xs) (acc '()))
    (if (and (pair? xs) (pred (car xs)))
        (loop (cdr xs) (cons (car xs) acc))
        (values (reverse acc) xs))))

;; break — span on the negation of pred.
(define (break pred xs)
  (let loop ((xs xs) (acc '()))
    (if (and (pair? xs) (not (pred (car xs))))
        (loop (cdr xs) (cons (car xs) acc))
        (values (reverse acc) xs))))

;; partition — (values yes no) splitting xs by pred.
(define (partition pred xs)
  (let loop ((xs xs) (yes '()) (no '()))
    (cond ((null? xs) (values (reverse yes) (reverse no)))
          ((pred (car xs)) (loop (cdr xs) (cons (car xs) yes) no))
          (else (loop (cdr xs) yes (cons (car xs) no))))))

;; find-tail — first tail of xs whose car satisfies pred, else #f.
(define (find-tail pred xs)
  (let loop ((xs xs))
    (cond ((null? xs) #f)
          ((pred (car xs)) xs)
          (else (loop (cdr xs))))))

;; last-pair — the last pair of a non-empty list.
(define (last-pair xs)
  (let loop ((xs xs))
    (if (pair? (cdr xs)) (loop (cdr xs)) xs)))

;; last — the last element of a non-empty list.
(define (last xs) (car (last-pair xs)))

;; first … tenth — SRFI-1 positional accessors: the nth element of a proper list.
;; A list too short for the requested position is an error (mirroring srfi-189's
;; \`(error …)\` style in this pack). The element is returned AS-IS — accessors don't
;; stamp provenance (cf. \`find\`, which returns its match unchanged). \`%list-nth\` walks
;; k cdrs and reports the accessor's name on underflow. (\`last\`/\`last-pair\` already
;; live above; only the ordinal head accessors are added.)
(define (%list-nth xs k msg)
  (cond ((not (pair? xs)) (error msg))
        ((= k 0) (car xs))
        (else (%list-nth (cdr xs) (- k 1) msg))))
(define (first   xs) (%list-nth xs 0 "first: list has no elements"))
(define (second  xs) (%list-nth xs 1 "second: list has fewer than 2 elements"))
(define (third   xs) (%list-nth xs 2 "third: list has fewer than 3 elements"))
(define (fourth  xs) (%list-nth xs 3 "fourth: list has fewer than 4 elements"))
(define (fifth   xs) (%list-nth xs 4 "fifth: list has fewer than 5 elements"))
(define (sixth   xs) (%list-nth xs 5 "sixth: list has fewer than 6 elements"))
(define (seventh xs) (%list-nth xs 6 "seventh: list has fewer than 7 elements"))
(define (eighth  xs) (%list-nth xs 7 "eighth: list has fewer than 8 elements"))
(define (ninth   xs) (%list-nth xs 8 "ninth: list has fewer than 9 elements"))
(define (tenth   xs) (%list-nth xs 9 "tenth: list has fewer than 10 elements"))

;; list-tabulate — (list (f 0) (f 1) ... (f (- n 1))).
(define (list-tabulate n f)
  (let loop ((i (- n 1)) (acc '()))
    (if (< i 0) acc (loop (- i 1) (cons (f i) acc)))))

;; fold-right — right-associative fold: (f x0 (f x1 ... (f xn knil))).
(define (fold-right f knil xs)
  (let loop ((xs xs))
    (if (null? xs) knil (f (car xs) (loop (cdr xs))))))

;; reduce-right — fold-right with the last element as the seed; ridentity if empty.
(define (reduce-right f ridentity xs)
  (if (null? xs)
      ridentity
      (let loop ((xs xs))
        (if (null? (cdr xs))
            (car xs)
            (f (car xs) (loop (cdr xs)))))))

;; concatenate — append a list of lists.
(define (concatenate lists) (apply append lists))

;; append-reverse — (append (reverse rev) tail), accumulator-friendly.
(define (append-reverse rev tail)
  (let loop ((rev rev) (tail tail))
    (if (null? rev) tail (loop (cdr rev) (cons (car rev) tail)))))

;; delete — remove all elements equal? to x from xs.
(define (delete x xs)
  (let loop ((xs xs) (acc '()))
    (cond ((null? xs) (reverse acc))
          ((equal? x (car xs)) (loop (cdr xs) acc))
          (else (loop (cdr xs) (cons (car xs) acc))))))

;; remove — SRFI-1: keep the elements that do NOT satisfy pred (the predicate twin of
;; delete). The base sandbox carries no external collection library, so this is the sole
;; remove binding; the inference plane copies it by name (bridge.ts).
(define (remove pred xs)
  (filter (lambda (x) (not (pred x))) xs))

;; first? / first-or — safe list-head accessors: the head, or a falsy / default sentinel
;; on empty.
;;
;; NOT redundant with loose \`car\`, though both dodge the (car '()) crash: loose car on an
;; empty list projects to nil — an ANil OBJECT, which is Scheme-TRUTHY — so a guard like
;; (let ((p (car xs))) (if p …)) takes the present-branch on empty and then crashes on the
;; field access. first? returns #f (FALSY), so the same guard correctly skips. That falsy-
;; on-empty contract is the load-bearing semantics, and car cannot supply it — these are
;; the safe twins of SRFI-1 \`first\`, not crash-avoidance vestiges. (first-or is the
;; defaulted twin; it earns the same one-line home rather than a wrong (or (car xs) default)
;; derivation, which would mask a genuinely-falsy first element.)
(define (first? xs) (if (pair? xs) (car xs) #f))
(define (first-or xs default) (if (pair? xs) (car xs) default))

;; length+ — list length, or #f for a circular list (Floyd cycle detection).
(define (length+ xs)
  (let loop ((slow xs) (fast xs) (n 0))
    (cond ((null? fast) n)
          ((not (pair? fast)) n)
          ((null? (cdr fast)) (+ n 1))
          ((not (pair? (cdr fast))) (+ n 1))
          (else
            (let ((slow2 (cdr slow)) (fast2 (cdr (cdr fast))))
              (if (eq? slow2 fast2) #f (loop slow2 fast2 (+ n 2))))))))

;; ============ SRFI-1 (the missing third + parallel-list utilities) ============
;; Relocated here from the legacy core bootstrap so the whole SRFI-1 surface is observable in
;; one module. These retire the hand-rolled dedupe/member?/index-map helpers that
;; were reinvented across the pipeline.

;; iota — (iota count [start step]); a list of count integers from start by step.
(define (iota count . rest)
  (let ((start (if (null? rest) 0 (car rest)))
        (step (if (or (null? rest) (null? (cdr rest))) 1 (cadr rest))))
    (let loop ((i 0) (acc '()))
      (if (>= i count) (reverse acc)
          (loop (+ i 1) (cons (+ start (* i step)) acc))))))

;; range — arrival's [0, stop) integer list: exactly (iota stop). The single-arg form is
;; the only one used in practice (every spec site calls (range n)).
(define (range stop) (iota stop))

;; delete-duplicates — order-preserving dedup by equal?. Retires the O(n²) hand-rolled
;; dedupe reinvented across the pipeline.
(define (delete-duplicates xs)
  (let loop ((xs xs) (seen '()) (acc '()))
    (if (null? xs) (reverse acc)
        (if (member (car xs) seen)
            (loop (cdr xs) seen acc)
            (loop (cdr xs) (cons (car xs) seen) (cons (car xs) acc))))))

;; filter-map — map then drop the falsy results, in one pass the model can't mismatch.
(define (filter-map fn . lists)
  (filter (lambda (x) x) (apply map fn lists)))

;; count — how many element-tuples satisfy pred.
(define (count pred . lists)
  (length (filter (lambda (b) b) (apply map pred lists))))

;; append-map — map then append the result lists.
(define (append-map fn . lists)
  (apply append (apply map fn lists)))

;; some / every — existence and universal quantifiers over parallel lists. (some is
;; SRFI-1's \`any\`, kept under the Ramda-familiar name.) %any-null?/%some/%every are
;; private helpers; some must precede zip and list-index, which call it.
(define (%any-null? lst)
  (if (null? lst)
      false
      (if (null? (car lst))
          true
          (%any-null? (cdr lst)))))

(define (%some fn lists)
  (if (or (null? lists) (%any-null? lists))
      false
      (if (apply fn (map car lists))
          true
          (%some fn (map cdr lists)))))

(define (some fn . lists)
  (%some fn lists))

(define (%every fn lists)
  (if (or (null? lists) (%any-null? lists))
      true
      (and (apply fn (map car lists)) (%every fn (map cdr lists)))))

(define (every fn . lists)
  (%every fn lists))

;; zip — transpose parallel lists into a list of tuples; stops at the shortest.
(define (zip . lists)
  (if (or (null? lists) (some null? lists))
      '()
      (cons (map car lists) (apply zip (map cdr lists)))))

;; list-index — index of the first element-tuple satisfying pred, or #f.
(define (list-index pred . lists)
  (let loop ((i 0) (ls lists))
    (if (some null? ls) #f
        (if (apply pred (map car ls)) i
            (loop (+ i 1) (map cdr ls))))))

;; unfold — build a list by iterating fn from init; fn returns (head . next) or #f to stop.
(define (unfold fn init)
  (let iter ((pair (fn init)) (result '()))
    (if (not pair)
        (reverse result)
        (iter (fn (cdr pair)) (cons (car pair) result)))))
`,
});
