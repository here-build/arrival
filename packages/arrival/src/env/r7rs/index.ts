// @here.build/arrival/r7rs — the R7RS-small derived-syntax palette.
//
// The portable Scheme control forms arrival supports as macros, expanded from
// the small special-form core, split per R7RS section into one EnvCapability
// each (mirroring env/srfi/). Importable from ONE subpath:
//   import { binding, exceptions, allR7rs } from "./r7rs/index.js";
//
// Each part is a module-singleton `EnvCapability`. Assembly is order-independent
// at pack-apply time: every form is a `define-macro`, expanded at CALL time
// against the fully-assembled shared userEnv — so the cross-part references
// (guard→cond/raise) resolve regardless of pack order. cond/case/when/unless are
// NOT here — they are evaluator SPECIAL FORMS (kernel keywords; evalCond/evalCase/
// evalWhen/evalUnless), so guard's expansion to `(cond …)` resolves to the kernel
// handler with no pack dependency.
//
// `_unimplemented.ts` is a pure manifest of the R7RS symbols arrival omits or
// defers; it ships no capability and is NOT part of allR7rs / BASE_PACKS.

import binding from "./binding.js";
import exceptions from "./exceptions.js";
import lists from "./lists.js";

export { default as binding } from "./binding.js";
export { default as exceptions } from "./exceptions.js";
export { default as lists } from "./lists.js";

/** The whole R7RS derived-syntax set — assemble all, or `.filter()` a subset. */
export const allR7rs = [binding, exceptions, lists] as const;
