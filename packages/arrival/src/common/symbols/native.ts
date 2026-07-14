// symbol.native — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js.
//
// The tagged template carries `name: human description`; it returns a GENERIC fn so
// TS infers the contract first, then checks the impl against the DECODED types. A
// wrong-typed impl is a COMPILE error — that inference is the load-bearing proof.

import { buildSlotAdopter } from "../../values/adopt-spine.js";
import {
  assertCacheClassShape,
  assertProvenanceRoleShape,
  extractCallbackRoles,
  normalizeInputVector,
  normalizeVector,
  parseNameDoc,
  type Contract,
  type Impl,
  type MetadataRecord,
  type NativeSymbolDef,
  type RestSpec,
  type VectorSpec,
} from "./_bake.js";

/** Native host fn over SCHEME VALUES (no ctx, no validation, no codec crossing). The impl
 *  projects the contract's SCHEME face (`Impl<…, "scheme">` = each schema's `z.input`, the
 *  value-algebra side; a rosetta projects `z.output`, the membrane side) — so a codec-vocabulary
 *  schema (e.g. `z.string` = AString⇄string) types the native impl's arg as the SCHEME value
 *  (AString), never the JS image. `Rest` (from `contract.inputRest`, default `undefined`) is
 *  the fixed-prefix-plus-rest split — see `Contract`/`Impl` in `_bake.ts`. */
export function native(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: Contract<I, O, Rest>,
    impl: Impl<I, O, Rest, "scheme">,
    opts: { metadata?: MetadataRecord } = {},
  ): NativeSymbolDef => {
    const inSchema = normalizeInputVector(contract.input, contract.inputRest);
    const outSchema = normalizeVector(contract.output);
    // Resolve the declared role (default "pipe" — see Contract.provenance); capability.ts
    // stamps this onto the bound ANativeProcedure (`provenanceRole`) so the lineage classifier
    // reads it off `env.get(op)`, replacing the retired `fanout: true` → `.fanout` duck-read.
    const provenance = contract.provenance ?? "pipe";
    assertProvenanceRoleShape(name, provenance, inSchema, outSchema);
    // The EXPLICIT cache class (Ruling A) — no kind default: absent = regenerateable. The
    // run-cache INTERCEPTION lives on the rosetta membrane only (a native is a contour, not
    // a penetration); the resolved field still rides the def uniformly for downstream readers.
    const cacheClass = contract.cacheClass;
    assertCacheClassShape(name, cacheClass, inSchema, outSchema);
    // Per-lambda-arm callback roles: shape extraction + the declared override, drift-door
    // checked — see extractCallbackRoles in _bake.ts.
    const callbackRoles = extractCallbackRoles(name, provenance, inSchema, outSchema, contract.callbackRoles);
    // Spine adoption (values/adopt-spine.ts): a slot declared `z.listAlike` takes the SPINE reading
    // of its argument, so a borrowed JS array is projected onto an `AJSArrayList` view (O(1), same
    // backing store, same provenance) BEFORE the impl sees it — and an empty array becomes `nil`.
    //
    // It has to happen HERE, not inside the impls, because a native's contract is type-only (there
    // is no runtime validation on this path at all — see the note below) and several impls FIELD-READ
    // their list argument (`findImpl` does `list.car`). A borrowed array has no `.car`, so those
    // impls silently read `undefined`: `find` threw on void, `member` answered #f about lists that
    // contained the element, `list->vector` answered []. Handing the impl a real APair subclass is
    // the only thing that reaches that class of consumer.
    //
    // Computed once at bake and `undefined` when no slot adopts, so a verb with no list arguments
    // pays exactly nothing.
    const adoptArgs = buildSlotAdopter(contract.input, contract.inputRest);
    return {
      kind: "native",
      name,
      doc,
      in: inSchema,
      out: outSchema,
      // NO runtime validation, NO codec — the impl works on scheme values directly.
      // "zod for types purely": the schemas live on the def for inference + the harvest.
      impl: (adoptArgs === undefined
        ? impl
        : function (this: unknown, ...args: unknown[]) {
            return (impl as (this: unknown, ...a: unknown[]) => unknown).apply(this, adoptArgs(args));
          }) as typeof impl,
      type: contract.type,
      preludeOnly: contract.preludeOnly,
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
