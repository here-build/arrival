// SRFI-2 — and-let*. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via `allSrfi`) and evals it
// (via initBridge's assembleEnv), so this module is the sole definition site.
//
// `and-let*`'s claws are FORMALS position, not expression space — `(car claw)`
// binds a variable, it does not reference one — so this pack declares
// `macroAttribute: "binder"` explicitly rather than leaving it at the "opaque"
// default. (Binder is firewalled identically to opaque until a binding-aware
// macro walker lands — the declaration is the honest classification, not a
// behavior change.)
//
// `symbol.defineSyntax` binds a `Macro` directly (bindCapabilityDefines's Pass 2,
// define-bake.ts) rather than evaluating a scheme `define-syntax` form, so it
// binds identically in the sandboxed env and the main env — the sandboxed
// reader/matcher's inability to parse R7RS's own `(define-syntax …)` special
// form doesn't apply here.
import { EnvCapability } from "../../common/capability.js";

export default EnvCapability.define("scheme/srfi-2", {
  symbols: (symbol) => ({
    "and-let*":
      symbol.defineSyntax`and-let*: sequential AND with binding (SRFI-2). Claw (var expr) binds+tests var; claw (expr) is a bare guard; a bare symbol tests itself. Any #f short-circuits the whole form to #f; otherwise the value is the body (or #t when there is no body).`(
        `(lambda (claws . body)
         (if (null? claws)
             (if (null? body) #t \`(begin ,@body))
             (let ((claw (car claws)) (rest (cdr claws)))
               (cond
                 ((and (pair? claw) (pair? (cdr claw)))
                  \`(let ((,(car claw) ,(cadr claw)))
                     (if ,(car claw) (and-let* ,rest ,@body) #f)))
                 ((pair? claw)
                  \`(if ,(car claw) (and-let* ,rest ,@body) #f))
                 (else
                  \`(if ,claw (and-let* ,rest ,@body) #f))))))`,
        { macroAttribute: "binder" },
      ),
  }),
});
