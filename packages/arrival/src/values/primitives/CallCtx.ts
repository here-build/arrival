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

/**
 * Runtime door (P5, docs/PRINCIPLES.md) for a verb invoked without a real `CallCtx` as
 * `this` — the exact silent-degrade class that hid the B2-rosetta mint regression until
 * `conservation.law` caught it (R-CTX-3, docs/working-proposals/rosetta-ctx-single-channel.md).
 * Every real dispatch path (the evaluator's apply arms, the four binder adapters in
 * `capability.ts`) constructs a `CallCtx` via `makeCallCtx` before invoking; a direct JS/test
 * call must do the same instead of relying on a `this?.` fallback to `CONSTANT_CTX` — use
 * `testCallCtx()` (or `makeCallCtx(...)` directly) as the explicit `.call`/`.apply` receiver.
 */
export function missingCallCtxDoor(verbName?: string): Error {
  return new Error(
    `${verbName ?? "a verb"} was invoked without a CallCtx \`this\` — every real dispatch path (the ` +
      "evaluator's apply arms, the four binder adapters) constructs one via makeCallCtx before " +
      "invoking; a direct call must too. Use testCallCtx() (or makeCallCtx(...) directly) as the " +
      "explicit receiver, e.g. `run.call(testCallCtx(), …args)` — never a bare call or an ad hoc " +
      "`{}`/`def` `this`. A silent CONSTANT_CTX fallback here is exactly what hid the B2-rosetta " +
      "mint regression until conservation.law caught it " +
      "(docs/working-proposals/rosetta-ctx-single-channel.md R-CTX-3).",
  );
}
