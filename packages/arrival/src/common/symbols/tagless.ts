// symbol.tagless — a dispatcher to the receiver's own tagless-final term method. One
// of the per-tag factory files re-assembled into the `symbol` namespace by `./index.ts`;
// the shared types + helpers live in `./_bake.js`.

import * as z from "../scheme-zod.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { asEvalContext, describeReceiver, parseNameDoc, resolveMethod, type TaglessSymbolDef } from "./_bake.js";
import { tf, type TaglessOp } from "../../values/tagless-final.js";

/** Tagless host op — `symbol.tagless\`name: doc\`` binds a symbol that dispatches to the receiver's
 *  own `arrival/tagless-final/name` term method (the LAST scheme arg is the receiver; a missing
 *  method THROWS — the hard op, dual of the graceful `taglessGuard`). The name is supplied at the
 *  call site directly — NO central Record. Tagless dispatch is pure (NO JS impl): the real per-op
 *  types/impls live as `arrival/tagless-final/<name>` members on the terms (primitives/AValue.ts),
 *  the source of truth — `tagless-final.ts` derives the op-name type from there. The name is free
 *  here (mirrors `taglessGuard`); the algebra, not this binder, is the completeness gate. */
export function tagless(tpl: TemplateStringsArray, ...sub: unknown[]): TaglessSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  const run = async (...args: unknown[]): Promise<unknown> => {
    // Strip the evaluator-appended ctx iff the trailing arg looks like one (the shared
    // `asEvalContext` probe). Unlike native, tagless is ctx-AWARE — it needs the run for the method.
    const ctx = asEvalContext(args[args.length - 1]);
    const schemeArgs = ctx === undefined ? args : args.slice(0, -1);
    const runCtx = ctx?.runCtx ?? CONSTANT_CTX;
    const receiver = schemeArgs[schemeArgs.length - 1];
    const leading = schemeArgs.slice(0, -1);
    // `name` is the pack author's template-literal string; the DECLARED op set is the type
    // `TaglessOp` (derived from AValue's members). Assert at this one boundary — a typo'd op
    // resolves no method and lands on the teaching error / graceful #f below, so the failure
    // mode is handled at runtime; the assert only restores the key-builder's type flow.
    const fn = resolveMethod(receiver, tf(name as TaglessOp));
    TypeError.invariant(
      fn !== undefined,
      () =>
        `${name}: the ${describeReceiver(receiver)} primitive does not support \`${name}\` ` +
        `(it declares no ${tf(name as TaglessOp)}). A tagless op lives ON the arrival terms whose algebra implements it.`,
    );
    return await fn.call(receiver, ...leading, runCtx);
  };
  // No contract: the placeholder harvest surface is fixed (like `taglessGuard`). The real
  // per-op types live on the receiver's `arrival/tagless-final/<name>` member (AValue), the
  // source of truth — `tagless-final.ts` derives the op-name type from there.
  return { kind: "tagless", name, doc, in: z.array(z.value), out: z.value, run };
}
