// Ejected from common/symbols/_bake.ts: ACallable.ts needs makeCallCtx (a real function
// call inside applyCallback, not just a type), and _bake.ts imports common/scheme-zod.ts —
// that made ACallable.ts transitively import scheme-zod.ts at module-eval time. scheme-zod.ts
// also imports ACallable.ts (for ALambda/ANativeProcedure/ARosettaProcedure), so entering the
// cycle from certain paths (any code touching values/lineage-shadow.ts before scheme-zod.ts
// resolves cleanly) left a z.instanceof(...) codec's captured class permanently undefined —
// z.instanceof captures its argument BY VALUE at call time, not as a live binding, so once
// broken it stays broken for that schema instance's lifetime. CallCtx/makeCallCtx don't need
// any of _bake.ts's zod-contract machinery, so they live here instead: a leaf values/primitives
// file, breaking the cycle at its narrowest point. _bake.ts re-exports both from here for
// existing importers.

import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import { type InvocationLike } from "../../membrane/rosetta.js";

/**
 * The ONE `this` every callable body sees — the dispatch-level receiver AND the
 * per-verb invocation context, fused into one shape.
 * `runCtx` is never optional (the constructor requires it — no default, see `makeCallCtx`
 * below), so a verb never needs its own `?? CONSTANT_CTX` fallback. `invocation` is the per-call-site
 * provenance carrier (genuinely call-varying, unlike `runCtx` — never lives on RunContext).
 * `argProvenance` is the opt-in per-arg DEEP provenance vector (rosetta.ts's
 * `RosettaOptions.argProvenance`, aligned to the call's scheme args) — folded flat onto
 * this same `this` instead of a second nested `{ ctx: { … } }` nesting one level down;
 * absent for every dispatch path that doesn't request it. Flat, not lazy getters: `runCtx`
 * is already a cheap frozen per-run object and `invocation`/`argProvenance` are cheap
 * carriers, so there's nothing expensive to defer.
 */
export interface CallCtx {
  readonly runCtx: RunContext;
  readonly invocation: { currentInvocation: InvocationLike | undefined };
  readonly argProvenance?: readonly ReadonlySet<number>[];
}

/** Build the `this` every callable body (native/rosetta/tagless/tagless-guard/sequence impl,
 *  or any raw fn bound straight into env) is invoked with. The ONE construction site — every
 *  dispatch site (evaluator bare-fn call-head, `applyCallback`'s bare-fn fallback, the native
 *  bind in `capability.ts`, `createRosettaWrapper`'s impl invocation) calls this instead of
 *  hand-building the shape.
 *
 *  `runCtx` has no default (Wave 0 of the CONSTANT_CTX rework §2.6): verified zero
 *  production callers leaned on
 *  the old `= CONSTANT_CTX` default — every real dispatch site already passed an explicit
 *  `runCtx` — so the default was a latent hazard (the easiest path for the next fallback to
 *  land on), not a load-bearing convenience. `testCallCtx()` remains the sanctioned door for
 *  CONSTANT_CTX under test. */
export function makeCallCtx(
  runCtx: RunContext,
  currentInvocation?: InvocationLike,
  argProvenance?: readonly ReadonlySet<number>[],
): CallCtx {
  return { runCtx, invocation: { currentInvocation }, argProvenance };
}

/**
 * The sanctioned DIRECT-CALL idiom: tests and host code invoking a
 * verb impl/wrapper outside a real dispatch (`run.call(testCallCtx(), …args)`) build a
 * REAL `CallCtx` instead of leaning on `this` optionality — `this` is never optional on a
 * callable body's signature, so nothing downstream needs a nullable-`this` fallback.
 * A thin wrapper over `makeCallCtx(CONSTANT_CTX, …)`: `CONSTANT_CTX` survives ONLY inside
 * this explicit constructor, never as an implicit fallback threaded through a verb's
 * `this?.` read (as of Wave 0, `makeCallCtx` itself takes no default — see above).
 * `overrides` lets a call site supply a
 * real `InvocationLike` (to exercise provenance minting) or a non-default `RunContext`
 * without hand-building the whole `{runCtx, invocation: {…}}` shape.
 */
export function testCallCtx(overrides?: {
  runCtx?: RunContext;
  currentInvocation?: InvocationLike;
  argProvenance?: readonly ReadonlySet<number>[];
}): CallCtx {
  return makeCallCtx(overrides?.runCtx ?? CONSTANT_CTX, overrides?.currentInvocation, overrides?.argProvenance);
}

// Every dispatch path constructs a full CallCtx via makeCallCtx (which never yields
// nullable fields), and direct calls use testCallCtx() — the null-`this` case is
// uninhabited, and `this: CallCtx` on the wrapper signatures makes an unbound call a
// COMPILE error at every typed call site. A runtime check for a statically-excluded
// state would be dishonesty (honest-types rule), not safety — so none exists.
