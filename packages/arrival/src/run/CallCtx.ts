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

/** The value → capability-activation association (Stage 1b): `common/capability.ts`'s
 *  per-symbol bind loop calls {@link associateActivation} ONCE, at BIND time, keyed on the
 *  bound callable VALUE itself (ANativeProcedure/ARosettaProcedure/…) — never its name (a
 *  value can be re-exported/aliased under several names; the value's identity is what a real
 *  dispatch actually holds by the time it reaches {@link makeCallCtx}). A `WeakMap` — not a
 *  field on the value — keeps `common/capability.ts`'s activation type OUT of this leaf file
 *  (importing `Activation` here would reopen the very cycle this file's header note exists to
 *  avoid) and lets an unbound value (a lambda, a bare-fn registry survivor, a resource-less
 *  capability's proc that never called `associateActivation`) cost a plain WeakMap miss —
 *  nothing paid on that hot path. */
const activationByValue = new WeakMap<object, { readonly configuration: unknown; readonly resources: unknown }>();

/** Record `value`'s capability activation — called from `common/capability.ts`'s bind loop,
 *  once per bound native/rosetta/sequence/tagless(-guard) proc, right after construction. */
export function associateActivation(value: object, configuration: unknown, resources: unknown): void {
  activationByValue.set(value, { configuration, resources });
}

/** Build the `this` every callable body (native/rosetta/tagless/tagless-guard/sequence impl,
 *  or any raw fn bound straight into env) is invoked with. The ONE construction site — every
 *  dispatch site calls this instead of hand-building the shape. `runCtx` has NO default (the
 *  latent-hazard rule, docs/execution.md §CALLCTX); `testCallCtx()` is the sanctioned door for
 *  CONSTANT_CTX under test.
 *
 * `resolvedValue` (Stage 1b, optional): the callable VALUE this dispatch is about to invoke —
 * passed ONLY by the real evaluator dispatch sites (evaluator.ts's `evaluatePair`/
 * `applyArrowProc`), which actually hold the resolved value at the point they build this
 * `CallCtx`. When it carries an {@link associateActivation}-registered activation, this
 * enriches the returned `CallCtx` with that activation's `configuration`/`resources` — every
 * OTHER call site (APair.map's callback seam, srfi-1/13's HOF seams, op-helpers, the membrane)
 * omits it and pays nothing beyond the `undefined` check. */
export function makeCallCtx(
  runCtx: RunContext,
  currentInvocation?: InvocationLike,
  argProvenance?: readonly ReadonlySet<number>[],
  resolvedValue?: unknown,
): CallCtx {
  const activation =
    typeof resolvedValue === "object" && resolvedValue !== null ? activationByValue.get(resolvedValue) : undefined;
  return {
    runCtx,
    invocation: { currentInvocation },
    argProvenance,
    ...(activation !== undefined ? { configuration: activation.configuration, resources: activation.resources } : {}),
  };
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
