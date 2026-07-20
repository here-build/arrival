// symbol.tagless — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js. docs/ASSEMBLY.md §SYMBOL-KINDS — the `tagless` row (no impl;
// dispatch to the operand's own term, receiver = last scheme arg, a missing method THROWS).

import * as z from "../scheme-zod.js";
import { CallCtx, describeReceiver, parseNameDoc, resolveMethod, type TaglessSymbolDef } from "./_bake.js";
import { tf, type TaglessOp } from "../../values/tagless-final.js";
import { attachOffendingValue, TaglessProtocolError } from "../../errors.js";

/** Tagless host op — `symbol.tagless\`name: doc\`` binds a symbol that dispatches to the receiver's
 *  own `arrival/tagless-final/name` term method (the LAST scheme arg is the receiver; a missing
 *  method THROWS — the hard op, dual of the graceful `taglessGuard`). No central Record and no JS
 *  impl: the real per-op types/impls live as `arrival/tagless-final/<name>` members on the terms
 *  (primitives/AValue.ts), the source of truth — `tagless-final.ts` derives the op-name type from
 *  there. The algebra, not this binder, is the completeness gate. */
export function tagless(tpl: TemplateStringsArray, ...sub: unknown[]): TaglessSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  // `function`, not arrow: tagless is ctx-aware (needs runCtx for the receiver's method),
  // and the evaluator hands `CallCtx` via `this`, which an arrow body can never read.
  const run = async function (this: CallCtx, ...args: unknown[]): Promise<unknown> {
    const runCtx = this.runCtx;
    const schemeArgs = args;
    const receiver = schemeArgs[schemeArgs.length - 1];
    const leading = schemeArgs.slice(0, -1);
    // `name` is a free author string; cast to the declared `TaglessOp` union at this one
    // boundary. A typo'd op just resolves no method and hits the teaching throw below.
    const fn = resolveMethod(receiver, tf(name as TaglessOp));
    // MODEL-REACHABLE door — (car 1) lands here, so per Rule 0 this throws plain: an
    // `invariant` would prefix "Invariant failed: ", which reads like an engine bug
    // rather than a program mistake (see the not-callable doors note in evaluator.ts).
    if (fn === undefined) {
      throw attachOffendingValue(
        new TaglessProtocolError(name, describeReceiver(receiver), tf(name as TaglessOp)),
        receiver,
      );
    }
    return await fn.call(receiver, ...leading, runCtx);
  };
  // No `Contract` param here (see `TaglessSymbolDef.provenance`'s doc) — always "pipe".
  return { kind: "tagless", name, doc, in: z.array(z.value), out: z.value, run, provenance: "pipe" };
}
