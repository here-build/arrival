// symbol.rosetta — a host fn in JS-LAND (decoded via the contract codecs). One of the
// per-tag factory files re-assembled into the `symbol` namespace by `./index.ts`; the
// shared types + helpers live in `./_bake.js`.

import * as z from "../scheme-zod.js";
import { ZodError, ZodType } from "zod";
import { decodeKwargsStrict, drainDroppedKwargNotes } from "../kwargs-rejection.js";
import { formatPositionalRejection } from "./positional-rejection.js";
import { attestDeep, freshIfSingleton } from "../../values/attestation.js";
import { AValue, pointProvenance, unionProvenance } from "../../values/primitives/AValue.js";
import { jsToScheme } from "../../membrane/rosetta.js";
import { penetrateThroughCache } from "../../values/run-cache.js";
import { closeRegionScope, openRegionScope, withRegionScope } from "../../membrane/region-scope.js";
import { is_callable_value } from "../../values/value-guards.js";
import {
  assertCacheClassShape,
  assertProvenanceRoleShape,
  contractMayCarryCallable,
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
  topLevelSchemas,
  type VectorSpec,
} from "./_bake.js";

/** THE Z.VALUE-CALLABLE DOOR (Ruling A) — a plain teaching throw, deliberately NOT a
 *  class: the errors-as-doors corpus is migrating to individual classes elsewhere;
 *  staying a bare `throw new Error` here lets that migration absorb it later without a
 *  merge collision.
 *
 *  `z.value` is the declared raw escape hatch (scheme-zod.ts's own doc on `value`): its decode
 *  performs NO transform (`value` is a bare predicate, not a codec), so the impl receives the
 *  raw scheme value untouched and does its OWN schemeToJs/applyCallback marshaling — possibly
 *  AFTER the impl's own first `await`, by which point `withRegionScope`'s synchronous
 *  save/restore (region-scope.ts) has already reverted the ambient scope to whatever it was
 *  before this call (see `run`'s own `fire` below) — so a reverse call minted from that stale
 *  marshal binds `DETACHED_SCOPE`/`CONSTANT_CTX`, not the live run, reopening exactly the
 *  burst-bypass hole the region-scope gate exists to close. `z.procedure`'s wrapper is safe
 *  because ITS decode marshals SYNCHRONOUSLY, at decode time, before any await runs
 *  (`procedure`'s own doc, scheme-zod.ts). So the fix isn't to marshal a `z.value` callable
 *  safely — it's to never let one land there: make the unsafe shape UNAUTHORED, steering the
 *  author to declare the slot `z.procedure` instead. */
function assertNotBareCallableInValueSlot(symbolName: string, value: unknown, position: string): void {
  if (typeof value === "function" || is_callable_value(value)) {
    throw new Error(
      `${symbolName}: a callable argument crossed a z.value slot (${position}) — declare this parameter ` +
        `z.procedure so its host-fn wrapper is minted at decode, synchronously, under the live region scope. ` +
        `A callable marshaled from a z.value slot after an await binds a detached scope and can bypass the ` +
        `effect burst.`,
    );
  }
}

/** Bake-time-only: which of `inSchema`'s TOP-LEVEL slots (the SAME shallow view
 *  `contractMayCarryCallable` reads — fixed tuple items / a homogeneous array's lone element /
 *  kwargs object fields) are bare `z.value` — and a runtime closure that checks a call's
 *  DECODED args at exactly those positions. `undefined` when the contract carries no `z.value`
 *  slot at all (the overwhelming majority — zero cost). Deliberately scoped IDENTICAL to
 *  `contractMayCarryCallable`'s own shallow slots: a callable buried inside a CONTAINER argument
 *  (`z.list(z.value)`, `z.vector(z.value)`, a dict field) is the shallow-gate-recursion gap —
 *  a separate, already-tracked finding, not this door's job to catch. */
