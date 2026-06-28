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
  prelude: ``,
});
