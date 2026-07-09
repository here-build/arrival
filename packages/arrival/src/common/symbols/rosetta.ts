// symbol.rosetta — a host fn in JS-LAND (decoded via the contract codecs). One of the
// per-tag factory files re-assembled into the `symbol` namespace by `./index.ts`; the
// shared types + helpers live in `./_bake.js`.

import * as z from "../scheme-zod.js";
import { ZodType } from "zod";
import { attestDeep, freshIfSingleton } from "../../values/attestation.js";
import { AValue, pointProvenance, unionProvenance } from "../../values/primitives/AValue.js";
import { jsToScheme } from "../../rosetta.js";
import {
  assertProvenanceRoleShape,
  extractCallbackRoles,
  type BakeRuntimeOpts,
  CallCtx,
  collectKwargsObject,
  type Contract,
  type Impl,
  isSingleOutput,
  normalizeInputVector,
  normalizeVector,
  parseNameDoc,
  type RestSpec,
  type RosettaSymbolDef,
  type VectorSpec,
} from "./_bake.js";

/** Rosetta host fn in JS-LAND (decoded via the contract codecs). ctx-free for this step.
 *  `Rest` (inferred from `contract.inputRest`, defaulting to `undefined`) is the FIXED-prefix-
 *  plus-rest split — see `Contract`/`Impl` in `_bake.ts`. Absent `inputRest` ⇒ `Rest` stays
 *  `undefined` and `impl`'s signature is byte-identical to before `inputRest` existed. */
