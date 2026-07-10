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
// SINGLE SOURCE: this module is the sole definition site — the three forms bind
// as ordinary `symbols` entries now (W4 prelude-death migration, docs/working-
// proposals/symbol-define-static-program-validation.md §4.2): no separate
// `prelude` blob, no second assembly-time evaluation pass.
//
// MIGRATION NOTE (W4-H2b): this pack's entire former `prelude` was THREE
// `define-macro` forms and nothing else (zero `symbol.define`-shaped value/
// procedure defines — the same shape as r7rs/binding's H1 migration, whose
// prelude was two `define-macro` forms). All three mechanically decompose 1:1
// (`(define-macro (name . args) body…)` → `(lambda args body…)`, §4.2 Pass 1)
// into `symbol.defineSyntax` below. No Pass 2 (contract authoring) applies:
// `symbol.defineSyntax` is contract-free by construction (§1.1).
//
// macroAttribute (§3.4's ternary) — ALL THREE are "binder", not "expression",
// despite each one's whole job being to bind an EXPRESSION (a transformer) to a
// name. The reason is the FIRST argument position, not the second:
//   • `define-syntax`'s `name` mirrors `define`'s own name slot exactly (it is
//     the alias's whole point, header above) — free-vars.ts's native "define"
//     arm explicitly EXCLUDES the bound name from FV (introduced, not
//     referenced, §2.1's modeled-forms list). `define-syntax` is a MACRO alias
//     of that native form, invisible to that same switch (macro heads fall to
//     `default: break`, walked as an ordinary application unless an attribute
//     upgrades them, §3.4) — so an "expression" walk would look `name` up as
//     an ordinary variable REFERENCE and report it unbound on every legal
//     `(define-syntax my-macro (lambda (form) …))`: `my-macro` is freshly
//     introduced, never bound before this point. Guaranteed false positive —
//     exactly the failure mode rev 2's boolean→ternary fix exists to close.
//   • `let-syntax` / `letrec-syntax`'s `vars` is the SAME shape as `let`'s own
//     bindings list (`((name1 transformer1) (name2 transformer2) …)`) —
//     `let`/`letrec` are BOTH natively modeled special forms (§2.1), but
//     `let-syntax`/`letrec-syntax` are MACROS, unmodeled by that switch. An
//     "expression" walk of `vars` would surface every binding NAME (not just
//     the transformer exprs) as a free reference, and `body`'s references to
//     those same names — the entire point of the form — would ALSO report
//     unbound. This is the canonical let-values/let*-values binder shape
//     (§3.4's worked example, r7rs/binding H1), reproduced one level up:
//     binding TRANSFORMERS instead of values.
// Per §3.4, "binder" is firewalled identically to "opaque" until a binding-
// aware macro walker lands (the interior — including the second, genuinely-
// expression-space argument in each form — is invisible to the static pass
// either way today) — the declaration is the honest classification these
// forms actually have, not a behavior change from opaque.

import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";

/** scheme/r7rs/syntax — the R7RS macro-binding forms as guardless value-binding aliases. */
export default new EnvCapability("scheme/r7rs/syntax", {
  symbols: {
    "define-syntax": symbol.defineSyntax`define-syntax: (define-syntax name expr) — R7RS §5.3, bind a transformer at top scope. Exact alias of \`define\` — arrival's transformers are first-class values, not a separate namespace.`(
      `(lambda (name expr)
         \`(define ,name ,expr))`,
      { macroAttribute: "binder" },
    ),

    "let-syntax": symbol.defineSyntax`let-syntax: (let-syntax ((name transformer) …) body …) — R7RS §4.3.1, bind transformers locally, non-recursively. Exact alias of \`let\` — non-recursive scoping falls out of let's own scoping math.`(
      `(lambda (vars . body)
         \`(let ,vars ,@body))`,
      { macroAttribute: "binder" },
    ),

    "letrec-syntax": symbol.defineSyntax`letrec-syntax: (letrec-syntax ((name transformer) …) body …) — R7RS §4.3.1, bind transformers locally, allowing mutual self-reference. Exact alias of \`letrec\` — recursive scoping falls out of letrec's own scoping math.`(
      `(lambda (vars . body)
         \`(letrec ,vars ,@body))`,
      { macroAttribute: "binder" },
    ),
  },
});
