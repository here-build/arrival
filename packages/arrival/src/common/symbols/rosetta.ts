// symbol.rosetta — a host fn in JS-LAND (decoded via the contract codecs). One of the
// per-tag factory files re-assembled into the `symbol` namespace by `./index.ts`; the
// shared types + helpers live in `./_bake.js`.

import * as z from "../scheme-zod.js";
import { attestDeep, freshIfSingleton } from "../../values/attestation.js";
import { AValue, pointProvenance, unionProvenance } from "../../values/primitives/AValue.js";
import { jsToScheme } from "../../rosetta.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import {
  asEvalContext,
  type BakeRuntimeOpts,
  collectKwargsObject,
  type Contract,
  type Impl,
  ImplInvocationCtx,
  isSingleOutput,
  makeInvocationContext,
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
    // `pure: true` → TRANSFORM (forward input provenance); default → SOURCE (mint). Strict
    // `=== true` so only an explicit opt-out forwards (undefined/false stay sources).
    const pure = contract.pure === true;
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
    const run = async function (this: ImplInvocationCtx, ...args: unknown[]): Promise<unknown> {
      // Strip the evaluator-appended ctx iff the trailing arg LOOKS like one. By the time
      // the wrapper runs under the evaluator the scheme DATA args are already scheme values
      // (AValue subclasses / raw arrays-primitives); the genuine EvalContext is the only raw
      // plain object carrying resolver/currentInvocation/tap/signal that reaches here (probe
      // keys on `resolver` — the single always-present field since ejection P5 removed `env`).
      // Same probe as createRosettaWrapper's looksLikeEvalContext.
      const ctx = asEvalContext(this.ctx);

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
      // A `z.kwargs(...)` input is a single OBJECT schema, not array-shaped — `inSchema` (the
      // generic `VectorSchema`-typed handle `normalizeVector` hands back unchanged for it, see
      // that fn's note) can't decode the RAW interleaved `:key value` pairs array directly
      // against an object schema. Fold the pairs into the plain object `dict` would build
      // (`collectKwargsObject` — the same key-name fold), THEN decode that object
      // against the (narrowed, honest) kwargs schema, and wrap the one decoded value as the
      // 1-element args array `DecodedArgs` already gives a non-tuple, non-array-output contract
      // member. `isKwargs` narrows `contract.input` from `VectorSpec` to the branded
      // object schema — no cast needed.
      const decodedArgs: readonly unknown[] = z.isKwargs(contract.input)
        ? [z.decode(contract.input, collectKwargsObject(args))]
        : z.decode(inSchema, args);

      // 2. RUN the impl with a per-call **invocation `this`** (the lazy invocation-context). The
      //    impl still receives ONLY the decoded scheme args positionally — ctx is NOT a param. A
      //    ctx-coupled verb declares a `function` impl and reads run-state lazily off `this`
      //    (`this.aborted` / `this.abortSignal` / `this.invocation`); a pure verb is an arrow that
      //    ignores `this`, so `impl.call(invCtx, …)` is byte-identical to `impl(…)`. The getters
      //    read the captured `ctx` ON ACCESS, so a pure verb materializes nothing. async is implicit.
      const invCtx = makeInvocationContext(ctx);
      const result = await rawImpl.call(invCtx, ...decodedArgs);

      // 3. PROVENANCE — the SAME spine as createRosettaWrapper. A SOURCE rosetta (default)
      //    MINTS a fresh point off ctx.currentInvocation; a PURE rosetta (`pure: true`) is a
      //    TRANSFORM that FORWARDS the input-provenance union instead (mirrors defineRosetta
      //    `pure: true`). With no invocation in ctx (direct-JS) a source also falls back to the
      //    input union. ★The forward-vs-mint choice is provenance-load-bearing: a pure rosetta
      //    that minted would fabricate a fresh origin (the seal-laundering class of bug).
      const inv = ctx?.currentInvocation;
      let resultProvenance = inputProvenance;
      if (!pure && inv && typeof inv.id === "number") {
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
      //    ATTESTATION (values/attestation.ts) rides the SAME walk position: a SOURCE
      //    rosetta's return is machine-made (a tool result), so its spine + leaves are
      //    deep-attested — `car`/`vector-ref`/plucks on it hand back already-attested
      //    boxes at the manifold boundary. A PURE rosetta is a transform: its return
      //    keeps only what the impl itself chose to attest (the manifold's `s/*`
      //    validators attest their identity-returns this way).
      //    (`freshIfSingleton` first: `fromJs` reuses the shared #t/#f flyweights on the
      //    empty-provenance fast path, and the program-wide singletons must never attest.)
      if (singleOut) {
        // 1-tuple output: the impl returned a single value; encode it as a 1-vector.
        const encoded = z.encode(outSchema, [result])[0];
        const boxed: unknown = jsToScheme(ctx?.runCtx ?? CONSTANT_CTX, encoded, {}, resultProvenance);
        return pure ? boxed : attestDeep(freshIfSingleton(boxed));
      }
      // multiple-values / array-ish output: the impl returned the values-vector already (an array
      // by the multi-output contract — `DecodedReturn` is the values-vector when output isn't a
      // 1-tuple), so it IS the `readonly unknown[]` the output codec encodes.
      const encoded = z.encode(outSchema, result as readonly unknown[]);
      return encoded.map((v) => {
        const boxed: unknown = jsToScheme(ctx?.runCtx ?? CONSTANT_CTX, v, {}, resultProvenance);
        return pure ? boxed : attestDeep(freshIfSingleton(boxed));
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
      pure,
      type: contract.type,
      preludeOnly: contract.preludeOnly,
    };
  };
}
