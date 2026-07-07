// symbol.sequence — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js.

import {
  CallCtx,
  type Contract,
  DecodedArgs,
  DecodedReturn,
  MaybePromise,
  normalizeVector,
  parseNameDoc,
  type SequenceImpl,
  type SequenceSymbolDef,
  type VectorSpec,
} from "./_bake.js";

/** Ctx-aware host op — impl gets (schemeArgs, runCtx). For kernel-logic-bearing ops
 *  (heap-charge, run-strict) that aren't pure per-receiver dispatch. `impl`'s args/return are
 *  checked against the contract via `SequenceImpl<I,O>`, the same erasure boundary `inputRest`
 *  closes for native/rosetta. */
export function sequence(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec>(
    contract: Contract<I, O>,
    impl: SequenceImpl<I, O>,
  ): SequenceSymbolDef => {
    // Erase here: TS can't statically match a raw sliced-args array to `impl`'s own
    // `DecodedArgs<I>` tuple. By construction (the contract), it always matches.
    const run = function (this: CallCtx, ...args: DecodedArgs<I, "scheme">) {
      return impl(args, this.runCtx);
    };
    // Stamp fanout on the bound fn: cell-less packs bind `def.run` raw, so the lineage
    // classifier reads `.fanout` off `env.get(op)` directly (the SPECULATE shape, minus the Symbol).
    if (contract.fanout) (run as { fanout?: boolean }).fanout = true;
    return {
      kind: "sequence",
      name,
      doc,
      in: normalizeVector(contract.input),
      out: normalizeVector(contract.output),
      // Erased to the def's stored shape — SequenceSymbolDef.run is deliberately non-generic
      // (the same erasure boundary rosetta.ts's `rawImpl` crosses). By construction, the sliced
      // args array always matches `DecodedArgs<I,"scheme">`.
      run: Object.assign(
        function (this: CallCtx, ...args: unknown[]) {
          return impl(args as DecodedArgs<I, "scheme">, this.runCtx);
        },
        { fanout: true },
      ) as SequenceSymbolDef["run"],
      type: contract.type,
    };
  };
}
