// symbol.taglessGuard — a graceful predicate dispatcher (#f when the receiver declares
// no such method). One of the per-tag factory files re-assembled into the `symbol`
// namespace by `./index.ts`; the shared types + helpers live in `./_bake.js`.

import * as z from "../scheme-zod.js";
import { CONSTANT_CTX, type RunContext } from "../../values/primitives/RunContext.js";
import { parseNameDoc, resolveMethod, type TaglessGuardSymbolDef } from "./_bake.js";
import { tf, type TaglessOp } from "../../values/tagless-final.js";

/** A tagless GUARD binder — `symbol.taglessGuard\`name: doc\`` binds a predicate that dispatches
 *  to the receiver's own `arrival/tagless-final/name`, returning #f when it declares none. Unlike
 *  `tagless` (a Record keyed by the closed algebra), the name is FREE — a per-type predicate
 *  (`vector?`, `null?`-style), not a declared sequence op. */
export function taglessGuard(tpl: TemplateStringsArray, ...sub: unknown[]): TaglessGuardSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  // A `function`, NOT an arrow — same fix as `tagless.ts`: the evaluator hands ctx via
  // `this` for bare-fn dispatch; an arrow body can never read it.
  const run = async function (this: { ctx?: { runCtx?: RunContext } }, ...args: unknown[]): Promise<unknown> {
    const runCtx = this.ctx?.runCtx ?? CONSTANT_CTX;
    const schemeArgs = args;
    const receiver = schemeArgs[schemeArgs.length - 1];
    const leading = schemeArgs.slice(0, -1);
    // `name` is the pack author's template-literal string; the DECLARED op set is the type
    // `TaglessOp` (derived from AValue's members). Assert at this one boundary — a typo'd op
    // resolves no method and lands on the teaching error / graceful #f below, so the failure
    // mode is handled at runtime; the assert only restores the key-builder's type flow.
    const fn = resolveMethod(receiver, tf(name as TaglessOp));
    if (fn === undefined) return false; // graceful #f — the receiver simply can't answer
    return await fn.call(receiver, ...leading, runCtx);
  };
  return { kind: "tagless-guard", name, doc, in: z.array(z.value), out: z.value, run };
}
