// @here.build/arrival/core — the irreducible scheme core pack.
//
// The base-most scheme defs that every other pack expands against: the essential
// constants, the syntax-binding macros (let-syntax / letrec-syntax / define-syntax),
// and the
// `single` macro helper. Pure scheme, zero external deps — the precedence floor
// of the base stdlib, so every other base pack (polyglot / r7rs / srfi / …)
// depends on it.
//
// SINGLE SOURCE: `base-packs.ts` assembles `CORE_SCM` and
// concatenates it FIRST, so this module is the sole definition site — the same
// pattern the SRFI / r7rs / polyglot packs already follow.

import { EnvCapability } from "../../common/capability.js";
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { gensym, type SymbolName } from "../../reader/values-repr.js";
import type { ASymbol } from "../../values/primitives/ASymbol.js";
import { typecheck } from "../../utils/typecheck.js";

/** The irreducible scheme core pack: constants, syntax-binding macros.
 *  Prelude-only module-singleton capability; the precedence floor every base pack deps. */
export default new EnvCapability("scheme/core", {
  prelude: `
    ;; Essential constants
    (define true #t)
    (define false #f)
    (define NaN +nan.0)
    
    
    ;; -----------------------------------------------------------------------------
    ;; Syntax binding macros
    ;; -----------------------------------------------------------------------------
    (define-macro (let-syntax vars . body)
      \`(let ,vars
         ,@(map (lambda (rule)
                  \`(typecheck "let-syntax" ,(car rule) "syntax"))
                vars)
         ,@body))
    
    (define-macro (letrec-syntax vars . body)
      \`(letrec ,vars
         ,@(map (lambda (rule)
                  \`(typecheck "letrec-syntax" ,(car rule) "syntax"))
                vars)
         ,@body))
    
    (define-macro (define-syntax name expr . rest)
      (let ((expr-name (gensym "expr-name")))
        \`(define ,name
           (let ((,expr-name ,expr))
             (typecheck "define-syntax" ,expr-name "syntax")
             ,expr-name)
           ,@rest)))
    
    ;; -----------------------------------------------------------------------------
    ;; Helper functions for macros
    ;; -----------------------------------------------------------------------------
    (define (single list)
      (and (pair? list) (not (cdr list))))
`,
  // The two host primitives the syntax-binding macros above expand into / depend on,
  // relocated VERBATIM from stdlib.ts global_env (husk dissolution). `define-syntax` /
  // `let-syntax` / `letrec-syntax` emit `(typecheck … "syntax")` and `define-syntax` mints
  // a hygiene name via `(gensym …)`; both resolve at macro-EXPANSION time, so binding them
  // on this precedence-floor pack (assembled first among the base packs) reaches every
  // consumer — including the inference-plane `cut`/`cute` copy in initBridge, which reads
  // `gensym` off the user_env chain post-assembly. Native: the impls are the shared
  // `reader/values-repr` gensym and `utils/typecheck` typecheck, bound raw.
  symbols: {
    // Kernel KEYWORDS — special forms made first-class (symbol.keyword markers). The
    // evaluator resolves a call head through the env and dispatches SPECIAL_FORMS[name]
    // when it resolves to one of these — so `(define => lambda)` aliases the form and
    // lexical shadowing un-specials it (the dual of cxr; see values/Keyword.ts). The
    // genMacroWrapper define/lambda husks in stdlib.ts global_env are deleted in favor
    // of these. TWO reasons a kernel special form becomes a keyword: (1) first-class
    // value-carried dispatch — `(define => lambda)` aliases the form, the dual of cxr; and
    // (2) the HYGIENE engine resolves a renamed template identifier (`if` → `#:if`) by binding
    // the gensym to the original name's ENV VALUE (syntax-rules.ts rename()) — a name-only
    // special form has no env value, so a USER syntax-rules macro expanding to it could not
    // resolve. cond/case/when/unless stay evaluator SPECIAL FORMS (evalCond/… — TCO-correct,
    // unlike the nested-genRun syntax-rules path), now ALSO keywords so all control forms are
    // uniformly first-class and reachable from macro templates. (let* / letrec / and / or
    // follow as the remaining primitives are keyworded.)
    lambda: symbol.keyword`lambda: create an anonymous procedure`,
    define: symbol.keyword`define: bind a name in the current scope`,
    let: symbol.keyword`let: bind locals over a body`,
    if: symbol.keyword`if: conditional — evaluate the consequent or the alternative`,
    begin: symbol.keyword`begin: evaluate a sequence, yield the last`,
    quote: symbol.keyword`quote: the datum, unevaluated`,
    quasiquote: symbol.keyword`quasiquote: a template datum with unquote holes`,
    cond: symbol.keyword`cond: first true test wins; its body (or => application) is the value`,
    case: symbol.keyword`case: dispatch on a key via eqv? datum lists`,
    when: symbol.keyword`when: evaluate the body when the test passes`,
    unless: symbol.keyword`unless: evaluate the body when the test fails`,
    // Contract mirrors gensym's real signature so the raw function binds cast-free:
    // the optional name hint is a raw symbol NAME (string/symbol/number), an ASymbol
    // wrapper, or null — NOT a boxed SchemeValue (gensym predates the union and threads
    // raw names). Output is the freshly-minted ASymbol.
    gensym: symbol.native`gensym: a fresh uninterned symbol (optional name hint)`(
      { input: z.tuple([z.custom<SymbolName | ASymbol | null>().optional()]), output: [z.symbol] },
      gensym,
    ),

    // Contract mirrors typecheck's real arity so the raw function binds cast-free:
    // fn (Valuable = anything with valueOf), arg (any scheme value), expected (a type
    // token or a predicate Function), optional position. The identity contract never runs.
    // A plain FIXED 4-tuple with the 4th marked `.optional()` — NOT z.tuple(fixed, rest)'s
    // unbounded tail. The real impl is a fixed 4-arity with the 4th genuinely optional
    // (`position: number | null = null`), not a true variadic rest; the old .tuple(fixed,
    // rest) shape was the INVERSE gap (unbounded rest where a fixed-with-one-optional-tail
    // was meant). `arg` (2nd slot) is a generic scheme value (`type(arg)` branches over
    // AExact/AInexact/APair/ASymbol/… in utils/typecheck.ts), so it's z.value — the typed
    // replacement for z.unknown() at a native scheme-value slot — not host-blind data.
    typecheck: symbol.native`typecheck: assert arg matches an expected type (or throw a typed error)`(
      {
        input: [
          z.custom<{ valueOf(): unknown }>(),
          z.value,
          z.custom<{ valueOf(): unknown } | Function>(),
          z.custom<number | null>().optional(),
        ],
        output: [z.void()],
      },
      typecheck,
    ),
  },
});
