// A leaf values/primitives file, deliberately NOT in common/symbols/_bake.ts: _bake.ts
// imports scheme-zod.ts, which imports ACallable.ts back, and ACallable.ts needs makeCallCtx
// as a real call. Housing makeCallCtx in _bake.ts closes that cycle, and entering it from the
// wrong path leaves a z.instanceof(...) codec's captured class permanently undefined —
// z.instanceof captures its argument BY VALUE at call time, not as a live binding, so once
// broken it stays broken for that schema instance's lifetime. CallCtx/makeCallCtx need none of
// _bake.ts's zod machinery, so they live here, breaking the cycle at its narrowest point.
// _bake.ts re-exports both for existing importers.

import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import { type InvocationLike } from "../membrane/rosetta.js";

/**
 * The ONE `this` every callable body sees (docs/execution.md §CALLCTX) — the dispatch-level
 * receiver `runCtx` fused with the per-call-site provenance carrier `invocation` and the
 * opt-in per-arg DEEP provenance vector `argProvenance`. Flat, not nested lazy getters: every
 * field is a cheap carrier, nothing to defer.
 *
 * `invocation` is genuinely call-varying (unlike `runCtx`, which is constant per run) — it
 * never lives on RunContext. `argProvenance` aligns to the call's scheme args and is absent
 * for every dispatch path that doesn't request it.
 *
 * `configuration`/`resources` (Stage 1b, docs/execution.md §CALLCTX): the SAME per-env
 * `Activation` a builder-form `symbols` closes over the outer closure (common/capability.ts),
 * now ALSO reachable off `this` at a real dispatch — a PARALLEL channel, not a replacement:
 * the existing closure-based read stays untouched. Absent for the vast majority of dispatch
 * paths (a lexical lambda call, a resource-less capability, any `makeCallCtx` call site that
 * never threads a resolved value) — optional, typed `unknown` here on purpose (narrowed by a
 * capability's own `Activation<C,R>` generics in stage 1c; this stage only wires the runtime
 * carrier). */
export interface CallCtx {
  readonly runCtx: RunContext;
  readonly invocation: { currentInvocation: InvocationLike | undefined };
  readonly argProvenance?: readonly ReadonlySet<number>[];
  readonly configuration?: unknown;
  readonly resources?: unknown;
}

/** The value → owning-capability association (1d): `common/capability.ts`'s per-symbol bind loop
 *  calls {@link associateCapability} ONCE, at BIND time, keyed on the bound callable VALUE itself
 *  (ANativeProcedure/ARosettaProcedure/…) — never its name (a value can be re-exported/aliased
 *  under several names; the value's identity is what a real dispatch actually holds by the time it
 *  reaches {@link makeCallCtx}).
 *
 *  Payload: the owning `capability` (opaque `object` — importing `EnvCapability` here would reopen
 *  the cycle this file's header note exists to avoid) plus the per-ASSEMBLY validated
 *  `configuration` (known at bind, constant across the run). RESOURCES are deliberately NOT here:
 *  they are per-RunContext, produced lazily on demand, and read at dispatch off
 *  `runCtx.capabilityResources.get(capability)` (see makeCallCtx) — the store the RunContext owns,
 *  keyed by this same capability object. A `WeakMap` — not a field on the value — keeps the
 *  capability type out of this leaf file and lets an unbound value (a lambda, a resource-less
 *  survivor) cost a plain miss. */
const capabilityByValue = new WeakMap<
  object,
  { readonly capability: object; readonly configuration: unknown; readonly readsResources: boolean }
>();

/** Record `value`'s owning capability + assembly config — called from `common/capability.ts`'s
 *  bind loop, once per bound native/rosetta/sequence/tagless(-guard) proc, right after
 *  construction. Re-attributing an ALREADY-bound value to a DIFFERENT capability is a declaration
 *  bug (a symbol belongs to exactly one owner) and throws; an idempotent re-bind under the SAME
 *  capability (same value re-run through the loop) is allowed.
 *
 *  `readsResources` gates whether this value's `this.resources` is fetched from the run's
 *  per-capability store (see makeCallCtx). `true` for the per-run-resource consumers (define-form
 *  symbols; constructor-form sequence/tagless/tagless-guard/rosetta). `false` for constructor-form
 *  `native` (its resources, when any, are read through the capability's own builder closure — e.g.
 *  arrival/loader — never `this.resources`; triggering the store here would DOUBLE-spawn them). */
export function associateCapability(
  value: object,
  capability: object,
  configuration: unknown,
  readsResources: boolean,
): void {
  const existing = capabilityByValue.get(value);
  if (existing !== undefined && existing.capability !== capability) {
    throw new Error("associateCapability: value already owned by a different capability");
  }
  capabilityByValue.set(value, { capability, configuration, readsResources });
}

