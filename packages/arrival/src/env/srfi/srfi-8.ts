// SRFI-8 — receive. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via `allSrfi`) and evals it
// (via initBridge's assembleEnv), so this module is the sole definition site.
//
// `receive`'s `formals` are FORMALS position, not expression space —
// `(lambda ,formals ,@body)` binds variables, it does not reference them — so
// this pack declares `macroAttribute: "binder"` explicitly rather than leaving
// it at the "opaque" default. (Binder is firewalled identically to opaque until
// a binding-aware macro walker lands — the declaration is the honest
// classification, not a behavior change.)
//
// `symbol.defineSyntax` binds a `Macro` directly (bindCapabilityDefines's Pass 2,
// define-bake.ts) rather than evaluating a scheme `define-syntax` form, so it
// binds identically in the sandboxed env and the main env — the sandboxed
// reader/matcher's inability to parse R7RS's own `(define-syntax …)` special
// form doesn't apply here.
import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";

export default new EnvCapability("scheme/srfi-8", {
  symbols: {
    receive: symbol.defineSyntax`receive: bind the values of a producer expr to formals over body (SRFI-8). (receive (q r) (floor/ 7 2) (list q r)) => (3 1)`(
      `(lambda (formals expr . body)
         \`(call-with-values (lambda () ,expr) (lambda ,formals ,@body)))`,
      { macroAttribute: "binder" },
    ),
  },
});
