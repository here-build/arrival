// symbol.native — contour host fn over scheme values (no validation, no codec crossing).
// Per-tag factory; shared types in ./_bake.js.
// docs/environments.md §SYMBOL-KINDS (native row), §CONTRACT (scheme face).
// Tagged template carries `name: doc`; returns a generic so TS infers contract then checks
// the impl against decoded types — wrong-typed impl is a compile error.

import { buildSlotAdopter } from "../../membrane/adopt-spine.js";
import { ANativeProcedure, type NativeSymbolDef } from "../../values/primitives/ANativeProcedure.js";
import { type SchemeValue } from "../../values/types.js";
import { type CallCtx } from "../../run/CallCtx.js";
import { assertCacheClassShape, assertProvenanceRoleShape, type ContourContract, extractCallbackRoles, normalizeInputVector, normalizeVector, parseNameDoc, type Impl, type MetadataRecord, type RestSpec, type VectorSpec } from "./_bake.js";
import { assertNoResourcePathProducers } from "../../run/resource-paths.js";

/** Native host fn over scheme values. Slot bans on ContourContract (`_bake.ts` §1.7). */
export function native(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: ContourContract<I, O, Rest>,
    impl: Impl<I, O, Rest, "scheme">,
    opts: { metadata?: MetadataRecord } = {},
  ): ANativeProcedure => {
    assertNoResourcePathProducers(name, "native", contract as { queries?: unknown; effects?: unknown });
    const inSchema = normalizeInputVector(contract.input, contract.inputRest);
    const outSchema = normalizeVector(contract.output);
    const provenance = contract.provenance ?? "pipe";
    assertProvenanceRoleShape(name, provenance, inSchema, outSchema);
    const cacheClass = contract.cacheClass;
    assertCacheClassShape(name, cacheClass, inSchema, outSchema);
    const callbackRoles = extractCallbackRoles(name, provenance, inSchema, outSchema, contract.callbackRoles);
    // Spine adoption (docs/environments.md §CONTRACT): z.listAlike borrowed arrays projected
    // before impl runs — native has no validation, and .car on a raw array reads undefined.
    // Computed once; undefined when no slot adopts.
    const adoptArgs = buildSlotAdopter(contract.input, contract.inputRest);
    const hostImpl = (
      adoptArgs === undefined
        ? impl
        : function (this: unknown, ...args: unknown[]) {
            return (impl as (this: unknown, ...a: unknown[]) => unknown).apply(this, adoptArgs(args));
          }
    ) as (this: CallCtx, ...a: unknown[]) => unknown;
    return new ANativeProcedure({
      name,
      arity: { min: 0, max: null },
      contract: {
        kind: "native",
        name,
        doc,
        in: inSchema,
        out: outSchema,
        impl: hostImpl,
        type: contract.type,
        preludeOnly: contract.preludeOnly,
        requiresConfig: contract.requiresConfig,
        provenance,
        cacheClass,
        callbackRoles,
        emit: contract.emit,
        narrows: contract.narrows,
        refPolicy: contract.refPolicy,
        metadata: opts.metadata } satisfies NativeSymbolDef,
      impl: (args, callCtx) => hostImpl.apply(callCtx, args) as SchemeValue,
      provenanceRole: provenance,
      cacheClass,
      callbackRoles });
  };
}
