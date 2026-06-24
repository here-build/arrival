// @here.build/arrival/r7rs/conditionals — R7RS §4.2.1 derived conditionals.
//
// Lineage: R7RS-small (Shinn, Cowan & Gleckler, eds., 2013) §4.2.1 — the
// derived conditional forms cond / case / when / unless, expanded as macros
// from the small special-form core. %else-literal? is the private native
// helper that lets cond/case recognise a literal `else` clause; it lives here,
// co-located with its only callers.
//
// SINGLE SOURCE: `base-packs.ts` assembles this capability's prelude and evals
// it (via initBridge's assembleEnv), so this module is the sole definition site.
import { EnvCapability } from "../capability.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import * as z from "../scheme-zod.js";
import { symbol } from "../symbol.js";
import { withInputProvenance } from "../../values/op-helpers.js";

// Native: recognise a literal `else` clause head — matches the interned `else`
// symbol or any gensym whose literal name is "else". Lives in TS because it reads
// the SchemeSymbol's literal directly instead of reaching the host via `new`/`-->`.

export const CONDITIONALS_SCM = `
    ;; %else-literal? is native (below the membrane) — see the symbols block below.
    
    ;; -----------------------------------------------------------------------------
    ;; R7RS cond macro
    ;; -----------------------------------------------------------------------------
    (define-macro (cond . list)
      (if (pair? list)
          (let* ((item (car list))
                 (value (gensym))
                 (first (car item))
                 (fn (and (not (null? (cdr item))) (eq? (cadr item) '=>)))
                 (expression (if fn
                                 (caddr item)
                                 (cdr item)))
                 (rest (cdr list)))
            (if (%else-literal? first)
                \`(begin
                   ,@expression)
                \`(let ((,value ,first))
                   (if ,value
                       ,(if fn
                            \`(,expression ,value)
                            \`(begin
                               ,@expression))
                       ,(if (not (null? rest))
                            \`(cond ,@rest))))))
          '()))
    
    ;; -----------------------------------------------------------------------------
    ;; R7RS when and unless macros
    ;; -----------------------------------------------------------------------------
    (define-macro (when test . body)
      \`(if ,test
           (begin ,@body)))
    
    (define-macro (unless test . body)
      \`(if (not ,test)
           (begin ,@body)))
    
    ;; -----------------------------------------------------------------------------
    ;; R7RS case macro
    ;; -----------------------------------------------------------------------------
    (define-macro (case key . clauses)
      (let ((key-val (gensym "key")))
        \`(let ((,key-val ,key))
           (cond
             ,@(map (lambda (clause)
                      (let* ((datums (car clause))
                             (rest (cdr clause))
                             (has-arrow (and (pair? rest)
                                            (pair? (cdr rest))
                                            (eq? (car rest) '=>)))
                             (proc (if has-arrow (cadr rest) #f))
                             (exprs (if has-arrow #f rest)))
                        (if (%else-literal? datums)
                            (if has-arrow
                                \`(else (,proc ,key-val))
                                \`(else ,@exprs))
                            (if has-arrow
                                \`((memv ,key-val ',datums) (,proc ,key-val))
                                \`((memv ,key-val ',datums) ,@exprs)))))
                    clauses)))))
    
`;

export default new EnvCapability("scheme/r7rs/conditionals", {
  symbols: {
    // Plumbing (a structural predicate in the cond/case pipe), not an edge: the verdict
    // forwards the operand's provenance via withInputProvenance, never mints.
    "%else-literal?": symbol.native`%else-literal?: #t iff obj is the literal else symbol`(
      { input: [z.unknown()], output: [z.boolean] },
      (obj: unknown): boolean =>
        withInputProvenance([obj], obj instanceof ASymbol && (ASymbol.is(obj, "else") || obj.literal() === "else")),
    ),
  },
  prelude: CONDITIONALS_SCM,
});
