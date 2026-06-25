// @here.build/arrival/arrival-extensions — arrival core extensions pack.
//
// The non-R7RS, non-SRFI, non-polyglot procedures that arrival adds on top of
// the portable Scheme base. All host-interop or arrival-specific:
//   • symbol/string conversion (symbol->string / string->symbol / %as.data)
//   • unary/binary curry wrappers · tree-map
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
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { typecheck } from "../utils/typecheck.js";
import * as z from "./scheme-zod.js";
import { symbol } from "./symbol.js";
import { AString } from "../values/primitives/AString.js";
import { stringValue, withInputProvenance, toIndex } from "../values/op-helpers.js";
import { AExact } from "../values/numbers.js";
import { APair } from "../values/primitives/APair.js";
import { nil } from "../values/primitives/ANil.js";
import { unpromise } from "../utils/promises.js";
import { is_false } from "../eval/guards.js";

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
    range: symbol.native`range: an exact-integer list [start, stop) by step (1- to 3-arg forms)`(
      { input: z.tuple([z.schemeNumber], z.unknown()), output: [z.union([z.pair, z.nil])] },
      (stopOrStart: unknown, ...rest: unknown[]): APair | typeof nil => {
        let start: number, stop: number, step: number;

        if (rest.length === 0) {
          start = 0;
          stop = toIndex(stopOrStart);
          step = 1;
        } else if (rest.length === 1) {
          start = toIndex(stopOrStart);
          stop = toIndex(rest[0]);
          step = 1;
        } else {
          start = toIndex(stopOrStart);
          stop = toIndex(rest[0]);
          step = toIndex(rest[1]);
        }

        const result: number[] = [];

        if (start < stop && step > 0) {
          for (let i = start; i < stop; i += step) {
            result.push(i);
          }
        } else if (start > stop && step < 0) {
          for (let i = start; i > stop; i += step) {
            result.push(i);
          }
        }

        // Convert array to list
        if (result.length === 0) return nil;
        let list: APair | typeof nil = nil;
        for (let i = result.length - 1; i >= 0; i--) {
          list = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, BigInt(result[i])), list);
        }
        return list;
      },
    ),

    complement: symbol.native`complement: a predicate returning the boolean negation of fn`(
      { input: [z.custom<(...args: unknown[]) => unknown>()], output: [z.custom<(...args: unknown[]) => unknown>()] },
      (fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown => {
        // \`fn\` may be a scheme lambda, which returns a Promise to JS callers
        // (generator-lambda async return) — so unpromise before testing. And its
        // result may be a boxed SchemeBool (a truthy JS object), so negate via
        // is_false, not \`!\` (always false on an object). Both were latent: plain
        // \`!fn(...)\` failed for async predicates AND for boxed-bool ones.
        const result = (...args: unknown[]) => unpromise(fn(...args), is_false);
        Object.defineProperty(result, "name", { value: "complement" });
        return result;
      },
    ),

    always: symbol.native`always: a thunk that always returns constant`(
      { input: [z.unknown()], output: [z.custom<(...args: unknown[]) => unknown>()] },
      (constant: unknown): (...args: unknown[]) => unknown => {
        const result = () => constant;
        Object.defineProperty(result, "name", { value: "always" });
        return result;
      },
    ),

    once: symbol.native`once: a wrapper that runs fn at most once, caching its result`(
      { input: [z.custom<(...args: unknown[]) => unknown>()], output: [z.custom<(...args: unknown[]) => unknown>()] },
      (fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown => {
        let called = false;
        let result: unknown;
        const wrapped = (...args: unknown[]) => {
          if (!called) {
            called = true;
            result = fn(...args);
          }
          return result;
        };
        Object.defineProperty(wrapped, "name", { value: "once" });
        return wrapped;
      },
    ),

    flip: symbol.native`flip: fn with its first two arguments swapped`(
      { input: [z.custom<(...args: unknown[]) => unknown>()], output: [z.custom<(...args: unknown[]) => unknown>()] },
      (fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown => {
        const result = (a: unknown, b: unknown, ...rest: unknown[]) => fn(b, a, ...rest);
        Object.defineProperty(result, "name", { value: "flip" });
        return result;
      },
    ),

    "n-ary": symbol.native`n-ary: fn restricted to its first n arguments`(
      { input: [z.schemeNumber, z.custom<(...args: unknown[]) => unknown>()], output: [z.custom<(...args: unknown[]) => unknown>()] },
      (n: unknown, fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown => {
        const count = toIndex(n);
        const result = (...args: unknown[]) => fn(...args.slice(0, count));
        Object.defineProperty(result, "name", { value: "n-ary" });
        return result;
      },
    ),

    "symbol->string": symbol.native`symbol->string: the symbol's name as a string`(
      { input: [z.symbol], output: [z.schemeString] },
      (s: unknown): AString => {
        typecheck("symbol->string", s, "symbol");
        const name = (s as ASymbol).__name__;
        const str = typeof name === "string" ? name : (name as symbol).toString();
        return withInputProvenance([s], new AString(CONSTANT_CTX, str));
      },
    ),
    "string->symbol": symbol.native`string->symbol: a symbol whose name is the string's characters`(
      { input: [z.schemeString], output: [z.symbol] },
      (s: unknown): ASymbol => {
        typecheck("string->symbol", s, "string");
        return withInputProvenance([s], new ASymbol(CONSTANT_CTX, stringValue(s)));
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
