// @here.build/arrival/r7rs — the R7RS-small derived-syntax palette.
//
// The portable Scheme control forms arrival supports as macros, expanded from
// the small special-form core, split per R7RS section into one EnvCapability
// each (mirroring env/srfi/). Importable from ONE subpath:
//   import { binding, exceptions, allR7rs } from "./r7rs/index.js";
//
// Each part is a module-singleton `EnvCapability`. Assembly is order-independent
// at pack-apply time: every form is a `define-macro`, expanded at CALL time
// against the fully-assembled shared userEnv — so cross-part references
// (guard→cond/raise) resolve regardless of pack order. cond/case/when/unless are
// NOT here — they are evaluator SPECIAL FORMS (evalCond/evalCase/evalWhen/
// evalUnless), so guard's expansion to `(cond …)` needs no pack dependency.
//
// R7RS omissions do NOT live in a central manifest — each is a real
// `symbol.notImplemented` errors-as-door INSIDE the pack that owns that part of
// the spec: the value-mutators with their type packs (r7rs/strings, r7rs/vectors,
// r7rs/lists, r7rs/bytevectors); the §6.10/§4.2.5/§4.2.6 control + dynamics +
// laziness omissions in `control.ts`; the §6.13/§6.14 host-interface omissions
// in `host.ts`.

import syntax from "./syntax.js";
import binding from "./binding.js";
import exceptions from "./exceptions.js";
import lists from "./lists.js";
import control from "./control.js";
import host from "./host.js";

export { default as syntax } from "./syntax.js";
export { default as binding } from "./binding.js";
export { default as exceptions } from "./exceptions.js";
export { default as lists } from "./lists.js";
export { default as control } from "./control.js";
export { default as host } from "./host.js";

/** The whole R7RS derived-syntax set — assemble all, or `.filter()` a subset. */
export const allR7rs = [syntax, binding, exceptions, lists, control, host] as const;
