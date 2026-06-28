// @here.build/arrival/arrival-extensions — arrival's residual core extensions pack.
//
// After the husk dissolution this pack holds only the genuinely arrival-specific
// procedures that belong nowhere in R7RS / SRFI / polyglot:
//   • range             — an integer list [0, stop), derived over SRFI-1 `iota`.
//   • first? / first-or — safe head accessors (crash-avoidance over (car '())).
//
// Everything else moved to its genuine home: symbol->string / string->symbol → the
// r7rs equality pack; remove → SRFI-1; complement / constantly / always / curry →
// SRFI-235; and 13 dead husks (once / flip / n-ary / unary / binary / key? /
// key->string / string-join / string-split / tree-map / pair-map / nth-pair /
// symbol-append) were deleted outright.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack and evals its prelude, so this
// module is the sole definition site. Prelude-only now — nothing here touches a host
// type, so no native symbols remain.
import { EnvCapability } from "../common/capability.js";

export default new EnvCapability("arrival/core-extensions", {
  prelude: `
    ;; -----------------------------------------------------------------------------
    ;; range — arrival's [0, stop) integer list
    ;; -----------------------------------------------------------------------------
    ;; Derived over SRFI-1 \`iota\` (co-resident in the assembled base): (range stop) is
    ;; exactly (iota stop) = 0 .. stop-1. The former native impl was lossy past the JS
    ;; safe-integer ceiling and redundant with iota; single-arg is the only form used in
    ;; practice (every spec site calls (range n)). The name is load-bearing — kept.
    (define (range stop) (iota stop))

    ;; -----------------------------------------------------------------------------
    ;; Arrival safe head accessors
    ;; -----------------------------------------------------------------------------
    ;; The dominant avoidable crash in generated Scheme is (car (filter …)) on an empty
    ;; match — (car '()) throws. These give a head accessor that CANNOT crash. They stay
    ;; here (not SRFI-1) because they are arrival-specific crash-avoidance.
    ;;
    ;; first? — head of a list, or #f when empty. (first? '()) => #f, never a crash.
    (define (first? xs) (if (pair? xs) (car xs) #f))
    ;; first-or — head of a list, or a supplied default when empty.
    (define (first-or xs default) (if (pair? xs) (car xs) default))
`,
});