export function rosetta(tpl: TemplateStringsArray, ...sub: (string | number)[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: Contract<I, O, Rest>,
    impl: Impl<I, O, Rest>,
    opts: BakeRuntimeOpts = {},
  ): RosettaSymbolDef => {
    const inSchema = normalizeInputVector(contract.input, contract.inputRest);
    const outSchema = normalizeVector(contract.output);
    const singleOut = isSingleOutput(contract.output);
    // `value` OUTPUT slots are the declared NO-TRANSFORM escape hatch ("impl returns raw,
    // does its own conversion" — z.value's own doc): running them through `z.encode` would
    // apply the scheme-side check to the RAW return BEFORE step 4's jsToScheme ever boxes
    // it, rejecting every impl that returns a plain JS object (the llm/mcp DerivableEntity
    // family — the (infer …) outage this flag fixes). Boxing IS their validation now: the
    // inbound-claims registry (rosetta.ts) totalizes the crossing (exotics borrow loudly,
    // bare promises door). Computed at bake, per slot, tuple-shaped outputs only — a
    // variadic array-ish output keeps the plain encode (no live `value` variadic exists).
    const escapeSlots: readonly boolean[] = Array.isArray(contract.output)
      ? (contract.output as readonly unknown[]).map((slot) => z.lookupName(slot) === "value")
      : [];
    // Resolve the declared role (default "source" — see Contract.provenance): "pipe" is a
    // TRANSFORM (forwards input provenance); "source" (default) MINTS. Migrated from the
    // retired `pure: true` boolean (PROVENANCE-PLAN.md Q2) — `pure === true` ⇒ "pipe",
    // undefined/false ⇒ "source", so `forwards` below is BYTE-IDENTICAL to the old `pure`.
    const provenance = contract.provenance ?? "source";
    assertProvenanceRoleShape(name, provenance, inSchema, outSchema);
    // Per-lambda-arm callback roles (PROVENANCE-PLAN.md Q4): shape extraction + the
    // declared override, drift-door checked — see extractCallbackRoles in _bake.ts.
    const callbackRoles = extractCallbackRoles(name, provenance, inSchema, outSchema, contract.callbackRoles);
    const forwards = provenance === "pipe";
    // Per-invocation validation gate (the design's `exec(src, { typecheck })`). Retained
    // for the trust model + future use; see the decode note below for why it currently
    // can't be a no-op for the codec family. Default from bake opts.
    const defaultValidate = opts.validate !== false;
    // `run` dispatches at runtime against a `z.decode`-produced `unknown[]`, which TS can't
    // statically match to `impl`'s own precise `DecodedArgsWithRest<I,Rest>` tuple — erase
    // ONCE here, the same boundary `symbol.native`'s `impl: AnyFn` binding crosses. By
    // construction (the contract the caller declared above), the decoded array always matches.
    const rawImpl = impl as (...args: unknown[]) => unknown;

    // The interpretive wrapper. Mirrors createRosettaWrapper's spine
    // (schemeToJs → fn → jsToScheme), with the contract codecs standing in for the
    // generic conversions and zod doing the (gated) validation, and the SAME ctx-driven
    // provenance mint at the end.
    const run = async function (this: CallCtx, ...args: unknown[]): Promise<unknown> {
      // R-CTX-3: `this` IS the CallCtx — the type parameter forces it at every call site
      // (unbound call = compile error); makeCallCtx/testCallCtx never yield nullable
      // fields, so no runtime door (retired 2026-07-10; the old "direct def.run(...)"
      // idiom died with the ctx tranches).
      // Collect input provenance from the RAW scheme args BEFORE decode strips the AValue
      // identity (decode unwraps SchemeString/SchemeBool/… to JS primitives). The fallback
      // when no invocation is in ctx (direct-JS calls) is this input union — exactly
      // createRosettaWrapper's behavior.
      const inputAValues = args.filter((a): a is AValue => a instanceof AValue);
      const inputProvenance = unionProvenance(inputAValues);

      // 1. DECODE args via the input codecs. In zod, a codec's TRANSFORM (the membrane
      //    crossing) and its input-side VALIDATION are FUSED inside `decode` — you can't
      //    run the transform without the instanceof/refinement guard. The membrane is
      //    structural (not optional), so decode always runs. For the primitive codec
      //    family the only validation BEYOND the transform is `z.integer`'s safe-int check
      //    (itself part of the boundary contract, not skippable noise) — so `validate`
      //    is effectively always-on here. The flag stays on the API to track trust and to
      //    host a real split once a schema carries skippable refinements; the no-op path
      //    is intentionally NOT faked. TODO(typecheck-skip): wire a transform-only decode
      //    when a contract gains refinements a trusted caller may skip.
      void defaultValidate;
      // kwargs input: a plain-record `contract.inputRest` (its VALUES are ZodType, the CONTAINER
      // is not) marks a trailing kwargs OBJECT — fold the interleaved `:key value` pairs into that
      // object (`collectKwargsObject`, the same key-name fold `dict` does) and decode it against
      // `z.object(shape)`, wrapping the one decoded value as the 1-element args array. A real
      // `z.ZodType` `inputRest` (variadic tail) or none stays the ordinary array-shaped decode
      // against `inSchema`. instanceof is the SOUND discriminator: no combinator can make a plain
      // record satisfy `instanceof ZodType` — a record whose values are ZodType is not itself one.
      const rest: RestSpec = contract.inputRest;
      const kwargsSchema = rest !== undefined && !(rest instanceof ZodType) ? z.object(rest) : undefined;
      const decodedArgs: readonly unknown[] = kwargsSchema
        ? [z.decode(kwargsSchema, collectKwargsObject(args))]
        : z.decode(inSchema, args);

      // 2. RUN the impl with a per-call **invocation `this`** — the SAME flat `CallCtx` the
      //    dispatch level already handed this wrapper, forwarded straight through (no second
      //    construction step). The impl still receives ONLY the decoded scheme args
      //    positionally — ctx is NOT a param. A ctx-coupled verb declares a `function` impl and
      //    reads run-state off `this` (`this.runCtx.signal` / `this.runCtx.signal?.aborted` /
      //    `this.invocation`); a pure verb is an arrow that ignores `this`, so
      //    `impl.call(this, …)` is byte-identical to `impl(…)`. async is implicit.
      const result = await rawImpl.call(this, ...decodedArgs);

      // 3. PROVENANCE — the SAME spine as createRosettaWrapper. A "source"-role rosetta
      //    (default) MINTS a fresh point off ctx.currentInvocation; a "pipe"-role rosetta is a
      //    TRANSFORM that FORWARDS the input-provenance union instead (mirrors defineRosetta's
      //    legacy `pure: true`). With no invocation in ctx (direct-JS) a source also falls back
      //    to the input union. ★The forward-vs-mint choice is provenance-load-bearing: a "pipe"
      //    rosetta that minted would fabricate a fresh origin (the seal-laundering class of bug).
      const inv = this.invocation.currentInvocation;
      let resultProvenance = inputProvenance;
      if (!forwards && inv && typeof inv.id === "number") {
        if (typeof inv.markProvenancePoint === "function") inv.markProvenancePoint();
        else inv.isProvenancePoint = true;
        resultProvenance = pointProvenance(inv.id);
      }

      // 4. ENCODE the output via the output codecs (codec encode = z.encode), then DEEP-STAMP
      //    with the minted provenance. The codec builds the scheme value(s) with EMPTY
      //    provenance, so the stamp is a separate re-walk (vs. createRosettaWrapper, which
      //    stamps DURING jsToScheme construction). `jsToScheme(v, {}, prov)` is the canonical
      //    re-stamp: given an already-AValue with a fresh provenance it deep-clones the
      //    Pair/vector spine + leaves with that provenance (rosetta.ts jsToScheme AValue
      //    branch), reaching every constructed value in one pass. CONTAINER-AWARE: the
      //    multiple-values case is a RAW JS ARRAY (the scheme values-vector) — stamp each
      //    ELEMENT and keep the JS array, because jsToScheme over a JS array would (correctly,
      //    for data) build a Pair-chain, which is the WRONG shape for a values-vector.
      //    ATTESTATION (values/attestation.ts) rides the SAME walk position: a "source" rosetta's
      //    return is machine-made (a tool result), so its spine + leaves are deep-attested —
      //    `car`/`vector-ref`/plucks on it hand back already-attested boxes at the manifold
      //    boundary. A "pipe" rosetta is a transform: its return keeps only what the impl itself
      //    chose to attest (the manifold's `s/*` validators attest their identity-returns this
      //    way). (`freshIfSingleton` first: `fromJs` reuses the shared #t/#f flyweights on the
      //    empty-provenance fast path, and the program-wide singletons must never attest.)
      if (singleOut) {
        // 1-tuple output: the impl returned a single value; encode it as a 1-vector.
        // A `value` slot skips the codec entirely (see escapeSlots above).
        const encoded = escapeSlots[0] ? result : z.encode(outSchema, [result])[0];
        const boxed: unknown = jsToScheme(this.runCtx, encoded, {}, resultProvenance);
        return forwards ? boxed : attestDeep(freshIfSingleton(boxed));
      }
      // multiple-values / array-ish output: the impl returned the values-vector already (an array
      // by the multi-output contract — `DecodedReturn` is the values-vector when output isn't a
      // 1-tuple), so it IS the `readonly unknown[]` the output codec encodes.
      const resultVector = result as readonly unknown[];
      const encoded = escapeSlots.some(Boolean)
        ? resultVector.map((v, i) =>
            escapeSlots[i] ? v : z.encode(normalizeVector([contract.output[i] as never]), [v])[0],
          )
        : z.encode(outSchema, resultVector);
      return encoded.map((v) => {
        const boxed: unknown = jsToScheme(this.runCtx, v, {}, resultProvenance);
        return forwards ? boxed : attestDeep(freshIfSingleton(boxed));
      });
    };

    return {
      kind: "rosetta",
      name,
      doc,
      in: inSchema,
      out: outSchema,
      impl,
      run,
      provenance,
      callbackRoles,
      type: contract.type,
      preludeOnly: contract.preludeOnly,
    };
  };
}
