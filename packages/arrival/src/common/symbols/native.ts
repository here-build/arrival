// symbol.native — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js. docs/environments.md §SYMBOL-KINDS — the `native` row (a contour;
// impl over scheme values, no validation); §CONTRACT — the SCHEME face it projects.
//
// The tagged template carries `name: human description`; it returns a GENERIC fn so
// TS infers the contract first, then checks the impl against the DECODED types. A
// wrong-typed impl is a COMPILE error — that inference is the load-bearing proof.

import { buildSlotAdopter } from "../../membrane/adopt-spine.js";
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
 *  projects the contract's SCHEME face (`Impl<…, "scheme">` — see `Face` in `_bake.ts`), so a
 *  codec-vocabulary schema (e.g. `z.string` = AString⇄string) types the native impl's arg as the
 *  SCHEME value (AString), never the JS image. `Rest` (from `contract.inputRest`, default
 *  `undefined`) is the fixed-prefix-plus-rest split — see `Contract`/`Impl` in `_bake.ts`. */
export function native(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: Contract<I, O, Rest>,
    impl: Impl<I, O, Rest, "scheme">,
    opts: { metadata?: MetadataRecord } = {},
  ): NativeSymbolDef => {
    const inSchema = normalizeInputVector(contract.input, contract.inputRest);
    const outSchema = normalizeVector(contract.output);
    // Default "pipe" — see Contract.provenance (kind-default table + how capability.ts stamps
    // the resolved role onto the bound ANativeProcedure for the lineage classifier).
    const provenance = contract.provenance ?? "pipe";
    assertProvenanceRoleShape(name, provenance, inSchema, outSchema);
    // Cache class — see Contract.cacheClass; docs/environments.md §AXES — a native carries the field
    // but the run-cache interception is rosetta-membrane-only (a contour, not a penetration); the
    // resolved field still rides the def uniformly for downstream readers.
    const cacheClass = contract.cacheClass;
    assertCacheClassShape(name, cacheClass, inSchema, outSchema);
    // Per-lambda-arm callback roles: shape extraction + the declared override, drift-door
    // checked — see extractCallbackRoles in _bake.ts.
    const callbackRoles = extractCallbackRoles(name, provenance, inSchema, outSchema, contract.callbackRoles);
    // docs/environments.md §CONTRACT (spine adoption) — a `z.listAlike` slot's borrowed JS array is
    // projected onto its `AJSArrayList` view before the impl runs. It runs HERE (the bind path),
    // not inside the impls, because a native's contract is type-only with no validation and several
    // impls field-read `.car` — a borrowed array has none, so they'd silently read `undefined`.
    // Computed once at bake, `undefined` when no slot adopts — a verb with no list args pays nothing.
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
      requiresConfig: contract.requiresConfig,
      provenance,
      cacheClass,
      callbackRoles,
      // Compiler-facing fields — carried through AUTHORED, inert to the interpreter; the
      // harvest row resolves refPolicy's "shim" default. See Contract.emit/narrows/refPolicy.
      emit: contract.emit,
      narrows: contract.narrows,
      refPolicy: contract.refPolicy,
      // The extension bag — data only; dynamic fields resolve at read time, never at bake.
      metadata: opts.metadata,
    };
  };
}
