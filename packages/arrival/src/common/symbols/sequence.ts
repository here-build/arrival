// symbol.sequence — a ctx-aware op whose impl gets (schemeArgs, runCtx). One of the
// per-tag factory files re-assembled into the `symbol` namespace by `./index.ts`; the
// shared types + helpers live in `./_bake.js`.

import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import {
  asEvalContext,
  normalizeVector,
  parseNameDoc,
  type Contract,
  type SequenceImpl,
  type SequenceSymbolDef,
  type VectorSpec,
} from "./_bake.js";

/** Ctx-aware host op — the impl gets (schemeArgs, runCtx). For kernel-logic-bearing ops
 *  (heap-charge, run-strict) that aren't pure per-receiver dispatch. `impl`'s args/return are
 *  checked against the contract via `SequenceImpl<I,O>` (was raw `unknown[]`/`unknown` — the
 *  same erasure gap `inputRest` closed for native/rosetta). */
export function sequence(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec>(
    contract: Contract<I, O>,
    impl: SequenceImpl<I, O>,
  ): SequenceSymbolDef => {
    // `run` dispatches at runtime against a raw sliced-args array, which TS can't statically
    // match to `impl`'s own `DecodedArgs<I>` tuple — erase here, once, the same boundary
    // `rosetta.ts`'s `run` crosses. By construction (the contract), the array always matches.
    const rawImpl = impl as (...args: unknown[]) => unknown;
    const run = async (...args: unknown[]): Promise<unknown> => {
      const ctx = asEvalContext(args[args.length - 1]);
      const schemeArgs = ctx === undefined ? args : args.slice(0, -1);
      const runCtx = ctx?.runCtx ?? CONSTANT_CTX;
      return await rawImpl(schemeArgs, runCtx);
    };
    (run as { __withCtx?: boolean }).__withCtx = true;
    // `fanout: true` → stamp the bound fn (capability binds def.run; cell-less packs bind it raw,
    // so the classifier reads `.fanout` off env.get(op) — the SPECULATE shape, minus the Symbol).
    if (contract.fanout) (run as { fanout?: boolean }).fanout = true;
    return {
      kind: "sequence",
      name,
      doc,
      in: normalizeVector(contract.input),
      out: normalizeVector(contract.output),
      run,
      type: contract.type,
    };
  };
}