function buildValueSlotCheck(
  symbolName: string,
  inSchema: z.ZodTypeAny,
  kwargsShape: Record<string, z.ZodTypeAny> | undefined,
): ((decodedArgs: readonly unknown[]) => void) | undefined {
  if (kwargsShape) {
    const valueKeys = Object.entries(kwargsShape)
      .filter(([, slot]) => z.lookupName(slot) === "value")
      .map(([key]) => key);
    if (valueKeys.length === 0) return undefined;
    return (decodedArgs) => {
      const obj = decodedArgs[0] as Record<string, unknown>;
      for (const key of valueKeys) assertNotBareCallableInValueSlot(symbolName, obj[key], `keyword argument :${key}`);
    };
  }
  const items = topLevelSchemas(inSchema);
  if (items === undefined) return undefined;
  // A homogeneous array-ish input's `topLevelSchemas` is always a ONE-item result standing for
  // EVERY decoded position (its own "array" branch); a fixed multi-item tuple's items map 1:1 to
  // positions. A one-item result is checked identically either way — a single fixed z.value arg
  // has exactly one decoded position, the same as "check the array's one element type at every
  // position" when there happens to be exactly one position.
  if (items.length === 1) {
    if (z.lookupName(items[0]) !== "value") return undefined;
    return (decodedArgs) =>
      decodedArgs.forEach((a, i) => assertNotBareCallableInValueSlot(symbolName, a, `argument ${i + 1}`));
  }
  const valueIndices = items.flatMap((item, i) => (z.lookupName(item) === "value" ? [i] : []));
  if (valueIndices.length === 0) return undefined;
  return (decodedArgs) =>
    valueIndices.forEach((i) => assertNotBareCallableInValueSlot(symbolName, decodedArgs[i], `argument ${i + 1}`));
}

