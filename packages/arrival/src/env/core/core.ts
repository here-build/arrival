// @here.build/arrival/core — the irreducible scheme core pack.
//
// The base-most scheme defs that every other pack expands against: the essential
// constants, the PURITY DOORS (the mutators + dynamics arrival omits by design,
// each an errors-as-door naming the omission + the supported alternative), the
// syntax-binding macros (let-syntax / letrec-syntax / define-syntax), and the
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
import { gensym } from "../../reader/values-repr.js";
import { typecheck } from "../../utils/typecheck.js";

/** The irreducible scheme core pack: constants, purity doors, syntax-binding macros.
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
    // of these. if / begin join in the macro-cut pass — NOT only for first-class dispatch
    // but because the HYGIENE engine resolves a renamed template identifier (`if` → `#:if`)
    // by binding the gensym to the original name's ENV VALUE (syntax-rules.ts rename()).
    // A name-dispatched special form has no env value → `#:if` is unbound → the §7.3 derived
    // macros cannot expand. As keyword markers they resolve, so syntax-rules can host them.
    // (let* / letrec / quote / quasiquote follow as the remaining primitives are keyworded.)
    lambda: symbol.keyword`lambda: create an anonymous procedure`,
    define: symbol.keyword`define: bind a name in the current scope`,
    let: symbol.keyword`let: bind locals over a body`,
    if: symbol.keyword`if: conditional — evaluate the consequent or the alternative`,
    begin: symbol.keyword`begin: evaluate a sequence, yield the last`,
    gensym: symbol.native`gensym: a fresh uninterned symbol (optional name hint)`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      gensym,
    ),

    // Contract mirrors typecheck's real arity so the raw function binds cast-free:
    // fn (Valuable = anything with valueOf), arg (any scheme value), expected (a type
    // token or a predicate Function), optional position. The identity contract never runs.
    typecheck: symbol.native`typecheck: assert arg matches an expected type (or throw a typed error)`(
      {
        input: z.tuple(
          [z.custom<{ valueOf(): unknown }>(), z.unknown(), z.custom<{ valueOf(): unknown } | Function>()],
          z.custom<number | null>(),
        ),
        output: [z.void()],
      },
      typecheck,
    ),
  },
});
