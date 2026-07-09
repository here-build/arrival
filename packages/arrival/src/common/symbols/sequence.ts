// symbol.sequence — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js.

import {
  assertProvenanceRoleShape,
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
    const inSchema = normalizeVector(contract.input);
    const outSchema = normalizeVector(contract.output);
    // Resolve the declared role (default "pipe" — see Contract.provenance); capability.ts
    // reads it straight off this def (`def.provenance`) and stamps it onto the bound
    // ANativeProcedure (`provenanceRole`), replacing the retired `.fanout` marker that used
    // to ride the `run` fn itself.
    const provenance = contract.provenance ?? "pipe";
    assertProvenanceRoleShape(name, provenance, inSchema, outSchema);
    return {
      kind: "sequence",
      name,
      doc,
      in: inSchema,
      out: outSchema,
      // Erased to the def's stored shape — SequenceSymbolDef.run is deliberately non-generic
      // (the same erasure boundary rosetta.ts's `rawImpl` crosses). By construction, the sliced
      // args array always matches `DecodedArgs<I,"scheme">`.
      run: function (this: CallCtx, ...args: unknown[]) {
        return impl(args as DecodedArgs<I, "scheme">, this.runCtx);
      } as SequenceSymbolDef["run"],
      type: contract.type,
      provenance,
    };
  };
}
