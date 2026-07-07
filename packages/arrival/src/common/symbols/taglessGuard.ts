// symbol.taglessGuard — per-tag factory file assembled into `symbol` by ./index.ts;
// shared types live in ./_bake.js.

import * as z from "../scheme-zod.js";
import { CallCtx, parseNameDoc, resolveMethod, type TaglessGuardSymbolDef } from "./_bake.js";
import { tf, type TaglessOp } from "../../values/tagless-final.js";

/** A tagless GUARD binder — `symbol.taglessGuard\`name: doc\`` binds a predicate that dispatches
 *  to the receiver's own `arrival/tagless-final/name`, returning #f when it declares none. Unlike
 *  `tagless` (a Record keyed by the closed algebra), the name is FREE — a per-type predicate
 *  (`vector?`, `null?`-style), not a declared sequence op. */
export function taglessGuard(tpl: TemplateStringsArray, ...sub: unknown[]): TaglessGuardSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  // `function`, not arrow: the evaluator hands `CallCtx` via `this` for bare-fn dispatch,
  // which an arrow body can never read.
  const run = async function (this: CallCtx, ...args: unknown[]): Promise<unknown> {
    const runCtx = this.runCtx;
    const schemeArgs = args;
    const receiver = schemeArgs[schemeArgs.length - 1];
    const leading = schemeArgs.slice(0, -1);
    // `name` is a free author string; cast to the declared `TaglessOp` union at this one
    // boundary. A typo'd op just resolves no method and falls to the #f below.
    const fn = resolveMethod(receiver, tf(name as TaglessOp));
    if (fn === undefined) return false; // graceful #f — the receiver simply can't answer
    return await fn.call(receiver, ...leading, runCtx);
  };
  return { kind: "tagless-guard", name, doc, in: z.array(z.value), out: z.value, run };
}
