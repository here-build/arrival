// SRFI-8 — receive. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via `allSrfi`) and evals it
// (via initBridge's assembleEnv), so this module is the sole definition site.
//
// symbol.defineSyntax (docs/working-proposals/symbol-define-static-program-validation.md
// §1/§3.4/§4, W4 prelude-death migration) — this pack is the design doc's OWN worked
// BINDER example (§3.4's table, `receive`'s formals cited by name): `receive`'s
// `formals` are FORMALS position, not expression space (`(lambda ,formals ,@body)`
// binds variables, it does not reference them), so `macroAttribute: "binder"` is
// declared explicitly rather than left at the "opaque" default. Walk POLICY is
// unchanged either way today (§3.4: binder is firewalled identically to opaque
// until a binding-aware macro walker lands) — the declaration is the honest
// classification, not a behavior change. (LAW 4's `receive` row in
// `__tests__/laws/static-validation.law.test.ts` already names this pack as "the
// FIRST production `macroAttribute: "binder"` declaration" — that citation predates
// this migration; and-let*'s srfi-2 migration landed the SAME classification first
// in commit order, this pack is the doc's own worked example either way.)
//
// `define-macro` → `symbol.defineSyntax` does NOT reintroduce the "no define-syntax
// in the sandbox" problem the old header warned about: that constraint was about the
// R7RS SCHEME special form `(define-syntax …)` the sandboxed reader/matcher can't
// parse. `symbol.defineSyntax` is a JS-level declaration kind — the bound `Macro` is
// wound directly by `bindCapabilityDefines`'s Pass 2 (define-bake.ts), never by
// evaluating a scheme `define-syntax` form — so it binds identically in the sandboxed
// env and the main env, same as `define-macro` did (env/__tests__/srfi.test.ts's
// `withCap(srfi8, …)` sandboxed-env row exercises this directly).
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
