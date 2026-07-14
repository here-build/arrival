// symbol.sequence — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js.

import {
  assertCacheClassShape,
  assertProvenanceRoleShape,
  extractCallbackRoles,
  CallCtx,
  type Contract,
  DecodedArgs,
  DecodedReturn,
  MaybePromise,
  normalizeVector,
  parseNameDoc,
  type MetadataRecord,
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
    opts: { metadata?: MetadataRecord } = {},
  ): SequenceSymbolDef => {
    const inSchema = normalizeVector(contract.input);
    const outSchema = normalizeVector(contract.output);
    // Resolve the declared role (default "pipe" — see Contract.provenance); capability.ts
    // reads it straight off this def (`def.provenance`) and stamps it onto the bound
    // ANativeProcedure (`provenanceRole`).
    const provenance = contract.provenance ?? "pipe";
    assertProvenanceRoleShape(name, provenance, inSchema, outSchema);
    // The EXPLICIT cache class (Ruling A) — no kind default: absent = regenerateable. See
    // native.ts's note: interception is rosetta-membrane-only; the field rides uniformly.
    const cacheClass = contract.cacheClass;
    assertCacheClassShape(name, cacheClass, inSchema, outSchema);
    // Per-lambda-arm callback roles: shape extraction + the declared override, drift-door
    // checked — see extractCallbackRoles in _bake.ts.
    const callbackRoles = extractCallbackRoles(name, provenance, inSchema, outSchema, contract.callbackRoles);
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
      cacheClass,
      callbackRoles,
      // Compiler-facing fields (constitution §4.1) — carried through AUTHORED (the
      // harvest row resolves refPolicy's "shim" default); inert to the interpreter.
      emit: contract.emit,
      narrows: contract.narrows,
      refPolicy: contract.refPolicy,
      // The extension bag — data only; dynamic fields resolve at read time, never at bake.
      metadata: opts.metadata,
    };
  };
}
