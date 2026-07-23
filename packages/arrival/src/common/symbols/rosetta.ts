// symbol.rosetta — a host fn in JS-LAND (decoded via the contract codecs). One of the
// per-tag factory files re-assembled into the `symbol` namespace by `./index.ts`; the
// shared types + helpers live in `./_bake.js`.
//
// docs/environments.md §SYMBOL-KINDS — the `rosetta` row (decode → validate → impl → encode →
// mint, the one membrane chokepoint); §MEMBRANE-SEAM — the bake-side crossing this `run`
// wrapper spins (source mints / pipe forwards, the region-scope gate). The crossing mechanics
// below are the enforcement site the doc points at, kept in full here.

import * as z from "../scheme-zod.js";
import { ZodError, ZodType } from "zod";
import { decodeKwargsStrict, drainDroppedKwargNotes } from "../kwargs-rejection.js";
import { formatPositionalRejection } from "./positional-rejection.js";
import { attestDeep, freshIfSingleton } from "../../values/attestation.js";
import { AValue, pointProvenance, unionProvenance } from "../../values/primitives/AValue.js";
import { AOpaqueHandle } from "../../values/primitives/AOpaqueHandle.js";
import { jsToScheme } from "../../membrane/rosetta.js";
import { penetrateThroughCache } from "../../run/run-cache.js";
import { closeRegionScope, openRegionScope, withRegionScope } from "../../membrane/region-scope.js";
import { is_callable_value } from "../../values/value-guards.js";
import { ARosettaProcedure } from "../../values/primitives/ACallable.js";
import { type SchemeValue } from "../../values/types.js";
import {
  assertCacheClassShape,
  assertProvenanceRoleShape,
  contractMayCarryCallable,
  extractCallbackRoles,
  type BakeRuntimeOpts,
  type CacheClass,
  type CallbackRoles,
  CallCtx,
  collectKwargsObject,
  type Contract,
  type CrossingResult,
  type Impl,
  isSingleOutput,
  normalizeInputVector,
  normalizeVector,
  parseNameDoc,
  type ProvenanceRole,
  type RestSpec,
  type RosettaSymbolDef,
  topLevelSchemas,
  type VectorSpec,
} from "./_bake.js";

/** THE Z.DYNAMIC-CALLABLE DOOR (Ruling A; retargeted off `z.value` at the Q1 split —
 *  docs/plans/stage-c-corpse-deletion.md §"z.value retirement campaign") — a plain teaching
 *  throw, deliberately NOT a class: the errors-as-doors corpus is migrating to individual
 *  classes elsewhere; staying a bare `throw new Error` here lets that migration absorb it
 *  later without a merge collision.
 *
 *  The hazard and why the fix is to make the shape UNAUTHORED (steer to `z.procedure`, whose decode
 *  marshals synchronously under the live scope) is docs/membrane.md §REGION (the `z.dynamic`
 *  burst-bypass hazard): a callable marshaled from a `z.dynamic` slot AFTER the impl's first
 *  `await` — past `withRegionScope`'s synchronous save/restore — binds `DETACHED_SCOPE`/
 *  `CONSTANT_CTX` and bypasses the effect burst. So this gate never lets one land there in the
 *  first place. Checked against `"dynamic"` only, not the deprecated `"value"` alias — a
 *  not-yet-migrated downstream `z.value` slot is untouched by this door (Phase B's own concern);
 *  `z.schemeValue` never reaches here at all — banned from a rosetta contract's slot types
 *  entirely, at COMPILE time (`CrossingContract`, `_bake.ts` — the type never round-trips the
 *  argument to a live call in the first place). This RUNTIME door guards what a type cannot see:
 *  a callable VALUE landing in a legitimate `z.dynamic`/deprecated-`z.value` slot at runtime. */
function assertNotBareCallableInDynamicSlot(symbolName: string, value: unknown, position: string): void {
  if (typeof value === "function" || is_callable_value(value)) {
    throw new Error(
      `${symbolName}: a callable argument crossed a z.dynamic slot (${position}) — declare this parameter ` +
        `z.procedure so its host-fn wrapper is minted at decode, synchronously, under the live region scope. ` +
        `A callable marshaled from a z.dynamic slot after an await binds a detached scope and can bypass the ` +
        `effect burst.`,
    );
  }
}

