// symbol.taglessGuard — a graceful predicate dispatcher (#f when the receiver declares
// no such method). One of the per-tag factory files re-assembled into the `symbol`
// namespace by `./index.ts`; the shared types + helpers live in `./_bake.js`.

import * as z from "../scheme-zod.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { asEvalContext, parseNameDoc, resolveMethod, type TaglessGuardSymbolDef } from "./_bake.js";

/** A tagless GUARD binder — `symbol.taglessGuard\`name: doc\`` binds a predicate that dispatches
 *  to the receiver's own `arrival/tagless-final/name`, returning #f when it declares none. Unlike
 *  `tagless` (a Record keyed by the closed algebra), the name is FREE — a per-type predicate
 *  (`vector?`, `null?`-style), not a declared sequence op. */
export function taglessGuard(tpl: TemplateStringsArray, ...sub: unknown[]): TaglessGuardSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  const method = `arrival/tagless-final/${name}`;
  const run = async (...args: unknown[]): Promise<unknown> => {
    const ctx = asEvalContext(args[args.length - 1]);
    const schemeArgs = ctx === undefined ? args : args.slice(0, -1);
    const runCtx = ctx?.runCtx ?? CONSTANT_CTX;
    const receiver = schemeArgs[schemeArgs.length - 1];
    const leading = schemeArgs.slice(0, -1);
    const fn = resolveMethod(receiver, method);
    if (fn === undefined) return false; // graceful #f — the receiver simply can't answer
    return await fn.call(receiver, ...leading, runCtx);
  };
  return { kind: "tagless-guard", name, doc, in: z.array(z.value), out: z.value, run };
}
