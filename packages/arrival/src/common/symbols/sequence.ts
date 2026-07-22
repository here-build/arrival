// symbol.sequence — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js. docs/environments.md §SYMBOL-KINDS — the `sequence` row (ctx-aware
// op: impl gets scheme args + the run's RunContext, for kernel-logic-bearing ops).

import { ANativeProcedure } from "../../values/primitives/ACallable.js";
import { type SchemeValue } from "../../values/types.js";
import {
  assertCacheClassShape,
  assertProvenanceRoleShape,
  extractCallbackRoles,
  type CacheClass,
  type CallbackRoles,
  CallCtx,
  type Contract,
  DecodedArgs,
  DecodedReturn,
  MaybePromise,
  normalizeVector,
  parseNameDoc,
  type MetadataRecord,
  type ProvenanceRole,
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
  ): ANativeProcedure => {
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
    const def: SequenceSymbolDef = {
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
    // Stage A2 — mint the ANativeProcedure directly (sequence shares native's class per D1:
    // kind lives on the CONTRACT, not the runtime class). `run` is the complete ctx-aware
    // wrapper the bind loop used to adapt via `bakedImpl`.
    const rawRun = def.run as (this: CallCtx, ...args: unknown[]) => Promise<unknown>;
    const proc = new ANativeProcedure({
      name,
      arity: { min: 0, max: null },
      contract: def,
      impl: (args, callCtx) => rawRun.apply(callCtx, args) as Promise<SchemeValue>,
    });
    (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = provenance;
    if (cacheClass !== undefined) (proc as { cacheClass?: CacheClass }).cacheClass = cacheClass;
    if (callbackRoles !== undefined) (proc as { callbackRoles?: CallbackRoles }).callbackRoles = callbackRoles;
    return proc;
  };
}