/** Build the `this` every callable body (native/rosetta/tagless/tagless-guard/sequence impl,
 *  or any raw fn bound straight into env) is invoked with. The ONE construction site — every
 *  dispatch site calls this instead of hand-building the shape. `runCtx` has NO default (the
 *  latent-hazard rule, docs/execution.md §CALLCTX); `testCallCtx()` is the sanctioned door for
 *  CONSTANT_CTX under test.
 *
 * `resolvedValue` (1d, optional): the callable VALUE this dispatch is about to invoke — passed
 * ONLY by the real evaluator dispatch sites (evaluator.ts's `evaluatePair`/`applyArrowProc`),
 * which actually hold the resolved value at the point they build this `CallCtx`. When it carries
 * an {@link associateCapability}-registered owner, this enriches the returned `CallCtx` with the
 * assembly `configuration` and the run's resources for that capability — the latter fetched from
 * `runCtx.capabilityResources.get(capability)`, which lazily produces (and thereafter reuses) the
 * bag for THIS run. That fetch is a MaybePromise: a `resources` bag whose acquire is still in
 * flight arrives as a Promise the impl (or the interpreter) resolves; a warm one is a plain value.
 * Every OTHER call site (APair.map's callback seam, srfi-1/13's HOF seams, op-helpers, the
 * membrane) omits `resolvedValue` and pays nothing beyond the `undefined` check. */
export function makeCallCtx(
  runCtx: RunContext,
  currentInvocation?: InvocationLike,
  argProvenance?: readonly ReadonlySet<number>[],
  resolvedValue?: unknown,
): CallCtx {
  const owner =
    typeof resolvedValue === "object" && resolvedValue !== null ? capabilityByValue.get(resolvedValue) : undefined;
  return {
    runCtx,
    invocation: { currentInvocation },
    argProvenance,
    ...(owner !== undefined
      ? {
          configuration: owner.configuration,
          resources: owner.readsResources ? resolveCapabilityResources(runCtx, owner.capability, owner.configuration) : undefined,
        }
      : {}),
  };
}

/** Fetch (producing + caching on first touch) a capability's `Resources` bag for `runCtx`, keyed
 *  by the capability in the run's own `capabilityResources` store. A plain get-or-compute: on a
 *  miss, call the capability's `["arrival/get-resources"]` (fed the per-assembly `configuration`
 *  the association carries) and store the result; a pending bag is replaced in-slot by its
 *  resolved value on settle. Called structurally (no capability-layer import) — the leaf boundary
 *  this file guards. The `has`-then-`set` is a sound semaphore under JS's single-dispatch model
 *  (see {@link CapabilityResourceStore}); a run with no store (CONSTANT_CTX) yields `undefined`. */
function resolveCapabilityResources(runCtx: RunContext, capability: object, configuration: unknown): unknown {
  const store = runCtx.capabilityResources;
  if (store === undefined) return undefined;
  if (!store.has(capability)) {
    const produced = (
      capability as { ["arrival/get-resources"](runCtx: RunContext, configuration: unknown): unknown }
    )["arrival/get-resources"](runCtx, configuration);
    store.set(capability, produced);
    if (produced instanceof Promise) void produced.then((resolved) => store.set(capability, resolved));
  }
  return store.get(capability);
}

/**
 * The sanctioned DIRECT-CALL door (docs/execution.md §CALLCTX): tests and host code invoking a
 * verb impl/wrapper outside a real dispatch (`run.call(testCallCtx(), …args)`) build a REAL
 * `CallCtx` over `CONSTANT_CTX` here rather than leaning on `this` optionality — `CONSTANT_CTX`
 * survives ONLY inside this explicit constructor, never as an implicit `this?.` fallback in a
 * verb body. `overrides` lets a call site supply a real `InvocationLike` (to exercise
 * provenance minting) or a non-default `RunContext` without hand-building the whole shape.
 */
export function testCallCtx(overrides?: {
  runCtx?: RunContext;
  currentInvocation?: InvocationLike;
  argProvenance?: readonly ReadonlySet<number>[];
}): CallCtx {
  return makeCallCtx(overrides?.runCtx ?? CONSTANT_CTX, overrides?.currentInvocation, overrides?.argProvenance);
}

// The null-`this` case is uninhabited (docs/execution.md §CALLCTX): `this: CallCtx` on the
// wrapper signatures makes an unbound call a COMPILE error at every typed call site, so no
// runtime door guards a statically-excluded state.