/** Bake-time-only: WHICH of `inSchema`'s TOP-LEVEL slots (the SAME shallow view
 *  `contractMayCarryCallable` reads — fixed tuple items / a homogeneous array's lone element /
 *  kwargs object fields) are bare `z.dynamic`. Shared position-detection behind BOTH runtime
 *  passes below that need it (`buildDynamicSlotCheck`'s callable ban, `buildOpaqueHandleUnwrap`'s
 *  handle unwrap) — one bake-time walk, one shape, no drift between the two consumers. Deliberately
 *  scoped IDENTICAL to `contractMayCarryCallable`'s own shallow slots: a callable (or a handle)
 *  buried inside a CONTAINER argument (`z.list(z.dynamic)`, `z.vector(z.dynamic)`, a dict field) is
 *  the shallow-gate-recursion gap — a separate, already-tracked finding neither consumer catches
 *  (a container BUILT FROM a real element codec, e.g. `z.list(z.instance(Ctor))`, needs no help
 *  from either pass: its own per-element codec already unwraps/bans at the container's normal
 *  decode). Named `"dynamic"` only — see `assertNotBareCallableInDynamicSlot`'s own doc for why the
 *  deprecated `"value"` alias and the banned `"schemeValue"` name are both out of scope here.
 *  `undefined` when the contract carries no `z.dynamic` slot at all (the overwhelming majority —
 *  zero cost at either call site). */
type DynamicSlotPositions =
  | { readonly kind: "kwargs"; readonly keys: readonly string[] }
  | { readonly kind: "all-positional" }
  | { readonly kind: "indices"; readonly indices: readonly number[] };

function dynamicSlotPositions(
  inSchema: z.ZodTypeAny,
  kwargsShape: Record<string, z.ZodTypeAny> | undefined,
): DynamicSlotPositions | undefined {
  if (kwargsShape) {
    const keys = Object.entries(kwargsShape)
      .filter(([, slot]) => z.lookupName(slot) === "dynamic")
      .map(([key]) => key);
    return keys.length === 0 ? undefined : { kind: "kwargs", keys };
  }
  const items = topLevelSchemas(inSchema);
  if (items === undefined) return undefined;
  // A homogeneous array-ish input's `topLevelSchemas` is always a ONE-item result standing for
  // EVERY decoded position (its own "array" branch); a fixed multi-item tuple's items map 1:1 to
  // positions. A one-item result is checked identically either way — a single fixed z.dynamic arg
  // has exactly one decoded position, the same as "check the array's one element type at every
  // position" when there happens to be exactly one position.
  if (items.length === 1) {
    return z.lookupName(items[0]) !== "dynamic" ? undefined : { kind: "all-positional" };
  }
  const indices = items.flatMap((item, i) => (z.lookupName(item) === "dynamic" ? [i] : []));
  return indices.length === 0 ? undefined : { kind: "indices", indices };
}

/** The runtime closure that checks a call's DECODED args at exactly the `z.dynamic` positions
 *  `dynamicSlotPositions` found, banning a bare callable there (see
 *  `assertNotBareCallableInDynamicSlot`'s own doc for the hazard). `undefined` (zero cost) when
 *  `positions` is. */
function buildDynamicSlotCheck(
  symbolName: string,
  positions: DynamicSlotPositions | undefined,
): ((decodedArgs: readonly unknown[]) => void) | undefined {
  if (positions === undefined) return undefined;
  switch (positions.kind) {
    case "kwargs": {
      const { keys } = positions;
      return (decodedArgs) => {
        const obj = decodedArgs[0] as Record<string, unknown>;
        for (const key of keys) assertNotBareCallableInDynamicSlot(symbolName, obj[key], `keyword argument :${key}`);
      };
    }
    case "all-positional":
      return (decodedArgs) =>
        decodedArgs.forEach((a, i) => assertNotBareCallableInDynamicSlot(symbolName, a, `argument ${i + 1}`));
    case "indices": {
      const { indices } = positions;
      return (decodedArgs) =>
        indices.forEach((i) => assertNotBareCallableInDynamicSlot(symbolName, decodedArgs[i], `argument ${i + 1}`));
    }
  }
}

