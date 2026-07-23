// SRFI-26 — cut / cute (parameter specialization). Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via `allSrfi`) and evals it
// (via initBridge's assembleEnv), so this module is the sole definition site.
//
// `cut`/`cute` introduce the placeholder tokens `<>` (a positional slot) and
// `<...>` (a final rest slot) inside their EXPANSION — `<>` even resolves
// elsewhere in the assembly today, as a `notImplemented` door in
// `env/polyglot/polyglot-stubs.ts`, so a naive free-variable walk over the macro's own
// body would not even catch it as unbound; a walk over what the macro EXPANDS TO
// (a use site like `(cut cons <> 1)`) would, wrongly, since `<>` there is a
// placeholder, not a variable reference.
//
// `macroAttribute: "opaque"` is chosen deliberately here, not left to the
// factory default by omission:
//   - `<>`/`<...>` occupy what `cut`/`cute` need to be slot-selection SYNTAX at
//     every call site, not expression space — a call-site `<>` is never meant
//     to be looked up as a variable, so walking it as an ordinary reference
//     (the "expression" attribute) would report a legal program's placeholder
//     as `unbound-symbol` — a false positive, made worse by the fact that `<>`
//     happens to resolve today (the polyglot-stubs door), which would produce a
//     silently-wrong `bound-to-door` diagnostic pointing at an unrelated
//     capability instead of a clean pass.
//   - `<>`/`<...>` are also not FORMALS the way `and-let*`'s claws or
//     `receive`'s multiple-value list are ("binder") — they don't bind a name
//     into a body scope at all; they are consumed positionally by the macro's
//     OWN expander and never appear, bound or free, in the expansion's own
//     body. There is no binding-aware walker this pack is waiting on the way a
//     "binder" declaration would imply.
//   - "opaque" is therefore the honest, not merely the safe-default,
//     classification: the call-site interior (everything between `cut`'s
//     parens) is genuinely NOT expression space for `<>`/`<...>` positions, so
//     the walker must contribute nothing from it to any bucket — under-report,
//     never guess.
// The bake-time free-variable check never walks a `symbol.defineSyntax` BODY at
// all (`define-bake.ts`'s bake loop limits the FV/forward-ref check to
// `def.kind === "define"` — a macro body's free names would name the EXPANSION
// env, a different question) — so `<>`/`<...>` inside cut/cute's OWN
// implementation never reach that check either way. `macroAttribute` is
// consumed by the SEPARATE static validation pass (`validateProgram`/
// `collectReferences`), which walks PROGRAM call sites of `cut`/`cute`, not
// their definitions — that is where the opaque firewall does its work.
//
// No other top-level defines exist in this pack — nothing to convert to
// `symbol.define`.
//
// CORRECTION (Stage C Cut 4, docs/plans/stage-c-corpse-deletion.md): the ORIGINAL claim here
// ("no deps: edge is needed... the r7rs primitives every capability gets through universal
// core/r7rs rooting") was WRONG — that "universal rooting" was the pre-Cut-2 two-phase
// bootstrap's own ambient-parenting luck (NATIVE_PACKS bound onto `global_env` before ANY
// BASE_PACKS prelude ran), not a real guarantee. Under the self-hosted `buildVocabulary`
// (env/vocabulary.ts), a `symbol.defineSyntax` macro's transformer LAMBDA is baked into a
// CLOSURE over that build's own null-rooted `bakeEnv` — permanently, since a scheme closure
// resolves free names against exactly the scope it captured, lazily, at CALL time (macro
// EXPANSION time here), never re-parented onto whatever "real" env the resulting Vocabulary is
// later bound into. `cut`/`cute`'s bodies call `null?`/`pair?`/`symbol?`/`equal?` — NATIVE_PACKS
// names (`car`/`cdr` alone would need no dep, per the resolver-synth cxr allowlist
// `define-bake.ts` carries — but `equal?`/`symbol?`/`null?`/`pair?` are NOT cxr-shaped and carry
// no such allowlist entry) — so a `buildVocabulary` closure that doesn't ALSO include
// `equality` genuinely fails at macro-expansion time with an unbound-variable error, harmless
// in every REAL run (production always folds `BASE_ROSTER`, which includes `equality`
// transitively) but a real gap for any STANDALONE build of this one pack (found via
// `srfi-palette.test.ts`'s per-pack `buildVocabulary([cap], ...)` fixture). `deps: [equality]`
// converts the same "universal rooting" assumption every sibling SRFI pack in this file's own
// migration wave (srfi-128/-189/-235, see their own headers) already had to convert into a
// declared, checked edge. `deps: [lists]` too: both transformers also call `append`/`reverse`
// (scheme/lists — `cons`/`car`/`cdr`'s own quasiquote-driven list construction resolves the
// SAME way `symbol.define`'s cxr allowlist covers `car`/`cdr`, but `append`/`reverse`/`cons` as
// ordinary procedure calls are NOT cxr-shaped and need the real dep).
//
// NOT `deps: [core]`, deliberately: both transformers also call `gensym` (`scheme/core`), but
// `core` is base-packs.ts's OWN documented "precedence floor" (array position 0 — "everything
// else expands against it") — a real, checked `deps` edge onto it (dependent-before-dependency)
// would require repositioning `core` itself in `BASE_PACKS`, contradicting its floor role and
// the array's whole existing order (verified empirically: adding it breaks the suite via
// `AssembleLinearizationError`). `core`'s free availability is exactly the "universal
// core/r7rs rooting" the file's original comment named — real, unlike the `equality`/`lists`
// claim, precisely BECAUSE `core` is positionally guaranteed first in every real assembly,
// never merely deps-reachable. A capability that needs `gensym` STANDALONE (bypassing
// `BASE_PACKS`'s own positional guarantee, e.g. a unit test) must fold `core` in itself.
import { EnvCapability } from "../../common/capability.js";
import equality from "../r7rs/equality.js";
import lists from "../r7rs/lists.js";

export default EnvCapability.define("scheme/srfi-26", {
  deps: [equality, lists],
  symbols: (symbol) => ({
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
  }),
});
