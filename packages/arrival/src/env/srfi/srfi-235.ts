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
//                   application, kept NATIVE (the arity detection can't be pure scheme).
//
// NAMING HAZARD: SRFI-235's own `always` is a DIFFERENT procedure. Arrival's `always`
// has always meant `constantly`, so the spec-faithful name is `constantly` and `always`
// is preserved only as a back-compat alias (a type-lens probe references it by name).
import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";
import { applyCallback } from "../../values/primitives/ACallable.js";
import { CallCtx, makeCallCtx } from "../../common/symbols/_bake.js";
import { is_callable_value } from "../../values/value-guards.js";

export default new EnvCapability("scheme/srfi-235", {
  prelude: `
;; ============ SRFI-235 (combinators) ============
;; complement — the boolean negation of fn. (compose not fn): \`not\` (native, is_false)
;; handles a boxed SchemeBool, and the evaluator unwraps an async generator-lambda
;; result before \`not\` sees it — so this pure-scheme form needs no JS unpromise/is_false
;; closure (the leak the former native impl carried). compose is co-resident (polyglot).
(define (complement fn) (compose not fn))

;; constantly — the K combinator: ignore the arguments and always return x. (SRFI-235's
;; \`constantly\` is variadic over values; arrival only ever uses the single-value form.)
(define (constantly x) (lambda args x))
;; always — arrival's historical name for constantly. Kept as an alias for back-compat
;; (and the type-lens probe that references \`always\` by name). NOT SRFI-235's own \`always\`.
(define always constantly)
`,
  symbols: {
    // `curry` — arrival's arity-aware partial application (the shared utils/functional
    // curry: it auto-applies once \`fn.length\` args have arrived). Combinator kin to the
    // prelude above, but kept NATIVE because the arity detection can't be expressed in
    // pure scheme.
    //
    // `fn` is the fixed HEAD; the leading args being partially applied are the variadic
    // TAIL (`inputRest`) — mirrors apply's head/rest split. The head is the established
    // callable-schema convention (z.custom<(...args) => T>(), matching vector-map/
    // vector-for-each/apply's own callable slots), and the rest is `z.value` — real scheme
    // terms flowing through a native call, not representation-blind.
    curry: symbol.native`curry: partially apply fn to leading args, returning a function of the rest`(
      {
        input: [z.lambda],
        inputRest: z.value,
        output: [z.lambda],
        /*
        * TODO: wire proper curry type; need declaration area for types:
        *
        type Curry<T extends (...args: any[]) => any> =
          T extends (...args: infer Args) => infer R
              ? Args extends []
                  ? T
                  : Args extends [infer FirstArg, ...infer RestArgs]
                      ? RestArgs extends []
                          ? T
                          : (arg: FirstArg) => Curry<(...args: RestArgs) => R>
                      : never
              : never;
        */
        type: "(fn: (...args: unknown[]) => unknown, ...args: unknown[]) => (...args: unknown[]) => unknown",
      },
      // `fn` is a scheme callable VALUE (ALambda/ANativeProcedure/ARosettaProcedure), not a bare
      // JS function — invoking it directly (`fn(...)`) throws. Route through `applyCallback`,
      // the one invocation seam, and read the needed arity off the callable's own `.arity.min`
      // (a bare JS host fn falls back to `.length`). `this.runCtx` per the native convention
      // (capability.ts's native bind: `hostImpl.apply(makeCallCtx(runCtx), args)`).
      function curry(this: CallCtx, fn: unknown, ...args: unknown[]): unknown {
        const runCtx = this.runCtx;
        const needed = is_callable_value(fn) ? fn.arity.min : (fn as (...a: unknown[]) => unknown).length;
        return needed > args.length
          ? (...curriedArgs: unknown[]) => curry.call(makeCallCtx(runCtx), fn, ...args, ...curriedArgs)
          : applyCallback(fn, args, runCtx);
      } as unknown as (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => (...a: unknown[]) => unknown,
    ),
  },
});
