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
 * The ONE `this` every callable body sees (docs/RUN-MODEL.md §CALLCTX) — the dispatch-level
 * receiver `runCtx` fused with the per-call-site provenance carrier `invocation` and the
 * opt-in per-arg DEEP provenance vector `argProvenance`. Flat, not nested lazy getters: every
 * field is a cheap carrier, nothing to defer.
 *
 * `invocation` is genuinely call-varying (unlike `runCtx`, which is constant per run) — it
 * never lives on RunContext. `argProvenance` aligns to the call's scheme args and is absent
 * for every dispatch path that doesn't request it.
 */
export interface CallCtx {
  readonly runCtx: RunContext;
  readonly invocation: { currentInvocation: InvocationLike | undefined };
  readonly argProvenance?: readonly ReadonlySet<number>[];
}

/** Build the `this` every callable body (native/rosetta/tagless/tagless-guard/sequence impl,
 *  or any raw fn bound straight into env) is invoked with. The ONE construction site — every
 *  dispatch site calls this instead of hand-building the shape. `runCtx` has NO default (the
 *  latent-hazard rule, docs/RUN-MODEL.md §CALLCTX); `testCallCtx()` is the sanctioned door for
 *  CONSTANT_CTX under test. */
export function makeCallCtx(
  runCtx: RunContext,
  currentInvocation?: InvocationLike,
  argProvenance?: readonly ReadonlySet<number>[],
): CallCtx {
  return { runCtx, invocation: { currentInvocation }, argProvenance };
}

/**
 * The sanctioned DIRECT-CALL door (docs/RUN-MODEL.md §CALLCTX): tests and host code invoking a
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

// The null-`this` case is uninhabited (docs/RUN-MODEL.md §CALLCTX): `this: CallCtx` on the
// wrapper signatures makes an unbound call a COMPILE error at every typed call site, so no
// runtime door guards a statically-excluded state.
