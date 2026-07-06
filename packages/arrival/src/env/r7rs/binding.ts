// @here.build/arrival/r7rs/binding — R7RS §4.2.2 binding constructs.
//
// Lineage: R7RS-small (Shinn, Cowan & Gleckler, eds., 2013) §4.2.2 — the
// multiple-value binding forms let-values and let*-values, expanded as macros
// over call-with-values.
//
// BACKLOG (not an omission-by-design, so NOT a door): R7RS §5.3.3 `define-values`
// is derivable over call-with-values (which lives here) but is not yet added — a
// genuine TODO, not a purity omission. When added it belongs in this pack. (Moved
// here from the deleted `_unimplemented.ts` R7RS_TODO ledger.)
//
// SINGLE SOURCE: `base-packs.ts` assembles this capability's prelude and evals
// it (via initBridge's assembleEnv), so this module is the sole definition site.
import { EnvCapability } from "../../common/capability.js";
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { Values } from "../../values/primitives/Values.js";
import { unpromise } from "../../utils/promises.js";
import { applyCallback } from "../../values/primitives/ACallable.js";
import { CONSTANT_CTX, type RunContext } from "../../values/primitives/RunContext.js";

// R7RS § 6.10 multiple-value primitives, relocated VERBATIM from stdlib.ts global_env
// (husk dissolution). They live HERE, co-located with their only define-time shape —
// the §4.2.2 let-values / let*-values macros above expand over `call-with-values`. The
// macros reference these at EXPAND (call) time, so binding the symbols before this pack's
// prelude evals is sufficient; no raw-global_env consumer needs them, so the
// BASE_PACKS→user_env home resolves for every consumer by inheritance.
export default new EnvCapability("scheme/r7rs/binding", {
  symbols: {
    // §4.1.6 Assignment — the last binding-MUTATION vestige, doored. arrival is pure
    // dataflow: every value carries the lineage of WHERE it was bound, so re-binding a
    // name (the value family `set-car!`/`vector-set!` is doored too) severs that lineage —
    // there is no single binding site left to root it at. For an updated value, bind a
    // fresh name (`let`/`letrec`/`define` in a new scope) or thread it through your dataflow.
    "set!": symbol.notImplemented`set!: set! mutates — violates value provenance (R7RS §4.1.6 omitted) — arrival is pure dataflow; rebinding a variable severs the lineage a value carries from its binding site. Bind a fresh name (let / letrec / define in a new scope) or thread the value through your dataflow instead`,

    values: symbol.native`values: package zero or more values for a continuation`(
      { input: [], inputRest: z.value, output: [z.value] },
      (...args) => Values.from(args),
    ),

    "call-with-values": symbol.native`call-with-values: feed a producer's values into a consumer`(
      // Output stays `z.unknown()`, NOT `z.value` — verified, not an oversight. The return
      // flows through `unpromise` (utils/promises.ts), a genuinely-generic helper (also used by
      // srfi-1's fold) whose OWN declared signature is `(value: unknown, fn: (x: unknown) =>
      // unknown, …) => unknown` — it recurses through Promise/array/plain-object containers
      // generically, so its result has no narrower honest static type here. Tightening this
      // output to `z.value` was tried and reds at the `return unpromise(...)` line with "Type
      // 'unknown' is not assignable to type 'SchemeValue'" — fixing it honestly would mean
      // making the SHARED `unpromise` utility generic (out of scope: a cross-cutting helper, not
      // this capability) or a bare `as SchemeValue` cast (banned — see the project's
      // honest-types-no-casts convention). `z.unknown()` here is the honest type, not a gap.
      // The two z.custom<SchemeFunction> params are UNREPRESENTABLE to the harvest printer
      // (it throws on `custom`), collapsing signatureOf to the catch-all `(...args: unknown[])
      // => unknown` and losing the two-procedure shape. `type` author-asserts the real
      // signature (a callable renders as `(...args: unknown[]) => unknown`, the this-session
      // convention shared with the srfi curry/find/sort overrides). The zod schemas stay the
      // MEMBRANE description; this is the decoupled TYPE-LEVEL narrowing for the harvest only.
      {
        input: [z.lambda, z.lambda],
        output: [z.undefinedResult],
        type: "(producer: (...args: unknown[]) => unknown, consumer: (...args: unknown[]) => unknown) => unknown",
      },
      function (this: { ctx?: { runCtx?: RunContext } }, producer: unknown, consumer: unknown): unknown {
        // Seam-routed: producer/consumer are callable VALUES now, not bare fns. The producer is
        // usually a lambda, so its invocation may return a Promise — unwrap it BEFORE the
        // `instanceof Values` check, else a multi-value producer leaks the Promise as a single
        // arg (wrong arity).
        const runCtx = this?.ctx?.runCtx ?? CONSTANT_CTX;
        return unpromise(applyCallback(producer, [], runCtx), (maybe) => {
          if (maybe instanceof Values) {
            return applyCallback(consumer, maybe.valueOf(), runCtx);
          }
          return applyCallback(consumer, [maybe], runCtx);
        });
      },
    ),
  },
  prelude: `
    ;; -----------------------------------------------------------------------------
    ;; R7RS let-values and let*-values
    ;; -----------------------------------------------------------------------------
    (define-macro (let-values bindings . body)
      (if (null? bindings)
          \`(begin ,@body)
          (let* ((first-binding (car bindings))
                 (vars (car first-binding))
                 (expr (cadr first-binding))
                 (rest-bindings (cdr bindings)))
            \`(call-with-values
               (lambda () ,expr)
               (lambda ,vars
                 (let-values ,rest-bindings ,@body))))))
    
    (define-macro (let*-values bindings . body)
      (if (null? bindings)
          \`(begin ,@body)
          (let* ((first-binding (car bindings))
                 (vars (car first-binding))
                 (expr (cadr first-binding))
                 (rest-bindings (cdr bindings)))
            \`(call-with-values
               (lambda () ,expr)
               (lambda ,vars
                 (let*-values ,rest-bindings ,@body))))))
    
`,
});