/** THE HOST-WARD UNWRAP CHOKEPOINT for `z.dynamic` slots (whiteroom opaque-crossing contract,
 *  interop-access.ts's `markInteropPrivate` doc has the full statement): `z.dynamic`'s decode is
 *  pure identity (no transform — its whole contract is "impl does its own conversion"), so an
 *  `AOpaqueHandle` landing there crosses UNDECODED unless this pass catches it. Every OTHER slot
 *  kind already unwraps at its OWN codec's decode — a real codec's scheme face is never
 *  `AOpaqueHandle` unless it explicitly says so (`z.instance(Ctor)`, whose own decode does this
 *  same unwrap+assert) — so this is the ONE place a bare `z.dynamic` slot needs help. Scoped
 *  IDENTICAL to `buildDynamicSlotCheck` (see `dynamicSlotPositions`'s own doc for the shared-scope
 *  rationale and the shallow-gate-recursion gap this shares with it). `undefined` (zero cost) when
 *  `positions` is. */
function buildOpaqueHandleUnwrap(
  positions: DynamicSlotPositions | undefined,
): ((decodedArgs: readonly unknown[]) => readonly unknown[]) | undefined {
  if (positions === undefined) return undefined;
  const unwrap = (v: unknown): unknown => (v instanceof AOpaqueHandle ? v.instance : v);
  switch (positions.kind) {
    case "kwargs": {
      const { keys } = positions;
      return (decodedArgs) => {
        const obj = decodedArgs[0] as Record<string, unknown>;
        const next: Record<string, unknown> = { ...obj };
        for (const key of keys) next[key] = unwrap(obj[key]);
        return [next];
      };
    }
    case "all-positional":
      return (decodedArgs) => decodedArgs.map(unwrap);
    case "indices": {
      const idx = new Set(positions.indices);
      return (decodedArgs) => decodedArgs.map((a, i) => (idx.has(i) ? unwrap(a) : a));
    }
  }
}

/** Rosetta host fn in JS-LAND (decoded via the contract codecs). ctx-free for this step.
 *  `Rest` (inferred from `contract.inputRest`, defaulting to `undefined`) is the FIXED-prefix-
 *  plus-rest split — see `Contract`/`Impl` in `_bake.ts`. Absent `inputRest` ⇒ `Rest` stays
 *  `undefined` and `impl`'s signature is the plain fixed-arity form.
 *
 *  Declared return type is `CrossingResult<I,O,Rest,ARosettaProcedure>` (`_bake.ts`), not bare
 *  `ARosettaProcedure`: the AUTHOR-facing compile-time ban on a `z.schemeValue` slot (V ruling,
 *  mid-Phase-A — see `_bake.ts`'s own §1.7 doc for the full mechanism + why it lives on the
 *  RETURN type rather than transforming `contract`'s parameter type). `contract` itself stays
 *  the plain, UNTRANSFORMED `Contract<I,O,Rest>` — inference of I/O/Rest from the real call-site
 *  argument is byte-identical to before this ruling; only the computed RETURN type can collapse
 *  to a `ContractKindMismatch` shape. */
