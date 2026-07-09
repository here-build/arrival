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
  readonly invocation: { currentInvocation: unknown };
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