/** Rosetta host fn in JS-LAND (decoded via the contract codecs). ctx-free for this step.
 *  `Rest` (inferred from `contract.inputRest`, defaulting to `undefined`) is the FIXED-prefix-
 *  plus-rest split — see `Contract`/`Impl` in `_bake.ts`. Absent `inputRest` ⇒ `Rest` stays
 *  `undefined` and `impl`'s signature is the plain fixed-arity form. */
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
    // TRANSFORM (forwards input provenance); "source" (default) MINTS.
    const provenance = contract.provenance ?? "source";
    assertProvenanceRoleShape(name, provenance, inSchema, outSchema);
    // The EXPLICIT cache class (Ruling A) — no kind default: absent = regenerateable, the
    // safe polarity. `view` demands a serializable contract (the gate); `pure` is ungated.
    // Lineage ⊥ cache: this never touches `provenance` above — infer is the standing proof
    // (a provenance SOURCE that declares cacheClass "pure").
    const cacheClass = contract.cacheClass;
    assertCacheClassShape(name, cacheClass, inSchema, outSchema);
    // Per-lambda-arm callback roles: shape extraction + the declared override, drift-door
    // checked — see extractCallbackRoles in _bake.ts.
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

    // THE REGION-SCOPE GATE (openRegionScope-gap Ruling A) — computed ONCE at bake, off the
    // SAME normalized `inSchema` every other bake-time gate above already reads. `true` only
    // for a contract that can hand the impl a live callable (`z.procedure`/`z.value` input
    // slot — see `contractMayCarryCallable`'s doc for the full gate + the z.value
    // adjudication); every other verb's `run` below skips the scope entirely — zero cost.
    const carriesCallable = contractMayCarryCallable(inSchema);

    // kwargs input: a plain-record `contract.inputRest` (its VALUES are ZodType, the CONTAINER
    // is not) marks a trailing kwargs OBJECT — hoisted here (bake-invariant off `contract.
    // inputRest` alone) so both the z.value-callable door below and `run`'s own decode step
    // (§1) read the SAME computed shape instead of re-deriving it per call.
    const bakedInputRest: RestSpec = contract.inputRest;
    const kwargsShape = bakedInputRest !== undefined && !(bakedInputRest instanceof ZodType) ? bakedInputRest : undefined;

    // THE Z.VALUE-CALLABLE DOOR (Ruling A, see `buildValueSlotCheck`'s own doc above) —
    // computed ONCE at bake, `undefined` (zero cost) for the overwhelming majority of contracts
    // that carry no `z.value` input slot at all.
    const checkValueSlots = buildValueSlotCheck(name, inSchema, kwargsShape);

    // The interpretive wrapper. Mirrors createRosettaWrapper's spine
    // (schemeToJs → fn → jsToScheme), with the contract codecs standing in for the
    // generic conversions and zod doing the (gated) validation, and the SAME ctx-driven
    // provenance mint at the end.
    const run = async function (this: CallCtx, ...args: unknown[]): Promise<unknown> {
      // `this` IS the CallCtx — the type parameter forces it at every call site (unbound
      // call = compile error); makeCallCtx/testCallCtx never yield nullable fields, so
      // there is no runtime door.
      // Collect input provenance from the RAW scheme args BEFORE decode strips the AValue
      // identity (decode unwraps SchemeString/SchemeBool/… to JS primitives). The fallback
      // when no invocation is in ctx (direct-JS calls) is this input union — exactly
      // createRosettaWrapper's behavior.
      const inputAValues = args.filter((a): a is AValue => a instanceof AValue);
      const inputProvenance = unionProvenance(inputAValues);
      // Hoisted from step 3 below (still read there, unchanged) — ALSO this call's `dynSite`
      // for the region scope opened next, mirroring legacy createRosettaWrapper's
      // `openRegionScope({ runCtx, dynSite: inv })`.
      const inv = this.invocation.currentInvocation;

      // REGION DISCIPLINE (openRegionScope-gap Ruling A, values/primitives/region-scope.ts) —
      // opened ONLY when the bake-time gate (`carriesCallable`, above) found a slot that might
      // hand the impl a live callable; a lambda-free verb never mints one (zero cost). `runCtx:
      // this.runCtx` is the invocation's LIVE context — the SAME handle carrying
      // `cache`/`effects`/`reads` below — so a reverse-lambda minted under this scope (a
      // `z.procedure` slot's decode, just below) re-enters via `scope.runCtx`: a lambda calling
      // a sink verb hits the burst arm (`this.runCtx.effects`) instead of firing inline, closing
      // the burst-bypass hole this ruling exists for. `dynSite: inv` mirrors legacy exactly.
      // This ONE span — decode through the impl settling — is "symbol invocation" any callable
      // among `args` region-binds to; closed the INSTANT the impl settles (rule 2: an
      // incomplete reverse call at that point throws), BEFORE the provenance mint/encode steps
      // below run — mirrors legacy's own `try { await fn.apply(...) } finally {
      // closeRegionScope(scope) }` nesting exactly.
      const scope = carriesCallable ? openRegionScope({ runCtx: this.runCtx, dynSite: inv }) : undefined;
      let result: unknown;
      try {
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
        // (`kwargsShape` itself is bake-time-hoisted above, beside `checkValueSlots`.)
        // STRICT + humanized (kwargs-rejection.ts, args-error-reporting-v2.md §2.5): unknown
        // keys reject instead of silently stripping, and a ZodError rethrows in the frozen
        // `<name>: arguments rejected — N problem(s):` grammar.
        //
        // B4 (benchmark-defect-register.md): the POSITIONAL arm used to let a raw `ZodError`
        // propagate — zod v4's `ZodError.message` IS the pretty-printed JSON of `.issues`, a
        // 25-line nested-union dump naming no verb and no argument (one model in the 89x2
        // corpus misread it as an invented `:limit max 500` schema constraint and voluntarily
        // shrank its dataset 388→80). Humanized the same way the kwargs arm already is, via
        // `positional-rejection.ts` (this arm's own sibling of kwargs-rejection.ts's
        // `issueLines`, keyed on arg INDEX instead of kwarg NAME).
        const decode = (): readonly unknown[] => {
          if (kwargsShape) {
            const decoded = decodeKwargsStrict(name, kwargsShape, collectKwargsObject(args));
            // DRAIN THE TOLERANCE NOTE INTO THE RUN'S NOTE CHANNEL.
            //
            // The B5 tolerance drops a far-unknown kwarg key and lets the call PROCEED — right,
            // because a model writing `(memory/search_nodes :query "x" :limit 10)` against a tool
            // with no `:limit` should not eat a hard rejection over an argument that changes nothing.
            // Before the tolerance that was a CRASH.
            //
            // But the note explaining what was ignored was produced and then never surfaced —
            // `drainDroppedKwargNotes` had ZERO production callers, so the notes sat in a WeakMap
            // forever, and the model went from an unexplained crash to an unexplained SILENT DROP.
            // It still believed `:limit 10` was honored, and would reasonably conclude the tool
            // ignores limits, or that its own result set had been capped. A silent drop is a lie of
            // omission, and the whole diagnosis of this medium is that the return channel must not
            // lie: EVERY "nothing happened" must name WHICH nothing it is.
            //
            // This is the last inch. The note existed; nobody read it.
            const dropped = drainDroppedKwargNotes(decoded);
            if (dropped !== undefined) {
              const sink = this.runCtx.notes;
              for (const line of dropped) sink?.push(`${name}: ${line}`);
            }
            return [decoded];
          }
          try {
            return z.decode(inSchema, args);
          } catch (e) {
            if (e instanceof ZodError) throw new Error(formatPositionalRejection(name, e, args, inSchema));
            throw e;
          }
        };
        // Wrapped in `withRegionScope` when a scope is open — the SYNCHRONOUS window a
        // `z.procedure` arm's decode reads via `currentRegionScope()` (scheme-zod.ts), so the
        // minted host-fn wrapper closes over THIS scope instead of falling back to the shared
        // `DETACHED_SCOPE`.
        const decodedArgs: readonly unknown[] = scope ? withRegionScope(scope, decode) : decode();
        // THE Z.VALUE-CALLABLE DOOR fires HERE — right after decode, before the impl ever runs
        // (so a bad call never fires a partial effect first). `value`'s decode is an identity
        // predicate (no transform), so checking post-decode is equivalent to checking the raw
        // scheme arg; see `buildValueSlotCheck`'s own doc above for the full mechanism + why
        // this is scoped to bare top-level slots only.
        checkValueSlots?.(decodedArgs);

        // 2. RUN the impl with a per-call **invocation `this`** — the SAME flat `CallCtx` the
        //    dispatch level already handed this wrapper, forwarded straight through (no second
        //    construction step). The impl still receives ONLY the decoded scheme args
        //    positionally — ctx is NOT a param. A ctx-coupled verb declares a `function` impl and
        //    reads run-state off `this` (`this.runCtx.signal` / `this.runCtx.signal?.aborted` /
        //    `this.invocation`); a pure verb is an arrow that ignores `this`, so
        //    `impl.call(this, …)` is byte-identical to `impl(…)`. async is implicit.
        //
        //    THE RUN-CACHE INTERCEPTION (R2, values/run-cache.ts) sits exactly HERE — the one
        //    chokepoint where args are decoded and the impl hasn't fired. Gated on the run's
        //    cache (`this.runCtx.cache` — absent on every non-session run: the fast path below
        //    is byte-identical to before) and the bake-resolved cache class / sink lineage
        //    role. A replay-hit serves the DECODED-FACE value in `result`'s place; steps 3–4
        //    (provenance mint + encode + attestation) then run over it exactly as over a fresh
        //    impl return — values are never restored around the membrane, only through it.
        //
        //    THE BURST ARM (W1, values/effect-log.ts, arrival-plexus-effect-burst.md §2.3)
        //    rides the SAME chokepoint via `this.runCtx.effects` — a sibling per-run handle,
        //    not a `cache` field, so a burst run needs no `RunCache` to gather sink effects.
        //    Its fast-path bypass ALSO checks `runEffects`: a run with an effect log but no
        //    cache must still reach `penetrateThroughCache` (the burst arm lives inside it).
        //    THE READ-CLOCK STAMP (W2, values/read-guard.ts, arrival-plexus-effect-burst.md
        //    §2.4) rides the SAME chokepoint via `this.runCtx.reads` — read-only here (the
        //    guard CHECK itself runs in the eval loop, after each form): when a burst
        //    gathers this penetration, `reads.tracker` stamps the entry's
        //    `enqueuedAtReadClock`. A run with no `reads` seam is unaffected — the fast
        //    path below only gates on `cache`/`effects`, matching pre-W2 behavior exactly.
        const runCache = this.runCtx.cache;
        const runEffects = this.runCtx.effects;
        const runReads = this.runCtx.reads;
        // Also wrapped in `withRegionScope` (belt-and-suspenders beside decode above): covers
        // the impl's own SYNCHRONOUS prefix (up to its first `await`) for a `z.value` slot,
        // whose decode does NOT marshal — an impl that calls `schemeToJs`/`applyCallback` on
        // the raw value itself, synchronously, sees the live scope too. A `z.procedure` slot's
        // wrapper is already bound to `scope` from decode above; this only matters for the
        // escape-hatch case (see `contractMayCarryCallable`'s doc).
        const fire = async (): Promise<unknown> =>
          scope
            ? withRegionScope(scope, () => rawImpl.call(this, ...decodedArgs))
            : rawImpl.call(this, ...decodedArgs);
        result =
          runCache === undefined && runEffects === undefined
            ? await fire()
            : await penetrateThroughCache(
                runCache,
                // `rawArgs: args` — the pre-decode call args (arrival-provenance-confirmation.md
                // §5): carried onto a gathered `EffectEntry` verbatim so a confirmation-manifest
                // host can compute per-argument lineage and reconstruct this effect's own
                // re-runnable invocation from the provenance-carrying originals.
                { symbolName: name, cacheClass, sink: provenance === "sink", rawArgs: args },
                decodedArgs,
                fire,
                runEffects,
                runReads?.tracker,
              );
      } finally {
        if (scope) closeRegionScope(scope);
      }

      // 3. PROVENANCE — the SAME spine as createRosettaWrapper. A "source"-role rosetta
      //    (default) MINTS a fresh point off ctx.currentInvocation; a "pipe"-role rosetta is a
      //    TRANSFORM that FORWARDS the input-provenance union instead (mirrors defineRosetta's
      //    legacy `pure: true`). With no invocation in ctx (direct-JS) a source also falls back
      //    to the input union. ★The forward-vs-mint choice is provenance-load-bearing: a "pipe"
      //    rosetta that minted would fabricate a fresh origin (the seal-laundering class of bug).
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
      cacheClass,
      callbackRoles,
      type: contract.type,
      preludeOnly: contract.preludeOnly,
      // Compiler-facing fields (constitution §4.1) — carried through AUTHORED (the
      // harvest row resolves refPolicy's "shim" default); inert to the interpreter.
      emit: contract.emit,
      narrows: contract.narrows,
      refPolicy: contract.refPolicy,
      // The extension bag (BakeRuntimeOpts.metadata → RosettaSymbolDef.metadata). Stamped
      // as DATA only — dynamic (fn-valued) fields are NEVER invoked here (bake must not
      // resolve metadata: resolution is read-time, against the assembly's activation —
      // see `./metadata.js`'s resolveMetadata + exec-phases-and-dynamic-metadata.md §2.3).
      metadata: opts.metadata,
    };
  };
}
