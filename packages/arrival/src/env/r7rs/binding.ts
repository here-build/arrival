// @here.build/arrival/r7rs/binding — R7RS-small §4.2.2 binding constructs: the
// multiple-value forms let-values / let*-values, expanded as macros over
// call-with-values.
//
// BACKLOG (not an omission-by-design, so NOT a door): R7RS §5.3.3 `define-values`
// is derivable over call-with-values (which lives here) but is not yet added — a
// genuine TODO, not a purity omission. When added it belongs in this pack.
//
// SINGLE SOURCE: `base-packs.ts` assembles this capability's prelude and evals
// it (via ensureBaseAssembled's assembleEnv), so this module is the sole
// definition site.
import { EnvCapability } from "../../common/capability.js";
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { Values } from "../../values/primitives/Values.js";
import { maybeThen } from "../../utils/promises.js";
import { applyCallback } from "../../values/primitives/ACallable.js";
import { type SchemeValue } from "../../values/types.js";

// R7RS § 6.10 multiple-value primitives, co-located with their only consumer —
// the §4.2.2 let-values / let*-values macros above expand over `call-with-values`.
// The macros reference these at EXPAND (call) time, so binding the symbols before
// this pack's prelude evals is sufficient.
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
      // Output is z.value (SchemeValue), not narrower: it flows through the shared,
      // sync-fast-path `maybeThen` (utils/promises.ts, also srfi-1's seam), whose own
      // signature is `(value: unknown, fn) => unknown` — no narrower type is achievable
      // here without widening that shared utility (out of scope) or a banned `as SchemeValue`
      // cast (honest-types-no-casts). The two z.custom callable params are UNREPRESENTABLE
      // to the harvest printer (throws on `custom`), collapsing signatureOf to the catch-all
      // `(...args: unknown[]) => unknown` — `type` author-asserts the real two-procedure
      // signature for the harvest only; the zod schemas stay the membrane's real description.
      {
        input: [z.lambda, z.lambda],
        // R7RS: call-with-values RETURNS the consumer's result (a tail call into consumer with
        // the producer's values as args) — it never discards. `z.undefinedResult` was wrong
        // (the readonly-slot strictness pass surfaced the mismatch, not introduced it).
        output: [z.value],
        type: "(producer: (...args: unknown[]) => unknown, consumer: (...args: unknown[]) => unknown) => unknown",
      },
      function (producer, consumer): SchemeValue | Promise<SchemeValue> {
        // Seam-routed: producer/consumer are callable VALUES now, not bare fns. The producer is
        // usually a lambda, so its invocation may return a Promise — unwrap it BEFORE the
        // `instanceof Values` check, else a multi-value producer leaks the Promise as a single
        // arg (wrong arity).
        const runCtx = this.runCtx;
        // maybeThen is a generic (unknown-typed) sync/async seam — assert at this
        // one boundary that its result is what the callback below actually produces.
        return maybeThen(applyCallback(producer, [], runCtx), (maybe) => {
          if (maybe instanceof Values) {
            return applyCallback(consumer, maybe.valueOf(), runCtx);
          }
          return applyCallback(consumer, [maybe], runCtx);
        }) as SchemeValue | Promise<SchemeValue>;
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
