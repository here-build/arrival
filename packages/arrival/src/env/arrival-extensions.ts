// @here.build/arrival/arrival-extensions — arrival core extensions pack.
//
// The non-R7RS, non-SRFI, non-polyglot procedures that arrival adds on top of
// the portable Scheme base. All host-interop or arrival-specific:
//   • symbol/string conversion (symbol->string / string->symbol / %as.data)
//   • sort (Scheme quicksort) · unary/binary curry wrappers · tree-map
//   • pair utilities (pair-map / nth-pair)
//   • type predicates (regex? / key? / …)
//   • aliases (string-join / string-split) · symbol-append
//   • arrival safe head accessors (first? / first-or) + a standalone SRFI-1 remove
//
// The truly-irreducible core (essential constants, the purity doors, the
// syntax-binding macros, the --> / .. interop macros and their helpers) stays
// inline in core (`core.ts`) because the later packs expand against it at load time.
//
// SINGLE SOURCE: `base-packs.ts` assembles `ARRIVAL_EXTENSIONS_SCM`
// and evals it (via initBridge's assembleEnv), so this module is the sole definition site.
import { EnvCapability } from "./capability.js";
import { SchemeSymbol } from "../values/primitives/SchemeSymbol.js";
import { typecheck } from "../utils/typecheck.js";
import * as z from "./scheme-zod.js";
import { symbol } from "./symbol.js";
import { SchemeString } from "../values/primitives/SchemeString.js";
import { stringValue, withInputProvenance } from "../values/op-helpers.js";

// Native symbols, below the membrane: these touch the SchemeSymbol / RegExp host
// types directly, so they live in TS rather than reaching back across the membrane
// from Scheme (the `.` / `new` / `-->` host-interop the rest of this sweep removes).
// `string->symbol`'s old `%as.data` mark was vestigial — it set a string `data`
// property, but the evaluator's data mark is the `__data__` symbol (evaluator.ts).

export default new EnvCapability("arrival/core-extensions", {
  symbols: {
    // All three are provenance PLUMBING (transforms in a pipe), not edges: they forward
    // their input's provenance via withInputProvenance — never mint. (The prior { fn, type }
    // form was defineRosetta-bound, which minted; that was a legacy accident, not intent —
    // the comment above already called them "native, below the membrane".)
    "symbol->string": symbol.native`symbol->string: the symbol's name as a string`(
      { input: [z.symbol], output: [z.schemeString] },
      (s: unknown): SchemeString => {
        typecheck("symbol->string", s, "symbol");
        const name = (s as SchemeSymbol).__name__;
        const str = typeof name === "string" ? name : (name as symbol).toString();
        return withInputProvenance([s], new SchemeString(str));
      },
    ),
    "string->symbol": symbol.native`string->symbol: a symbol whose name is the string's characters`(
      { input: [z.schemeString], output: [z.symbol] },
      (s: unknown): SchemeSymbol => {
        typecheck("string->symbol", s, "string");
        return withInputProvenance([s], new SchemeSymbol(stringValue(s)));
      },
    ),
    "regex?": symbol.native`regex?: #t iff x is a host regular expression`(
      { input: [z.unknown()], output: [z.boolean] },
      (x: unknown): boolean => withInputProvenance([x], x instanceof RegExp),
    ),
  },
  prelude: `
    ;; symbol->string / string->symbol are native (below the membrane) — see the
    ;; symbols block at the bottom of this module.
    
    ;; -----------------------------------------------------------------------------
    ;; Sorting (recursive, best in Scheme)
    ;; -----------------------------------------------------------------------------
    (define (qsort e predicate)
      (if (or (null? e) (<= (length e) 1))
          e
          (let loop ((left '()) (right '())
                     (pivot (car e)) (rest (cdr e)))
            (if (null? rest)
                (append (append (qsort left predicate) (list pivot)) (qsort right predicate))
                (if (predicate (car rest) pivot)
                    (loop (append left (list (car rest))) right pivot (cdr rest))
                    (loop left (append right (list (car rest))) pivot (cdr rest)))))))
    
    (define (sort list . rest)
      (let ((predicate (if (null? rest) <= (car rest))))
        (typecheck "sort" list "pair")
        (typecheck "sort" predicate "function")
        (qsort list predicate)))
    
    ;; -----------------------------------------------------------------------------
    ;; Higher-order function wrappers using curry
    ;; -----------------------------------------------------------------------------
    (define unary (curry n-ary 1))
    (define binary (curry n-ary 2))
    
    ;; -----------------------------------------------------------------------------
    ;; Tree operations
    ;; -----------------------------------------------------------------------------
    (define (tree-map f tree)
      (if (pair? tree)
          (cons (tree-map f (car tree)) (tree-map f (cdr tree)))
          (f tree)))
    
    ;; -----------------------------------------------------------------------------
    ;; Pair utilities
    ;; -----------------------------------------------------------------------------
    (define (pair-map fn seq-list)
      (let iter ((seq-list seq-list) (result '()))
        (if (null? seq-list)
            result
            (if (and (pair? seq-list) (pair? (cdr seq-list)))
                (let* ((first (car seq-list))
                       (second (cadr seq-list))
                       (value (fn first second)))
                  (if (null? value)
                      (iter (cddr seq-list) result)
                      (iter (cddr seq-list) (cons value result))))))))
    
    (define (nth-pair l k)
      (%nth-pair "nth-pair" l k))
    
    ;; -----------------------------------------------------------------------------
    ;; Type predicates
    ;; -----------------------------------------------------------------------------
    ;; regex? is native (below the membrane) — see the symbols block below.
    
    (define (key? symbol)
      (and (symbol? symbol) (string=? (substring (symbol->string symbol) 0 1) ":")))
    
    (define (key->string symbol)
      (if (key? symbol)
          (substring (symbol->string symbol) 1)))
    
    ;; -----------------------------------------------------------------------------
    ;; Aliases
    ;; -----------------------------------------------------------------------------
    (define string-join join)
    (define string-split split)
    
    ;; -----------------------------------------------------------------------------
    ;; Symbol operations
    ;; -----------------------------------------------------------------------------
    (define (symbol-append . rest)
       (string->symbol (apply string-append (map symbol->string rest))))
    
    ;; -----------------------------------------------------------------------------
    ;; Arrival safe head accessors + SRFI-1 remove (core residents)
    ;; -----------------------------------------------------------------------------
    ;; The dominant avoidable crash in generated Scheme is (car (filter …)) on an empty
    ;; match — (car '()) throws. These give a head accessor that CANNOT crash. The rest
    ;; of the SRFI-1 surface now lives in env/srfi/srfi-1.ts; these stay in core because
    ;; they are arrival-specific (crash-avoidance) or, for remove, were authored here to
    ;; supply the SRFI-1 binding directly.
    ;;
    ;; first? — head of a list, or #f when empty. (first? '()) => #f, never a crash. The
    ;; blessed safe accessor that makes (car (filter …)) unnecessary.
    (define (first? xs) (if (pair? xs) (car xs) #f))
    ;; first-or — head of a list, or a supplied default when empty.
    (define (first-or xs default) (if (pair? xs) (car xs) default))
    
    ;; remove — SRFI-1: keep elements that DON'T satisfy pred. The base sandbox carries no
    ;; external collection library, so this is the sole remove binding (it once existed to
    ;; override a curried Ramda remove that returned null for this call shape; Ramda is now
    ;; gone entirely, leaving this plain SRFI-1 definition).
    (define (remove pred xs)
      (filter (lambda (x) (not (pred x))) xs))
`,
});
