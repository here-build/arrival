// @here.build/arrival/r7rs/binding — R7RS §4.2.2 binding constructs.
//
// Lineage: R7RS-small (Shinn, Cowan & Gleckler, eds., 2013) §4.2.2 — the
// multiple-value binding forms let-values and let*-values, expanded as macros
// over call-with-values.
//
// SINGLE SOURCE: `base-packs.ts` assembles this capability's prelude and evals
// it (via initBridge's assembleEnv), so this module is the sole definition site.
import { EnvCapability } from "../../common/capability.js";
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { Values } from "../../values/primitives/Values.js";
import { unpromise } from "../../utils/promises.js";
import { typecheck } from "../../utils/typecheck.js";

// Scheme is inherently dynamic at the apply boundary — the relocated values /
// call-with-values bodies receive Scheme values raw (the native identity contract
// never runs), as the stdlib `doc({ value })` form did.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemeFunction = (...args: any[]) => any;

export const BINDING_SCM = `    ;; -----------------------------------------------------------------------------
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
    
`;

// R7RS § 6.10 multiple-value primitives, relocated VERBATIM from stdlib.ts global_env
// (husk dissolution). They live HERE, co-located with their only define-time shape —
// the §4.2.2 let-values / let*-values macros above expand over `call-with-values`. The
// macros reference these at EXPAND (call) time, so binding the symbols before this pack's
// prelude evals is sufficient; no raw-global_env consumer needs them, so the
// BASE_PACKS→user_env home resolves for every consumer by inheritance.
export default new EnvCapability("scheme/r7rs/binding", {
  symbols: {
    "values": symbol.native`values: package zero or more values for a continuation`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      (...args: unknown[]): unknown => Values.from(args),
    ),

    "call-with-values": symbol.native`call-with-values: feed a producer's values into a consumer`(
      { input: [z.custom<SchemeFunction>(), z.custom<SchemeFunction>()], output: [z.unknown()] },
      (producer: SchemeFunction, consumer: SchemeFunction): unknown => {
        typecheck("call-with-values", producer, "function", 1);
        typecheck("call-with-values", consumer, "function", 2);
        // The producer is usually a generator-lambda, so `producer.apply` returns
        // a Promise — unwrap it BEFORE the `instanceof Values` check, else a
        // multi-value producer leaks the Promise as a single arg (wrong arity).
        return unpromise(producer.apply(undefined), (maybe) => {
          if (maybe instanceof Values) {
            return consumer.apply(undefined, maybe.valueOf());
          }
          return consumer(maybe);
        });
      },
    ),
  },
  prelude: BINDING_SCM,
});
