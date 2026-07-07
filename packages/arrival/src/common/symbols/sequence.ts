// symbol.sequence — a ctx-aware op whose impl gets (schemeArgs, runCtx). One of the
// per-tag factory files re-assembled into the `symbol` namespace by `./index.ts`; the
// shared types + helpers live in `./_bake.js`.

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
    const run = function (this: CallCtx, ...args: DecodedArgs<I, "scheme">) {
      return impl(args, this.runCtx);
    };
    // `fanout: true` → stamp the bound fn (capability binds def.run; cell-less packs bind it raw,
    // so the classifier reads `.fanout` off env.get(op) — the SPECULATE shape, minus the Symbol).
    if (contract.fanout) (run as { fanout?: boolean }).fanout = true;
    return {
      kind: "sequence",
      name,
      doc,
      in: normalizeVector(contract.input),
      out: normalizeVector(contract.output),
      // Erased to the def's stored shape (SequenceSymbolDef.run is a discriminated-union
      // member — deliberately non-generic, the same runtime-erasure boundary rosetta.ts's
      // `run` crosses — `rawImpl`). By construction (the contract), the sliced args array
      // always matches `DecodedArgs<I,"scheme">`.
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
