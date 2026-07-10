// SRFI-26 — cut / cute (parameter specialization). Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via `allSrfi`) and evals it
// (via initBridge's assembleEnv), so this module is the sole definition site.
//
// symbol.defineSyntax (docs/working-proposals/symbol-define-static-program-validation.md
// §1/§2.1/§3.4/§4, W4 prelude-death migration) — this pack is the design doc's OWN named
// hard case for the §2.1 bake FV law (the doc's "second live catch, macro-flavored"):
// `cut`/`cute` introduce the placeholder tokens `<>` (a positional slot) and `<...>` (a
// final rest slot) inside their EXPANSION — `<>` even resolves elsewhere in the assembly
// today, as a `notImplemented` door in `env/polyglot-stubs.ts`, so a naive free-variable
// walk over the macro's own body would not even catch it as unbound; a walk over what the
// macro EXPANDS TO (a use site like `(cut cons <> 1)`) would, wrongly, since `<>` there is
// a placeholder, not a variable reference.
//
// `macroAttribute: "opaque"` (§3.4's table lists `cut`/`cute` by name under the DEFAULT
// row, "placeholder tokens", as the canonical opaque case) — chosen, not left to the
// factory default by omission, because the reasoning is pack-specific and worth pinning:
//   - `<>`/`<...>` occupy what `cut`/`cute` need to be slot-selection SYNTAX at every
//     call site, not expression space — a call-site `<>` is never meant to be looked up
//     as a variable, so walking it as an ordinary reference (the "expression" attribute)
//     would report a legal program's placeholder as `unbound-symbol` — a guaranteed false
//     positive on §3.3a's own soundness bar, EXCEPT it happens to resolve today (the
//     polyglot-stubs door), which would make it worse: a silently-wrong `bound-to-door`
//     diagnostic pointing at an unrelated capability instead of a clean pass.
//   - `<>`/`<...>` are also not FORMALS the way `and-let*`'s claws or `receive`'s
//     multiple-value list are (`"binder"`) — they don't bind a name into a body scope at
//     all; they are consumed positionally by the macro's OWN expander and never appear,
//     bound or free, in the expansion's own body. There is no binding-aware walker this
//     pack is waiting on the way a `"binder"` declaration would imply.
//   - "opaque" is therefore the honest, not merely the safe-default, classification: the
//     call-site interior (everything between `cut`'s parens) is genuinely NOT expression
//     space for `<>`/`<...>` positions, so the walker must contribute nothing from it to
//     any bucket — under-report, never guess (§3.3's own rule).
// Bake-time note: the §2.1 FV LAW itself never walks a `symbol.defineSyntax` BODY at all
// (`define-bake.ts`'s bake loop explicitly limits the FV/forward-ref check to
// `def.kind === "define"` — a macro body's free names would name the EXPANSION env, a
// different question, §1.1) — so `<>`/`<...>` inside cut/cute's OWN implementation never
// reach that check either way. `macroAttribute` is consumed by the SEPARATE §3 static
// validation pass (`validateProgram`/`collectReferences`), which walks PROGRAM call
// sites of `cut`/`cute`, not their definitions — that is where the opaque firewall does
// its work (pinned: `src/__tests__/laws/static-validation.law.test.ts` LAW 4's
// "`cut`'s `<>` placeholder does not report" row, plus this pack's own dedicated test
// file, `src/env/srfi/__tests__/srfi-26-symbol-define.test.ts`).
//
// No other top-level defines exist in this pack (verified: the pre-migration prelude was
// exactly these two `define-macro` forms, §4.1's census) — nothing to convert to
// `symbol.define`, and no `deps:` edge is needed (neither body references a name outside
// SPECIAL_FORMS ∪ KEYWORD_SYNTAX + the r7rs primitives every capability gets through
// universal `core`/`r7rs` rooting).
import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";

export default new EnvCapability("scheme/srfi-26", {
  symbols: {
    cut: symbol.defineSyntax`cut: specialize parameters without currying (SRFI-26). \`<>\` is a positional slot, \`<...>\` a (final) rest slot — \`(cut f a <>)\` builds (lambda (g) (f a g)); \`(cut f <...>)\` builds (lambda (. g) (apply f g)). Non-slot subexpressions stay in the body and re-evaluate on every call (contrast cute). Slot params are gensym'd so a non-slot expr referencing a same-named variable can't be captured.`(
      `(lambda items
         (let loop ((items items) (params '()) (call '()) (restp #f))
           (cond
             ((null? items)
              (if restp
                  \`(lambda ,(append (reverse params) restp) (apply ,@(reverse call) ,restp))
                  \`(lambda ,(reverse params) (,@(reverse call)))))
             ((and (symbol? (car items)) (equal? (symbol->string (car items)) "<>"))
              (let ((g (gensym))) (loop (cdr items) (cons g params) (cons g call) restp)))
             ((and (symbol? (car items)) (equal? (symbol->string (car items)) "<...>"))
              (loop (cdr items) params call (gensym)))
             (else (loop (cdr items) params (cons (car items) call) restp)))))`,
      { macroAttribute: "opaque" },
    ),
    cute: symbol.defineSyntax`cute: like cut, but lifts every non-slot subexpression into a let so it evaluates EXACTLY ONCE at specialization time (SRFI-26's whole point: \`(cute f (expensive) <>)\` calls (expensive) once, not on every call).`(
      `(lambda items
         (let loop ((items items) (params '()) (call '()) (binds '()) (restp #f))
           (cond
             ((null? items)
              (let ((lam (if restp
                             \`(lambda ,(append (reverse params) restp) (apply ,@(reverse call) ,restp))
                             \`(lambda ,(reverse params) (,@(reverse call))))))
                (if (null? binds) lam \`(let ,(reverse binds) ,lam))))
             ((and (symbol? (car items)) (equal? (symbol->string (car items)) "<>"))
              (let ((g (gensym))) (loop (cdr items) (cons g params) (cons g call) binds restp)))
             ((and (symbol? (car items)) (equal? (symbol->string (car items)) "<...>"))
              (loop (cdr items) params call binds (gensym)))
             (else (let ((t (gensym))) (loop (cdr items) params (cons t call) (cons (list t (car items)) binds) restp))))))`,
      { macroAttribute: "opaque" },
    ),
  },
});
