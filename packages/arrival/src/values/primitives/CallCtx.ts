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
import { type InvocationLike } from "../../rosetta.js";

/**
 * The ONE `this` every callable body sees — the dispatch-level receiver AND the
 * per-verb invocation context, fused (docs/working-proposals/callctx-unification.md,
 * docs/working-proposals/rosetta-ctx-single-channel.md R-CTX-1).
 * `runCtx` is never optional (the constructor bakes in the `CONSTANT_CTX` default), so a
 * verb never needs its own `?? CONSTANT_CTX` fallback. `invocation` is the per-call-site
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
 *  hand-building the shape. */
export function makeCallCtx(
  runCtx: RunContext = CONSTANT_CTX,
  currentInvocation?: InvocationLike,
  argProvenance?: readonly ReadonlySet<number>[],
): CallCtx {
  return { runCtx, invocation: { currentInvocation }, argProvenance };
}

/**
 * The sanctioned DIRECT-CALL idiom (R-CTX-4,
 * docs/working-proposals/rosetta-ctx-single-channel.md): tests and host code invoking a
 * verb impl/wrapper outside a real dispatch (`run.call(testCallCtx(), …args)`) build a
 * REAL `CallCtx` instead of leaning on `this` optionality — the optionality R-CTX-3 kills.
 * A thin wrapper over `makeCallCtx(CONSTANT_CTX, …)`: `CONSTANT_CTX` survives ONLY inside
 * this explicit constructor (or `makeCallCtx()`'s own default), never as an implicit
 * fallback threaded through a verb's `this?.` read. `overrides` lets a call site supply a
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

// `missingCallCtxDoor` (the R-CTX-3 migration door) is DELETED (2026-07-10, V): with the
// ctx tranches complete, every dispatch path constructs a full CallCtx via makeCallCtx
// (which never yields nullable fields) and direct calls use testCallCtx() — the null-this
// case is uninhabited, and `this: CallCtx` on the wrapper signatures makes an unbound call
// a COMPILE error at every typed call site. A runtime check for a statically-excluded
// state is the dishonesty (honest-types rule), not the safety.