export function rosetta(tpl: TemplateStringsArray, ...sub: (string | number)[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: Contract<I, O, Rest>,
    impl: Impl<I, O, Rest>,
    opts: BakeRuntimeOpts = {},
  ): CrossingResult<I, O, Rest, ARosettaProcedure> => {
    const inSchema = normalizeInputVector(contract.input, contract.inputRest);
    const outSchema = normalizeVector(contract.output);
    const singleOut = isSingleOutput(contract.output);
    // `dynamic` OUTPUT slots are the declared NO-TRANSFORM escape hatch ("impl returns raw,
    // does its own conversion" — z.dynamic's own doc): running them through `z.encode` would
    // apply the scheme-side check to the RAW return BEFORE step 4's jsToScheme ever boxes
    // it, rejecting every impl that returns a plain JS object (the llm/mcp DerivableEntity
    // family — the (infer …) outage this flag fixes). Boxing IS their validation now: the
    // inbound-claims registry (rosetta.ts) totalizes the crossing (exotics borrow loudly,
    // bare promises door). Computed at bake, per slot, tuple-shaped outputs only — a
    // variadic array-ish output keeps the plain encode (no live `dynamic` variadic exists).
    // Keyed off `"dynamic"` only (not the deprecated `"value"` alias, not the banned
    // `"schemeValue"`) — the whiteroom's `instance(Ctor)` codec (scheme-zod.ts, the
    // live-object-holding identity crossing) does NOT extend this check: unlike `dynamic`, it is
    // a REAL codec with its own `encode` (`AOpaqueHandle.for`), so an `instance`-typed output
    // slot goes through the ordinary `z.encode` path below like any other typed output.
    const escapeSlots: readonly boolean[] = Array.isArray(contract.output)
      ? (contract.output as readonly unknown[]).map((slot) => z.lookupName(slot) === "dynamic")
      : [];
    // Default "source" — see Contract.provenance. "source" MINTS a fresh point; "pipe" is a
    // TRANSFORM that forwards input provenance — the load-bearing choice applied at step 3 below.
    const provenance = contract.provenance ?? "source";
    assertProvenanceRoleShape(name, provenance, inSchema, outSchema);
    // Cache class — see Contract.cacheClass (explicit, no kind default; absent = regenerateable;
    // the view/pure serialization gate; and why Lineage ⊥ cache, with infer — a provenance
    // SOURCE declaring cacheClass "pure" — as the standing proof).
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
    // for a contract that can hand the impl a live callable (`z.procedure`/`z.dynamic` input
    // slot — see `contractMayCarryCallable`'s doc for the full gate + the z.dynamic
    // adjudication); every other verb's `run` below skips the scope entirely — zero cost.
    const carriesCallable = contractMayCarryCallable(inSchema);

    // kwargs input: a plain-record `contract.inputRest` (its VALUES are ZodType, the CONTAINER
    // is not) marks a trailing kwargs OBJECT — hoisted here (bake-invariant off `contract.
    // inputRest` alone) so both the z.dynamic-callable door below and `run`'s own decode step
    // (§1) read the SAME computed shape instead of re-deriving it per call.
    const bakedInputRest: RestSpec = contract.inputRest;
    const kwargsShape = bakedInputRest !== undefined && !(bakedInputRest instanceof ZodType) ? bakedInputRest : undefined;

    // THE ROSETTA SCHEMEVALUE BAN lives at COMPILE TIME now (`CrossingContract`, `_bake.ts` —
    // V ruling, mid-Phase-A) — `contract`'s own parameter type already rejects a `z.schemeValue`
    // slot at the author's keyboard; nothing to check here at bake.

    // THE Z.DYNAMIC-CALLABLE DOOR (Ruling A, see `buildDynamicSlotCheck`'s own doc above) AND
    // the whiteroom opaque-handle host-ward unwrap (`buildOpaqueHandleUnwrap`'s own doc) — both
    // computed ONCE at bake off the SAME shared position detection (`dynamicSlotPositions`),
    // `undefined` (zero cost) for the overwhelming majority of contracts that carry no
    // `z.dynamic` input slot at all.
    const dynSlots = dynamicSlotPositions(inSchema, kwargsShape);
    const checkDynamicSlots = buildDynamicSlotCheck(name, dynSlots);
    const unwrapOpaqueHandles = buildOpaqueHandleUnwrap(dynSlots);

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

      // REGION DISCIPLINE (openRegionScope-gap Ruling A, membrane/region-scope.ts) —
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
        // (`kwargsShape` itself is bake-time-hoisted above, beside `checkDynamicSlots`.)
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
        let decodedArgs: readonly unknown[] = scope ? withRegionScope(scope, decode) : decode();
        // THE WHITEROOM OPAQUE-HANDLE UNWRAP fires HERE — right after decode, same reasoning as
        // the callable door below: `dynamic`'s decode is identity, so an `AOpaqueHandle` landing
        // in a bare `z.dynamic` slot is otherwise handed to the impl UNDECODED. See
        // `buildOpaqueHandleUnwrap`'s own doc for the mechanism + scope.
        if (unwrapOpaqueHandles) decodedArgs = unwrapOpaqueHandles(decodedArgs);
        // THE Z.DYNAMIC-CALLABLE DOOR fires HERE — right after decode, before the impl ever runs
        // (so a bad call never fires a partial effect first). `dynamic`'s decode is an identity
        // predicate (no transform), so checking post-decode is equivalent to checking the raw
        // scheme arg; see `buildDynamicSlotCheck`'s own doc above for the full mechanism + why
        // this is scoped to bare top-level slots only.
        checkDynamicSlots?.(decodedArgs);

        // 2. RUN the impl with a per-call **invocation `this`** — the SAME flat `CallCtx` the
        //    dispatch level already handed this wrapper, forwarded straight through (no second
        //    construction step). The impl still receives ONLY the decoded scheme args
        //    positionally — ctx is NOT a param. A ctx-coupled verb declares a `function` impl and
        //    reads run-state off `this` (`this.runCtx.signal` / `this.runCtx.signal?.aborted` /
        //    `this.invocation`); a pure verb is an arrow that ignores `this`, so
        //    `impl.call(this, …)` is byte-identical to `impl(…)`. async is implicit.
        //
        //    This ONE site carries the whole run model at runtime (docs/execution.md §CHOKEPOINT):
        //    args are decoded and the impl has NOT fired, so the run-cache interception (R2), the
        //    burst arm (W1, §BURST), and the read-clock stamp (W2, §READ-GUARD) all attach here,
        //    each reading its channel off `this.runCtx`:
        //    - `.cache` (R2) — a replay-hit serves the DECODED-FACE value in `result`'s place;
        //      steps 3–4 (provenance mint + encode + attestation) then run over it exactly as over
        //      a fresh impl return — values through the membrane, never restored around it.
        //    - `.effects` (W1) — a SIBLING per-run handle, not a `cache` field, so a burst run
        //      gathers sink effects with no `RunCache`. The fast-path bypass below therefore gates
        //      on BOTH `cache` and `effects` being absent (a run with neither is byte-identical to
        //      a pre-cache interpreter; the burst arm lives INSIDE `penetrateThroughCache`).
        //    - `.reads` (W2) — read-only here: when a burst gathers this penetration,
        //      `reads.tracker` stamps the entry's `enqueuedAtReadClock`. The guard CHECK itself
        //      runs in the eval loop, after each form.
        const runCache = this.runCtx.cache;
        const runEffects = this.runCtx.effects;
        const runReads = this.runCtx.reads;
        // Also wrapped in `withRegionScope` (belt-and-suspenders beside decode above): covers
        // the impl's own SYNCHRONOUS prefix (up to its first `await`) for a `z.dynamic` slot,
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

      // 3. PROVENANCE — the SAME spine as createRosettaWrapper (docs/membrane.md §SPINES). A
      //    "source"-role rosetta (default) MINTS a fresh point off ctx.currentInvocation; a "pipe"-role rosetta is a
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
      //
      //    THE ENCODE STEP RUNS UNDER `withMarshalCtx(this.runCtx, …)` — a codec whose `encode`
      //    mints a fresh AValue with no already-boxed operand to derive a ctx from (`list`/
      //    `vector`/`dict`'s own `firstCtx` covers the container case; the whiteroom's
      //    `instance(Ctor)` codec has NO operand at all, a raw class instance) reads
      //    `scheme-zod.ts`'s ambient `marshalCtx()` — by the time step 4 runs, any region scope
      //    opened for step 1/2 has already been closed (the `finally` above), so without this
      //    wrap `marshalCtx()` would fall to `CONSTANT_CTX`, and an `AOpaqueHandle` minted there
      //    would land in `CONSTANT_CTX`'s cache bucket for EVERY run — defeating the run-scoped
      //    identity `AOpaqueHandle.for` exists to hold (see that class's own header). Wrapping
      //    here is a strict improvement for every OTHER codec too: it's a no-op for scalars
      //    (never read ctx) and for containers' own `firstCtx` (which only falls to `marshalCtx()`
      //    on an EMPTY container, where the correct-vs-CONSTANT_CTX distinction is unobservable —
      //    a zero-length heap charge either way).
      if (singleOut) {
        // 1-tuple output: the impl returned a single value; encode it as a 1-vector.
        // A `dynamic` slot skips the codec entirely (see escapeSlots above).
        const encoded = escapeSlots[0]
          ? result
          : z.withMarshalCtx(this.runCtx, () => z.encode(outSchema, [result]))[0];
        const boxed: unknown = jsToScheme(this.runCtx, encoded, {}, resultProvenance);
        return forwards ? boxed : attestDeep(freshIfSingleton(boxed));
      }
      // multiple-values / array-ish output: the impl returned the values-vector already (an array
      // by the multi-output contract — `DecodedReturn` is the values-vector when output isn't a
      // 1-tuple), so it IS the `readonly unknown[]` the output codec encodes.
      const resultVector = result as readonly unknown[];
      const encoded = z.withMarshalCtx(this.runCtx, () =>
        escapeSlots.some(Boolean)
          ? resultVector.map((v, i) =>
              escapeSlots[i] ? v : z.encode(normalizeVector([contract.output[i] as never]), [v])[0],
            )
          : z.encode(outSchema, resultVector),
      );
      return encoded.map((v) => {
        const boxed: unknown = jsToScheme(this.runCtx, v, {}, resultProvenance);
        return forwards ? boxed : attestDeep(freshIfSingleton(boxed));
      });
    };

    const def: RosettaSymbolDef = {
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
      requiresConfig: contract.requiresConfig,
      // Compiler-facing fields — carried through AUTHORED, inert to the interpreter; the
      // harvest row resolves refPolicy's "shim" default. See Contract.emit/narrows/refPolicy.
      emit: contract.emit,
      narrows: contract.narrows,
      refPolicy: contract.refPolicy,
      // The extension bag (BakeRuntimeOpts.metadata → RosettaSymbolDef.metadata). Stamped as
      // DATA only — dynamic (fn-valued) fields are NEVER invoked here: bake must not resolve
      // metadata; resolution is read-time, against the assembly's activation (./metadata.js's
      // resolveMetadata).
      metadata: opts.metadata,
    };
    // Stage A2 — mint the A-VALUE directly; `.contract` carries the def every downstream
    // reader (schema-to-ts, the mercury harvest, capability.ts's requiresConfig/preludeOnly
    // gates) used to read straight off the record. `strategy` stays the resolved-role bag
    // the bind loop used to build (opaque until stage 3, per ACallable.ts's own doc).
    const rawRun = def.run as (this: CallCtx, ...args: unknown[]) => Promise<unknown>;
    const proc = new ARosettaProcedure({
      name,
      arity: { min: 0, max: null },
      contract: def,
      strategy: { provenance: def.provenance },
      impl: (args, callCtx) => rawRun.apply(callCtx, args) as Promise<SchemeValue>,
    });
    (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = provenance;
    if (cacheClass !== undefined) (proc as { cacheClass?: CacheClass }).cacheClass = cacheClass;
    if (callbackRoles !== undefined) (proc as { callbackRoles?: CallbackRoles }).callbackRoles = callbackRoles;
    // ERASE ONCE here: the runtime value is ALWAYS a real `ARosettaProcedure` — the
    // `CrossingResult` conditional is a caller-facing compile-time check only (see this
    // function's own doc + `_bake.ts`'s §1.7), never something this implementation computes.
    return proc as CrossingResult<I, O, Rest, ARosettaProcedure>;
  };
}
