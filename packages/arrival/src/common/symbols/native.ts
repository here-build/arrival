// symbol.native — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js.
//
// The tagged template carries `name: human description`; it returns a GENERIC fn so
// TS infers the contract first, then checks the impl against the DECODED types. A
// wrong-typed impl is a COMPILE error — that inference is the load-bearing proof.

import {
  assertProvenanceRoleShape,
  extractCallbackRoles,
  normalizeInputVector,
  normalizeVector,
  parseNameDoc,
  type Contract,
  type Impl,
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
  ): NativeSymbolDef => {
    const inSchema = normalizeInputVector(contract.input, contract.inputRest);
    const outSchema = normalizeVector(contract.output);
    // Resolve the declared role (default "pipe" — see Contract.provenance); capability.ts
    // stamps this onto the bound ANativeProcedure (`provenanceRole`) so the lineage classifier
    // reads it off `env.get(op)`, replacing the retired `fanout: true` → `.fanout` duck-read.
    const provenance = contract.provenance ?? "pipe";
    assertProvenanceRoleShape(name, provenance, inSchema, outSchema);
    // Per-lambda-arm callback roles: shape extraction + the declared override, drift-door
    // checked — see extractCallbackRoles in _bake.ts.
    const callbackRoles = extractCallbackRoles(name, provenance, inSchema, outSchema, contract.callbackRoles);
    return {
      kind: "native",
      name,
      doc,
      in: inSchema,
      out: outSchema,
      // NO runtime validation, NO codec — the impl works on scheme values directly.
      // "zod for types purely": the schemas live on the def for inference + the harvest.
      impl,
      type: contract.type,
      preludeOnly: contract.preludeOnly,
      provenance,
      callbackRoles,
    };
  };
}
