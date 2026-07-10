// SRFI-235 — Combinators. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via allSrfi), so this module is
// the sole definition site.
//
// MIGRATED off the text-blob `prelude` (docs/working-proposals/symbol-define-static-
// program-validation.md, wave W4/H1): each combinator is now an individually-declared
// `symbol.define`, contract-enforced from day one (§1.2 rev2 ruling) — no more opaque
// prelude string, no more assembly-order-luck cross-capability references (§2.1's bake
// FV locality law forces every free name into either this capability's OWN symbol set
// or a DECLARED `deps` edge).
//
// THE LATENT BUG THIS MIGRATION FIXES (design doc §2.1's "live catch", §4.1's census
// row): `complement`'s body calls `compose` — a `scheme/polyglot` define — with NO
// declared dep. It worked only because `env-roots`/`base-packs.ts` happens to assemble
// polyglot before this pack in the same phase; the FV law (`define-bake.ts`) refuses an
// undeclared free reference at bake, so the fix is a REAL `deps` edge (`polyglot`,
// below), converting the luck into structure. The SAME migration surfaced a further,
// undocumented instance of the identical class of bug: `complement`'s `not`, and
// `curry`'s `length`/`apply`/`append`/`>=`, are likewise cross-capability references
// (to `scheme/equality`, `scheme/lists`, `scheme/numeric`) that the OLD text-blob
// prelude got away with purely because the two-phase bootstrap
// (`env-roots.ts`: NATIVE_PACKS → global_env, THEN BASE_PACKS → user_env) guarantees
// every R7RS native is already bound by the time any BASE_PACKS prelude runs — a
// runtime guarantee, not a declared one. The bake FV law does not consult that runtime
// guarantee (by design — it is a STATIC check over declared `deps`, precisely so a
// hermetic/roster/glass assembly that DOESN'T happen to include the native packs can't
// silently break), so each of those four names needed the exact same treatment as
// `compose`: a real `deps` edge. `deps: [equality, numeric, lists, polyglot]` below is
// the complete, empirically-verified set — `pnpm test` is the proof (see the rows in
// `__tests__/srfi-235-symbol-define.test.ts`).
//
// The combinator survivors relocated from arrival-extensions (husk dissolution):
//   • complement  — SRFI-235: the boolean negation of a predicate.
//   • constantly  — SRFI-235: the K combinator (ignore args, return the constant).
//   • always      — arrival's historical name for `constantly`, kept as an alias.
//   • curry       — NOT SRFI-235, but combinator kin; arrival's arity-aware partial
//                   application. DISSOLVED (reverse-membrane-for-callables.md §2/§3 step 2,
//                   2026-07-09) from a native JS partial-application closure into a pure
//                   recursive scheme combinator (below) plus one native,
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
import polyglot from "../polyglot.js";
import equality from "../r7rs/equality.js";
import lists from "../r7rs/lists.js";
import numeric from "../r7rs/numeric.js";

export default new EnvCapability("scheme/srfi-235", {
  // See the file header: `compose` (polyglot), `not` (equality), `length`/`apply`/
  // `append` (lists), `>=` (numeric) are every cross-capability free name this
  // pack's define bodies reach — the bake FV law (§2.1) forces each into a real edge.
  //
  // ORDER MATTERS here beyond readability: this array is a C3 merge input, so its
  // relative order among fellow BASE_PACKS members must agree with base-packs.ts's
  // tail block. Since polyglot's own W4/H3 migration (it declares deps of its own,
  // incl. `lists`), the tail runs [polyglot, …, lists] — so `polyglot` is listed
  // BEFORE `lists` here (the pre-H3 `[…, lists, polyglot]` order was a merge input
  // contradicting that tail; flipped in the same commit that moved polyglot — see
  // base-packs.ts's header). And `polyglot` must LEAD the whole array: it declares
  // deps of its own (incl. `equality`/`numeric`, W4-H3), and a dependent's
  // linearization always heads with itself — `[equality, numeric, polyglot, …]`
  // contradicts L(polyglot) and deadlocks the C3 merge (the dependents-before-
  // dependencies rule, same as the tail block's; see polyglot.ts's deps note).
  deps: [polyglot, equality, numeric, lists],
  symbols: {
    // complement — the boolean negation of fn. (compose not fn): `not` (native, is_false)
    // handles a boxed SchemeBool, and the evaluator unwraps an async generator-lambda
    // result before `not` sees it — so this pure-scheme form needs no JS maybeThen/is_false
    // closure (the leak the former native impl carried). `compose` is `scheme/polyglot`'s
    // (a declared dep, see above — not "co-resident" luck anymore).
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
    // A CONSTANT define (§1.2): its RHS is a plain reference to the sibling `constantly`
    // binding (already bound — sequential-RHS, §2.3 — `constantly` is declared first),
    // never invoked here, so the contract is the single value schema `z.lambda` (the value
    // IS a procedure), not a `Contract<I,O>` record.
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
    // not a fixed-shape procedure — §1.2's "some polyglot aliases ARE genuinely shapeless").
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
        (fn: unknown): AExact => {
          const min = is_callable_value(fn) ? fn.arity.min : (fn as (...args: unknown[]) => unknown).length;
          return new AExact(CONSTANT_CTX, BigInt(min));
        },
      ),
  },
});
