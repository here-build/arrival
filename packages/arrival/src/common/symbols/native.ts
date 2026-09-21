// symbol.native — contour host fn over scheme values (no validation, no codec crossing).
// Per-tag factory; shared types in ./_bake.js.
// docs/environments.md §SYMBOL-KINDS (native row), §CONTRACT (scheme face).
// Tagged template carries `name: doc`; returns a generic so TS infers contract then checks
// the impl against decoded types — wrong-typed impl is a compile error.

import { ZodType } from "zod";
import { buildSlotAdopter } from "../../membrane/adopt-spine.js";
import { ANativeProcedure, type NativeSymbolDef } from "../../values/primitives/ANativeProcedure.js";
import { type SchemeValue } from "../../values/types.js";
import { type CallCtx } from "../../run/CallCtx.js";
import { decodeKwargsStrict } from "../kwargs-rejection.js";
import {
  assertContractAxes,
  collectKwargsObject,
  type ContourContract,
  normalizeInputVector,
  normalizeVector,
  parseNameDoc,
  splitAtFirstKeyword,
  type Impl,
  type MetadataRecord,
  type RestSpec,
  type VectorSpec,
} from "./_bake.js";
import { assertNoResourcePathProducers } from "../../run/resource-paths.js";

/** Native host fn over scheme values. Slot bans on ContourContract (`_bake.ts` §1.7). */
function native(tpl: TemplateStringsArray, ...sub: unknown[]) {
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
    const cacheClass = contract.cacheClass;
    const callbackRoles = assertContractAxes(name, "native", {
      inSchema,
      outSchema,
      provenance,
      cacheClass,
      declaredCallbackRoles: contract.callbackRoles,
    });
    // Spine adoption (docs/environments.md §CONTRACT): z.listAlike borrowed arrays projected
    // before impl runs — native has no validation, and .car on a raw array reads undefined.
    // Computed once; undefined when no slot adopts.
    const adoptArgs = buildSlotAdopter(contract.input, contract.inputRest);
    const kwargsShape: Record<string, import("zod").ZodTypeAny> | undefined =
      contract.inputRest !== undefined && !(contract.inputRest instanceof ZodType) ? contract.inputRest : undefined;
    const applyImpl = impl as (this: CallCtx, ...a: unknown[]) => unknown;
    // Interpreter args are untyped SchemeValues; impl wants the contract tuple.
    // Passthrough (no list slot) is the same widening — adoption is the typed path.
    const hostImpl: (this: CallCtx, ...a: readonly SchemeValue[]) => unknown = function (
      this: CallCtx,
      ...args: readonly SchemeValue[]
    ) {
      if (kwargsShape !== undefined) {
        const items = Array.isArray(contract.input) ? contract.input : [];
        if (items.length === 0) {
          return applyImpl.apply(this, [decodeKwargsStrict(name, kwargsShape, collectKwargsObject(args))]);
        }
        const { head, kwArgs } = splitAtFirstKeyword(args);
        const adopted = [...(adoptArgs === undefined ? head : adoptArgs(head as SchemeValue[]))];
        while (adopted.length < items.length) adopted.push(undefined);
        const kwargs = decodeKwargsStrict(name, kwargsShape, collectKwargsObject(kwArgs));
        return applyImpl.apply(this, [...adopted, kwargs]);
      }
      const adopted = adoptArgs === undefined ? args : adoptArgs(args);
      return applyImpl.apply(this, adopted as unknown[]);
    };
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
        metadata: opts.metadata,
      } satisfies NativeSymbolDef,
      impl: (args, callCtx) => hostImpl.apply(callCtx, args as SchemeValue[]) as SchemeValue,
      provenanceRole: provenance,
      cacheClass,
      callbackRoles,
    });
  };
}

export default native;
