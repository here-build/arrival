// @here.build/arrival/r7rs/syntax — R7RS §4.3.1 (let-syntax/letrec-syntax) and
// §5.3 (define-syntax) macro-binding forms.
//
// In a traditional Scheme these forms exist because macros live in a SEPARATE
// namespace resolved at expansion time, distinct from the value namespace — so
// three dedicated forms are needed to place a transformer name into that macro
// namespace at top / non-recursive-local / recursive-local scope.
//
// Arrival collapsed that split: a transformer is a first-class VALUE in the env,
// and the evaluator dispatches on `is_macro` at the call head AFTER resolving the
// head through the ordinary lexical chain (evaluator.ts: `ctxResolver(ctx).resolve`
// then `is_macro`). So the three forms carry no semantics of their own — they
// are exact aliases of the value-binding forms:
//   • define-syntax ≡ define        (bind a transformer at top scope)
//   • let-syntax    ≡ let           (bind it locally; non-recursive falls out of let scoping)
//   • letrec-syntax ≡ letrec        (letrec scoping gives the mutual self-reference for free)
// The recursive-vs-not distinction R7RS spells out is reproduced automatically by
// let/letrec's own scoping math — wrong states become impossible rather than encoded.
//
// Kept (not dropped) purely so portable R7RS macro source loads unchanged. No
// syntaxhood guard: a non-transformer bound here simply fails at its use-site
// through the ordinary not-callable door — moving that check earlier buys nothing.
//
// SINGLE SOURCE: `base-packs.ts` assembles this capability's prelude and evals it
// (via initBridge's assembleEnv), so this module is the sole definition site.

import { EnvCapability } from "../../common/capability.js";

/** scheme/r7rs/syntax — the R7RS macro-binding forms as guardless value-binding aliases. */
export default new EnvCapability("scheme/r7rs/syntax", {
  prelude: `
    (define-macro (define-syntax name expr)
      \`(define ,name ,expr))

    (define-macro (let-syntax vars . body)
      \`(let ,vars ,@body))

    (define-macro (letrec-syntax vars . body)
      \`(letrec ,vars ,@body))
`,
});
