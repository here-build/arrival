// SRFI-235 — Combinators. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via allSrfi), so this module is
// the sole definition site.
//
// DEPS: `compose` (scheme/polyglot), `not` (scheme/equality), `length`/`apply`/
// `append` (scheme/lists), `>=` (scheme/numeric) are every cross-capability free
// name the define bodies below reach — `deps: [equality, numeric, lists, polyglot]`
// below is the complete set, each a declared edge.
//
// The combinator survivors relocated from arrival-extensions:
//   • complement  — SRFI-235: the boolean negation of a predicate.
//   • constantly  — SRFI-235: the K combinator (ignore args, return the constant).
//   • always      — arrival's historical name for `constantly`, kept as an alias.
//   • curry       — NOT SRFI-235, but combinator kin; arrival's arity-aware partial
//                   application, a pure recursive scheme combinator (below) plus one
//                   native, `procedure-min-arity` (arity introspection off
//                   `ACallable.arity` is a host-level read, not itself expressible in
//                   scheme — it just reads `fn.arity.min`). curry's own recursive
//                   accumulate-and-apply logic needs no nativeness of its own: a
//                   scheme `lambda` gets the reverse membrane for free —
//                   `evalLambda` mints a real ALambda (ctx/trampoline/dynamic-call-site
//                   provenance, an honest `arrival/print` repr) — where a bare JS arrow
//                   closure would be exactly the bare-fn-into-value-space leak the
//                   membrane forbids.
//
// NAMING HAZARD: SRFI-235's own `always` is a DIFFERENT procedure. Arrival's `always`
// has always meant `constantly`, so the spec-faithful name is `constantly` and `always`
// is preserved only as a back-compat alias (a type-lens probe references it by name).
import { EnvCapability } from "../../common/capability.js";
import { symbol, type CallCtx } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";
import { is_callable_value } from "../../values/value-guards.js";
import { AExact } from "../../values/primitives/AExact.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import polyglot from "../polyglot.js";
import equality from "../r7rs/equality.js";
import lists from "../r7rs/lists.js";
import numeric from "../r7rs/numeric.js";

export default new EnvCapability("scheme/srfi-235", {
  // See the file header's DEPS note. Array order matters beyond readability:
  // this is a C3 merge input, so it must agree with base-packs.ts's tail-block
  // order — `polyglot` leads (it declares deps of its own, and a dependent's
  // linearization always heads with itself), `lists` trails. See base-packs.ts's
  // own header for the full C3 rule.
  deps: [polyglot, equality, numeric, lists],
  symbols: {
    // complement — the boolean negation of fn: (compose not fn). `not` (native, is_false)
    // handles a boxed SchemeBool, and the evaluator unwraps an async generator-lambda
    // result before `not` sees it — so this pure-scheme form needs no JS maybeThen/is_false
    // closure. `compose` is `scheme/polyglot`'s, a declared dep (see the file header).
    complement: symbol.define`complement: SRFI-235 — the boolean negation of fn`(
      { input: [z.lambda], output: [z.lambda] },
      `(lambda (fn) (compose not fn))`,
    ),

    // constantly — the K combinator: ignore the arguments and always return x. (SRFI-235's
    // `constantly` is variadic over values; arrival only ever uses the single-value form.)
    constantly: symbol.define`constantly: SRFI-235 — the K combinator (ignore args, return the constant x)`(
      { input: [z.value], output: [z.lambda] },
      `(lambda (x) (lambda args x))`,
    ),

    // always — arrival's historical name for constantly. Kept as an alias for back-compat
    // (and the type-lens probe that references `always` by name). NOT SRFI-235's own `always`.
    // A CONSTANT define: its RHS is a plain reference to the sibling `constantly`
    // binding (already bound — declared first, just above), never invoked here,
    // so the contract is the single value schema `z.lambda` (the value IS a
    // procedure), not a `Contract<I,O>` record.
    always: symbol.define`always: arrival's historical name for constantly, kept as a back-compat alias (NOT SRFI-235's own always)`(
      z.lambda,
      `constantly`,
    ),

    // curry — arrival's arity-aware partial application (NOT SRFI-235 itself, combinator kin).
    // Accumulates `args` across successive calls until `(length args)` reaches fn's minimum
    // arity (`procedure-min-arity` — the one native this needs; arity introspection off
    // ACallable.arity isn't expressible in pure scheme), then applies. The not-yet-enough-args
    // branch returns a `lambda` — a real ALambda minted through evalLambda, so every recursive
    // partial application is a first-class scheme value with the reverse membrane's guarantees
    // (ctx, trampoline, print repr), not a bare JS closure escaping into value space.
    // `fn` is the fixed head; `args`/`more` are genuinely variadic (`inputRest: z.value`) —
    // curry's own return is either fn's (arbitrary) result or a new lambda continuation, so
    // the output stays the honest shapeless `z.value` (a SRFI-235-adjacent polyglot alias,
    // not a fixed-shape procedure — some polyglot aliases ARE genuinely shapeless).
    curry: symbol.define`curry: arrival's arity-aware partial application (combinator kin, not SRFI-235 itself)`(
      // OUTPUT is `z.union([z.value, z.values])`: on the arity-met path curry tail-returns
      // `(apply fn args)`, and `fn` is ANY procedure — including a multi-value one like
      // `(curry values 1 2)` — whose `Values` box `z.value` rejects at the decode boundary
      // (the srfi-1 span/break/partition precedent; scheme-zod's `values` doc). The lambda-
      // continuation path returns an ordinary procedure, already covered by `z.value`.
      { input: [z.lambda], inputRest: z.value, output: [z.union([z.value, z.values])] },
      `(lambda (fn . args)
         (if (>= (length args) (procedure-min-arity fn))
             (apply fn args)
             (lambda more (apply curry fn (append args more)))))`,
    ),

    // `procedure-min-arity` — curry's one remaining native: pure arity introspection off
    // `ACallable.arity` (a callable value) or the JS `.length` fallback (a bare legacy fn,
    // e.g. the quarantined `env.defineRosetta` authoring arm). No recursion, no invocation —
    // just a read, so this needs no `this: CallCtx` / runCtx thread the way curry's old JS
    // impl did to re-enter itself.
    "procedure-min-arity":
      symbol.native`procedure-min-arity: the minimum argument count fn accepts (arity introspection for scheme-authored combinators like curry)`(
        { input: [z.lambda], output: [z.exact] },
        function (this: CallCtx, fn: unknown): AExact {
          const min = is_callable_value(fn) ? fn.arity.min : (fn as (...args: unknown[]) => unknown).length;
          return new AExact(CONSTANT_CTX, BigInt(min));
        },
      ),
  },
});
