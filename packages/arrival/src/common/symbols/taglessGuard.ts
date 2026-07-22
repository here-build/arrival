// symbol.taglessGuard — per-tag factory file assembled into `symbol` by ./index.ts;
// shared types live in ./_bake.js. docs/environments.md §SYMBOL-KINDS — the `tagless-guard` row
// (graceful #f when the receiver has no method; mints its verdict here, R8).

import * as z from "../scheme-zod.js";
import { CallCtx, parseNameDoc, resolveMethod, type ProvenanceRole, type TaglessGuardSymbolDef } from "./_bake.js";
import { tf, type TaglessOp } from "../../values/tagless-final.js";
import { mintVerdict } from "../../values/op-helpers.js";
import { ANativeProcedure } from "../../values/primitives/ACallable.js";
import { type SchemeValue } from "../../values/types.js";

/** A tagless GUARD binder — `symbol.taglessGuard\`name: doc\`` binds a predicate that dispatches
 *  to the receiver's own `arrival/tagless-final/name`, returning #f when it declares none. Unlike
 *  `tagless` (a Record keyed by the closed algebra), the name is FREE — a per-type predicate
 *  (`vector?`, `null?`-style), not a declared sequence op.
 *
 *  R8 mint (op-helpers.mintVerdict): `out: z.value` below is representation-blind (no codec
 *  crossing), and capability.ts binds a tagless-guard's `run` directly (no generic
 *  encode/mint step) — so THIS is the one boxing point for every taglessGuard predicate
 *  (`pair?`/`symbol?`/`char?`/`vector?`), whose own `arrival/tagless-final/*?` algebra
 *  methods answer with a raw JS boolean (an internal instruction, not the bound Scheme
 *  value — P7: the class stays the representation authority, the wrap layer mints). */
export function taglessGuard(tpl: TemplateStringsArray, ...sub: unknown[]): ANativeProcedure {
  const { name, doc } = parseNameDoc(tpl, sub);
  // Same ctx-via-`this` dispatch as `tagless` (function-not-arrow; receiver = last scheme arg;
  // free `name` cast to TaglessOp at this one boundary) — see ./tagless.ts. Divergence: a
  // receiver that declares no such method answers #f here, where `tagless` throws.
  const run = async function (this: CallCtx, ...args: unknown[]): Promise<unknown> {
    const runCtx = this.runCtx;
    const schemeArgs = args;
    const receiver = schemeArgs[schemeArgs.length - 1];
    const leading = schemeArgs.slice(0, -1);
    const fn = resolveMethod(receiver, tf(name as TaglessOp));
    if (fn === undefined) return mintVerdict([receiver], false); // graceful #f — receiver can't answer
    const verdict = await fn.call(receiver, ...leading, runCtx);
    return mintVerdict([receiver, ...leading], typeof verdict === "boolean" ? verdict : Boolean(verdict));
  };
  // No `Contract` param here (see `TaglessGuardSymbolDef.provenance`'s doc) — always "pipe".
  const def: TaglessGuardSymbolDef = {
    kind: "tagless-guard",
    name,
    doc,
    in: z.array(z.value),
    out: z.value,
    run,
    provenance: "pipe",
  };
  // Stage A2 — mint the ANativeProcedure directly (tagless-guard shares native's class per D1).
  const proc = new ANativeProcedure({
    name,
    arity: { min: 0, max: null },
    contract: def,
    impl: (args, callCtx) => run.apply(callCtx, args) as Promise<SchemeValue>,
  });
  (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = "pipe";
  return proc;
}
