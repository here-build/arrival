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
 * The ONE `this` every callable body sees — the dispatch-level receiver AND the per-verb
 * invocation context, fused into one shape. `runCtx` is never optional, so a verb never
 * needs a `?? CONSTANT_CTX` fallback. `invocation` is the per-call-site provenance carrier
 * (genuinely call-varying, unlike `runCtx` — never lives on RunContext). `argProvenance`
 * is the opt-in per-arg DEEP provenance vector, aligned to the call's scheme args, folded
 * flat onto this same `this` rather than nested one level down; absent for every dispatch
 * path that doesn't request it. Flat, not lazy getters: every field is already a cheap
 * carrier, so there is nothing expensive to defer.
 */
export interface CallCtx {
  readonly runCtx: RunContext;
  readonly invocation: { currentInvocation: InvocationLike | undefined };
  readonly argProvenance?: readonly ReadonlySet<number>[];
}

/** Build the `this` every callable body (native/rosetta/tagless/tagless-guard/sequence impl,
 *  or any raw fn bound straight into env) is invoked with. The ONE construction site — every
 *  dispatch site calls this instead of hand-building the shape.
 *
 *  `runCtx` has NO default: every real dispatch site passes an explicit `runCtx`, so a
 *  `= CONSTANT_CTX` default would be a latent hazard (the easiest landing spot for the next
 *  errant fallback), not a convenience. `testCallCtx()` is the sanctioned door for
 *  CONSTANT_CTX under test. */
export function makeCallCtx(
  runCtx: RunContext,
  currentInvocation?: InvocationLike,
  argProvenance?: readonly ReadonlySet<number>[],
): CallCtx {
  return { runCtx, invocation: { currentInvocation }, argProvenance };
}

/**
 * The sanctioned DIRECT-CALL idiom: tests and host code invoking a verb impl/wrapper
 * outside a real dispatch (`run.call(testCallCtx(), …args)`) build a REAL `CallCtx` rather
 * than leaning on `this` optionality. A thin wrapper over `makeCallCtx(CONSTANT_CTX, …)`:
 * `CONSTANT_CTX` survives ONLY inside this explicit constructor, never as an implicit
 * fallback threaded through a verb's `this?.` read. `overrides` lets a call site supply a
 * real `InvocationLike` (to exercise provenance minting) or a non-default `RunContext`
 * without hand-building the whole shape.
 */
export function testCallCtx(overrides?: {
  runCtx?: RunContext;
  currentInvocation?: InvocationLike;
  argProvenance?: readonly ReadonlySet<number>[];
}): CallCtx {
  return makeCallCtx(overrides?.runCtx ?? CONSTANT_CTX, overrides?.currentInvocation, overrides?.argProvenance);
}

// The null-`this` case is uninhabited: `this: CallCtx` on the wrapper signatures makes an
// unbound call a COMPILE error at every typed call site. A runtime check for a statically-
// excluded state would be dishonesty (honest-types rule), not safety — so none exists.
