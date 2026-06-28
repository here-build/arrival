// lips-compat — NON-R7RS LIPS-dialect bindings for the inference plane.
//
// R7RS spells the empty list `'()`; LIPS (and the Scheme the models were trained on)
// also binds the symbol `nil` to it. That binding is NOT R7RS, so it does NOT belong
// in the `scheme/*` packs — it lives here, in a NAMED lips-compat capability, assembled
// ONLY onto the inference plane (inference-env.ts) and available opt-in via
// `exec({ capabilities: [lipsCompat] })`. The default (R7RS) exec base never binds it.
//
// `nil` = the ANil empty-list singleton: `'()` reads to that same singleton
// (`Parser.read_list` returns the `nil` export on an empty list; `is_nil` is
// instanceof-based), so the prelude `(define nil '())` binds exactly what the old inline
// `new Environment("inference", { nil }, userEnv)` island bound — the dissolution is the
// inline `{ nil }` literal becoming this declarative, named pack.
import { EnvCapability } from "../common/capability.js";

export const lipsCompat = new EnvCapability("lips-compat", {
  prelude: `
    ;; nil — LIPS-dialect alias for the empty list. NON-R7RS (R7RS uses '()).
    (define nil '())
  `,
});

export default lipsCompat;
