// SRFI-8 — receive. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via `allSrfi`) and evals it
// (via initBridge's assembleEnv), so this module is the sole definition site.
//
// `define-macro` (same form the threading/cut packs use), not `define-syntax`/
// `syntax-rules` — the sandbox's matcher has no `define-syntax`, so this is the
// one definition serving both envs.
import { EnvCapability } from "../../common/capability.js";

export default new EnvCapability("scheme/srfi-8", {
  prelude: `
;; ============ SRFI-8 receive ============
;; receive (SRFI-8) — bind the values of the producer expr to formals over body.
;;   (receive (q r) (floor/ 7 2) (list q r)) => (3 1)
(define-macro (receive formals expr . body)
  \`(call-with-values (lambda () ,expr) (lambda ,formals ,@body)))
`,
});
