/**
 * Dynamic call site — a thin facade over `RunContext.ambient.dynSite` (P19: no global state).
 * A leaf so modules below evaluator.ts can install one without creating a cycle.
 *
 * WHY EXTRACTED: the reverse-membrane crossing (`rosetta.ts` ACallable branch,
 * `scheme-zod.ts` `z.procedure().decode`) installs a dynamic call site around a
 * re-entrant scheme call so a lambda invoked from host JS nests under the
 * symbol invocation that exported it, not the definition-time lexical parent.
 * `evaluator.ts` already imports `AmbientRuntime.ts` → `rosetta.ts`, so
 * `rosetta.ts` importing back from `evaluator.ts` would cycle. Both sides import
 * this dependency-free leaf instead (same rationale as CallCtx.ts's extraction).
 *
 * The slot lives on the run's own `ambient` holder, so two concurrent runs never observe
 * each other's site. Every caller has a RunContext (evaluator `ctx.runCtx` / `callCtx.runCtx`,
 * a region scope's `scope.runCtx`). The window is SYNC in the sense that matters: the holder is
 * read in the callee's synchronous prologue (evalLambda), then restored when the CALL returns —
 * the callee's returned Promise (a native async procedure) is passed through, never awaited
 * inside the window. A frozen `ambient` (CONSTANT_CTX) holds no site: reads see `undefined`,
 * windows run `fn` bare.
 */

import type { RunContext } from "../run/RunContext.js";
import type { ClosureCallWindow } from "./provenance-hooks.js";

/** Opaque tag for one dynamic evaluation of an AST node. The tap implementation
 *  (`provenance/trace.ts` Invocation) owns the real shape; this leaf and
 *  evaluator.ts only thread it as an opaque parent pointer. */
export type Invocation = unknown;

/** Read the run's current site — the ALambda runner's prologue falls back to
 *  `ctx.currentInvocation` when unset (see evalLambda). */
export function currentDynamicCallSite(runCtx: RunContext): Invocation | undefined {
  return runCtx.ambient.dynSite;
}

export function isStrictDescendant(a: Invocation | undefined, b: Invocation | undefined): boolean {
  if (!a || !b) return false;
  // Invocation is opaque here — the tap owns its shape; narrow structurally to walk parent.
  type ParentLinked = { parent: ParentLinked | null };
  for (let p = (a as ParentLinked).parent; p; p = p.parent) if (p === b) return true;
  return false;
}

function windowDynSite<T>(runCtx: RunContext, site: Invocation | undefined, fn: () => T): T {
  const holder = runCtx.ambient;
  if (Object.isFrozen(holder)) return fn();
  const had = Object.hasOwn(holder, "dynSite");
  const saved = holder.dynSite;
  holder.dynSite = site;
  try {
    return fn();
  } finally {
    if (had) holder.dynSite = saved;
    else delete holder.dynSite;
  }
}

/** The closure-call window of the apply site currently in its synchronous prologue (see
 *  {@link enterCallSite}); `undefined` outside one or when the run does not window closure calls. */
export function currentClosureCall(runCtx: RunContext): ClosureCallWindow | undefined {
  return runCtx.ambient.closureCall;
}

/**
 * {@link enterDynamicCallSite} for the evaluator's generic apply term, which also publishes the
 * apply site's closure-call window for the same synchronous window. A host verb that fans
 * (`map`, `filter`, `vector-map`, …) invokes its element callbacks synchronously, in index order,
 * with no `CallCtx` of its own; each reads the window here, so a direct port callback is addressed
 * by the TRACK of the `(map fetch-item …)` site rather than by when it completes.
 */
export function enterCallSite<T>(
  runCtx: RunContext,
  site: Invocation | undefined,
  closureCall: ClosureCallWindow | undefined,
  callNode: object,
  fn: () => T,
): T {
  const holder = runCtx.ambient;
  if (Object.isFrozen(holder)) return fn();
  const hadWindow = Object.hasOwn(holder, "closureCall");
  const savedWindow = holder.closureCall;
  const hadNode = Object.hasOwn(holder, "callNode");
  const savedNode = holder.callNode;
  holder.closureCall = closureCall;
  holder.callNode = callNode;
  try {
    return windowDynSite(runCtx, site, fn);
  } finally {
    if (hadWindow) holder.closureCall = savedWindow;
    else delete holder.closureCall;
    if (hadNode) holder.callNode = savedNode;
    else delete holder.callNode;
  }
}

/** The call expression of the apply site currently in its synchronous prologue (see {@link enterCallSite}). */
export function currentCallNode(runCtx: RunContext): object | undefined {
  return runCtx.ambient.callNode;
}

/**
 * Install `dynSite` as `runCtx`'s dynamic call site for the synchronous call `fn` — a genuine NEW
 * call site (direct-dispatch sites: evaluatePair, applyArrowProc, named-let kickoff), no "prefer
 * deeper" comparison — the call IS the site. Restored when `fn` returns.
 */
export function enterDynamicCallSite<T>(runCtx: RunContext, site: Invocation | undefined, fn: () => T): T {
  return windowDynSite(runCtx, site, fn);
}

/**
 * Install `dynSite` for `fn`, preferring the DEEPER of the run's current site and `dynSite`.
 * Keeping a deeper current site nests genuinely-deeper work under itself instead of scattering
 * it to the outer boundary (needed for a TCO loop calling a passed-in lambda — see
 * evaluator.ts wrapLambdaArgs).
 */
export function withDynamicCallSite<T>(runCtx: RunContext, dynSite: Invocation | undefined, fn: () => T): T {
  const saved = runCtx.ambient.dynSite;
  return windowDynSite(runCtx, isStrictDescendant(saved, dynSite) ? saved : dynSite, fn);
}
