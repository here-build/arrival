// SRFI-235 — Combinators. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via allSrfi) and evals its
// prelude, so this module is the sole definition site.
//
// The combinator survivors relocated from arrival-extensions (husk dissolution):
//   • complement  — SRFI-235: the boolean negation of a predicate.
//   • constantly  — SRFI-235: the K combinator (ignore args, return the constant).
//   • always      — arrival's historical name for `constantly`, kept as an alias.
//   • curry       — NOT SRFI-235, but combinator kin; arrival's arity-aware partial
//                   application. DISSOLVED (reverse-membrane-for-callables.md §2/§3 step 2,
//                   2026-07-09) from a native JS partial-application closure into a pure
//                   recursive scheme combinator (below, in the prelude) plus one native,
//                   `procedure-min-arity` — the stated reason curry was native ("arity
//                   detection can't be pure scheme") no longer held: `ACallable.arity` is a
//                   designed introspection surface, and the old JS impl already just read
//                   `fn.arity.min` off it. A scheme `lambda` gets the reverse membrane for
//                   free — `evalLambda` mints a real ALambda (ctx/trampoline/dynamic-call-site
//                   provenance, an honest `arrival/print` repr) — where the old bare JS arrow
//                   closure was exactly the bare-fn-into-value-space leak the membrane forbids.
//
// NAMING HAZARD: SRFI-235's own `always` is a DIFFERENT procedure. Arrival's `always`
// has always meant `constantly`, so the spec-faithful name is `constantly` and `always`
// is preserved only as a back-compat alias (a type-lens probe references it by name).
import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";
import { is_callable_value } from "../../values/value-guards.js";
import { AExact } from "../../values/primitives/AExact.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";

export default new EnvCapability("scheme/srfi-235", {
  prelude: `
;; ============ SRFI-235 (combinators) ============
;; complement — the boolean negation of fn. (compose not fn): \`not\` (native, is_false)
;; handles a boxed SchemeBool, and the evaluator unwraps an async generator-lambda
;; result before \`not\` sees it — so this pure-scheme form needs no JS maybeThen/is_false
;; closure (the leak the former native impl carried). compose is co-resident (polyglot).
(define (complement fn) (compose not fn))

;; constantly — the K combinator: ignore the arguments and always return x. (SRFI-235's
;; \`constantly\` is variadic over values; arrival only ever uses the single-value form.)
(define (constantly x) (lambda args x))
;; always — arrival's historical name for constantly. Kept as an alias for back-compat
;; (and the type-lens probe that references \`always\` by name). NOT SRFI-235's own \`always\`.
(define always constantly)

;; curry — arrival's arity-aware partial application (NOT SRFI-235 itself, combinator kin).
;; Accumulates \`args\` across successive calls until \`(length args)\` reaches fn's minimum
;; arity (\`procedure-min-arity\` — the one native this needs; arity introspection off
;; ACallable.arity isn't expressible in pure scheme), then applies. The not-yet-enough-args
;; branch returns a \`lambda\` — a real ALambda minted through evalLambda, so every recursive
;; partial application is a first-class scheme value with the reverse membrane's guarantees
;; (ctx, trampoline, print repr), not a bare JS closure escaping into value space.
(define (curry fn . args)
  (if (>= (length args) (procedure-min-arity fn))
      (apply fn args)
      (lambda more (apply curry fn (append args more)))))
`,
  symbols: {
    // `procedure-min-arity` — curry's one remaining native: pure arity introspection off
    // `ACallable.arity` (a callable value) or the JS `.length` fallback (a bare legacy fn,
    // e.g. the quarantined `env.defineRosetta` authoring arm). No recursion, no invocation —
    // just a read, so this needs no `this: CallCtx` / runCtx thread the way curry's old JS
    // impl did to re-enter itself.
    "procedure-min-arity":
      symbol.native`procedure-min-arity: the minimum argument count fn accepts (arity introspection for scheme-authored combinators like curry)`(
        { input: [z.lambda], output: [z.exact] },
        (fn: unknown): AExact => {
          const min = is_callable_value(fn) ? fn.arity.min : (fn as (...args: unknown[]) => unknown).length;
          return new AExact(CONSTANT_CTX, BigInt(min));
        },
      ),
  },
});
