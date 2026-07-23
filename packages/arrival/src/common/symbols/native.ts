// symbol.native — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js. docs/environments.md §SYMBOL-KINDS — the `native` row (a contour;
// impl over scheme values, no validation); §CONTRACT — the SCHEME face it projects.
//
// The tagged template carries `name: human description`; it returns a GENERIC fn so
// TS infers the contract first, then checks the impl against the DECODED types. A
// wrong-typed impl is a COMPILE error — that inference is the load-bearing proof.

import { buildSlotAdopter } from "../../membrane/adopt-spine.js";
import { ANativeProcedure } from "../../values/primitives/ACallable.js";
import { type SchemeValue } from "../../values/types.js";
import {
  assertCacheClassShape,
  assertProvenanceRoleShape,
  extractCallbackRoles,
  normalizeInputVector,
  normalizeVector,
  parseNameDoc,
  type CacheClass,
  type CallbackRoles,
  type CallCtx,
  type Contract,
  type ContourResult,
  type Impl,
  type MetadataRecord,
  type NativeSymbolDef,
  type ProvenanceRole,
  type RestSpec,
  type VectorSpec,
} from "./_bake.js";

/** Native host fn over SCHEME VALUES (no ctx, no validation, no codec crossing). The impl
 *  projects the contract's SCHEME face (`Impl<…, "scheme">` — see `Face` in `_bake.ts`), so a
 *  codec-vocabulary schema (e.g. `z.string` = AString⇄string) types the native impl's arg as the
 *  SCHEME value (AString), never the JS image. `Rest` (from `contract.inputRest`, default
 *  `undefined`) is the fixed-prefix-plus-rest split — see `Contract`/`Impl` in `_bake.ts`.
 *
 *  Declared return type is `ContourResult<I,O,Rest,ANativeProcedure>` (`_bake.ts`), not bare
 *  `ANativeProcedure`: the AUTHOR-facing compile-time ban on a `z.dynamic` slot (V ruling,
 *  mid-Phase-A — see `_bake.ts`'s §1.7 doc and `rosetta.ts`'s matching `CrossingResult` for the
 *  full mechanism). `contract` itself stays the plain, UNTRANSFORMED `Contract<I,O,Rest>`. */
export function native(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: Contract<I, O, Rest>,
    impl: Impl<I, O, Rest, "scheme">,
    opts: { metadata?: MetadataRecord } = {},
  ): ContourResult<I, O, Rest, ANativeProcedure> => {
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
    const def: NativeSymbolDef = {
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
    // Stage A2 — the factory mints the A-VALUE directly (not a plain def record):
    // `common/capability.ts`'s bind loop used to build this ANativeProcedure itself, off a
    // returned NativeSymbolDef; the def now rides `.contract` on the value it used to
    // construct FROM, and the bind loop's per-kind construction arm is gone (`contract`,
    // `requiresConfig`'s config-gate + `preludeOnly` routing are the only things it still
    // reads off `.contract` per-assembly). The impl adapter (`(args, callCtx) =>
    // hostImpl.apply(callCtx, args)`) is the SAME one the bind loop used to build.
    const hostImpl = def.impl as (this: CallCtx, ...a: unknown[]) => unknown;
    const proc = new ANativeProcedure({
      name,
      arity: { min: 0, max: null },
      contract: def,
      impl: (args, callCtx) => hostImpl.apply(callCtx, args) as SchemeValue,
    });
    // PROVENANCE STAMP — every constructed proc carries its RESOLVED provenance role plus,
    // when declared, callbackRoles/cacheClass; the lineage classifier + wireframe builder
    // read all three off the BOUND VALUE via `env.get(op)`, never a duck-read (unchanged
    // from the bind loop's own stamping, just moved to mint time).
    (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = provenance;
    if (cacheClass !== undefined) (proc as { cacheClass?: CacheClass }).cacheClass = cacheClass;
    if (callbackRoles !== undefined) (proc as { callbackRoles?: CallbackRoles }).callbackRoles = callbackRoles;
    // ERASE ONCE here: the runtime value is ALWAYS a real `ANativeProcedure` — the
    // `ContourResult` conditional is a caller-facing compile-time check only (see this
    // function's own doc + `_bake.ts`'s §1.7).
    return proc as ContourResult<I, O, Rest, ANativeProcedure>;
  };
}
