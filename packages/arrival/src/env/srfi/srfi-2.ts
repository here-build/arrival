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
//
// `deps: [equality]` (Stage C Cut 4, docs/plans/stage-c-corpse-deletion.md): `and-let*`'s
// transformer body calls `null?`/`pair?` — NATIVE_PACKS names with no bake-time allowlist entry
// (unlike `car`/`cdr`/`cadr`, which the resolver-synth cxr allowlist covers for free) — so a
// `buildVocabulary` closure that doesn't include `equality` bakes this macro into a closure that
// fails at expansion time with an unbound-variable error. Harmless in every REAL run
// (production always folds `BASE_ROSTER`, which includes `equality`), but a real gap for any
// STANDALONE build of this one pack (found via `srfi-palette.test.ts`'s per-pack
// `buildVocabulary([cap], ...)` fixture — see `srfi-26.ts`'s sibling correction for the full
// mechanism explanation).
import { EnvCapability } from "../../common/capability.js";
import equality from "../r7rs/equality.js";

export default EnvCapability.define("scheme/srfi-2", {
  deps: [equality],
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
