// @here.build/arrival/r7rs/binding — R7RS §4.2.2 binding constructs.
//
// Lineage: R7RS-small (Shinn, Cowan & Gleckler, eds., 2013) §4.2.2 — the
// multiple-value binding forms let-values and let*-values, expanded as macros
// over call-with-values.
//
// SINGLE SOURCE: `base-packs.ts` assembles this capability's prelude and evals
// it (via initBridge's assembleEnv), so this module is the sole definition site.
import { EnvCapability } from "../capability.js";

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

export default new EnvCapability("scheme/r7rs/binding", { prelude: BINDING_SCM });
