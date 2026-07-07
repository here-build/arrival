// SRFI-2 — and-let*. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles `SRFI2_SCM` and
// evals it (via initBridge's assembleEnv), so this module is the sole definition site.
//
// `define-macro`, not `define-syntax`/`syntax-rules` — the sandbox's matcher has no
// `define-syntax`, so this is the one definition serving both envs.
import { EnvCapability } from "../../common/capability.js";

export default new EnvCapability("scheme/srfi-2", {
  prelude: `
;; ============ SRFI-2 and-let* ============
;; and-let* (SRFI-2) — sequential AND with binding. Claw (var expr) binds+tests var;
;; claw (expr) is a bare guard; a bare symbol tests itself. Any #f short-circuits the
;; whole form to #f; otherwise the value is the body (or #t when there is no body).
(define-macro (and-let* claws . body)
  (if (null? claws)
      (if (null? body) #t \`(begin ,@body))
      (let ((claw (car claws)) (rest (cdr claws)))
        (cond
          ((and (pair? claw) (pair? (cdr claw)))
           \`(let ((,(car claw) ,(cadr claw)))
              (if ,(car claw) (and-let* ,rest ,@body) #f)))
          ((pair? claw)
           \`(if ,(car claw) (and-let* ,rest ,@body) #f))
          (else
           \`(if ,claw (and-let* ,rest ,@body) #f))))))
`,
});
