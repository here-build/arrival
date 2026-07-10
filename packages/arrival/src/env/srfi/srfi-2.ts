// SRFI-2 — and-let*. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via `allSrfi`) and evals it
// (via initBridge's assembleEnv), so this module is the sole definition site.
//
// symbol.defineSyntax (docs/working-proposals/symbol-define-static-program-validation.md
// §1/§3.4/§4, W4 prelude-death migration) — this pack is the design doc's OWN worked
// BINDER example (§3.4's table): `and-let*`'s claws are FORMALS position, not
// expression space (`(car claw)` binds a variable, it does not reference one), so
// `macroAttribute: "binder"` is declared explicitly rather than left at the "opaque"
// default. Walk POLICY is unchanged either way today (§3.4: binder is firewalled
// identically to opaque until a binding-aware macro walker lands) — the declaration
// is the honest classification, not a behavior change.
//
// `define-macro` → `symbol.defineSyntax` does NOT reintroduce the "no define-syntax
// in the sandbox" problem the old header warned about: that constraint was about the
// R7RS SCHEME special form `(define-syntax …)` the sandboxed reader/matcher can't
// parse. `symbol.defineSyntax` is a JS-level declaration kind — the bound `Macro` is
// wound directly by `bindCapabilityDefines`'s Pass 2 (define-bake.ts), never by
// evaluating a scheme `define-syntax` form — so it binds identically in the sandboxed
// env and the main env, same as `define-macro` did.
import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";

export default new EnvCapability("scheme/srfi-2", {
  symbols: {
    "and-let*": symbol.defineSyntax`and-let*: sequential AND with binding (SRFI-2). Claw (var expr) binds+tests var; claw (expr) is a bare guard; a bare symbol tests itself. Any #f short-circuits the whole form to #f; otherwise the value is the body (or #t when there is no body).`(
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
  },
});
