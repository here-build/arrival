/**
 * RunContext teardown — the disposal half of docs/execution.md §HERMETIC's per-run identity
 * (RunContext.ts mints the identity; this module owns what happens when it ends).
 *
 * A `RunContext` is minted once per `exec()` call by default, but a REPL-style caller may
 * hand the SAME `RunContext` to N successive `execState`/`exec` passes (`ExecOptions.runCtx`,
 * generator-exec.ts) — a session's "one run, many passes" continuity. Anything scoped to that
 * RunContext (Stage 2's capability resources, `common/resources.ts`'s `runScoped`) must survive
 * across those passes and tear down exactly once, at the SESSION's end — never per pass, never
 * twice.
 *
 * Two teardown paths, by design:
 *   EXPLICIT — a caller (a plain `exec()` that minted its own RunContext, or a REPL host closing
 *     its session) calls {@link disposeRunContext} directly, or `await using`s a RunContext
 *     minted via `makeRunContext` (its `[Symbol.asyncDispose]` delegates here).
 *   BACKSTOP — a RunContext dropped without either (a REPL abandoned mid-session, a test that
 *     forgets to dispose) is still torn down once its last reference is collected, via a
 *     `FinalizationRegistry`. Best-effort by spec (GC timing is never guaranteed), so it exists
 *     to bound leakage, not to replace the explicit path.
 *
 * Both paths funnel through ONE idempotency guard (`disposed`), so an explicit dispose that
 * races the collector — or a collector callback firing after an explicit dispose already ran —
 * never double-tears-down.
 */

import type { RunContext } from "./RunContext.js";

type Teardown = () => Promise<void>;

/** One RunContext's accumulated teardowns + the guard against running them twice. Held OFF
 *  the RunContext object itself (a WeakMap side-table, `activationByValue`'s precedent in
 *  `common/symbols/_bake.ts`) so a plain `RunContext` literal never needs to carry lifecycle
 *  plumbing — only a RunContext that ACTUALLY accrued a per-run resource ever gets an entry. */
interface RunLifecycle {
  teardowns: Teardown[];
  disposed: boolean;
}

const lifecycles = new WeakMap<RunContext, RunLifecycle>();

/** The GC backstop: fires once a registered RunContext becomes unreachable. Held values are the
 *  `RunLifecycle` record itself (not the RunContext — the callback never sees the RunContext
 *  again, by design: `FinalizationRegistry`'s whole contract is "the target may already be
 *  gone"), so the fire-and-forget cleanup below only ever touches teardown closures, never the
 *  RunContext. `unregister` uses the RunContext itself as the token (sound: a caller invoking
 *  {@link disposeRunContext} still holds a live reference to it at that point). */
const backstop = new FinalizationRegistry<RunLifecycle>((lifecycle) => {
  if (lifecycle.disposed) return; // an explicit dispose already won the race
  lifecycle.disposed = true;
  const pending = lifecycle.teardowns;
  lifecycle.teardowns = [];
  // Detached — nothing is awaiting a GC callback; swallow so a teardown's rejection never
  // surfaces as an unhandled rejection.
  void Promise.allSettled(pending.map((fn) => fn()));
});

function lifecycleOf(runCtx: RunContext): RunLifecycle {
  let lifecycle = lifecycles.get(runCtx);
  if (lifecycle === undefined) {
    lifecycle = { teardowns: [], disposed: false };
    lifecycles.set(runCtx, lifecycle);
    backstop.register(runCtx, lifecycle, runCtx);
  }
  return lifecycle;
}

/** Register `teardown` to run once, at `runCtx`'s disposal (explicit or backstop — whichever
 *  fires first). Called by `common/resources.ts`'s `runScoped` on a resource's FIRST touch
 *  under a given RunContext — never eagerly, never more than once per (resource, RunContext)
 *  pair (that pairing's own single-flight is `runScoped`'s job; this function only accumulates
 *  the eventual cleanup). A RunContext already disposed accepts no further teardowns silently
 *  running one late is worse than a resource that never got the chance to register — but this
 *  is not expected to happen in practice, since nothing should still be spawning resources
 *  against a RunContext whose session has already ended. */
export function onRunContextDispose(runCtx: RunContext, teardown: Teardown): void {
  const lifecycle = lifecycleOf(runCtx);
  if (lifecycle.disposed) return; // session already over — nothing left to accumulate onto
  lifecycle.teardowns.push(teardown);
}

/** Tear `runCtx` down: run every accumulated teardown (parallel, best-effort — capability
 *  resources are independent per §STAGE-2's design; there is no cross-capability dependency
 *  graph to order against). Idempotent — a RunContext with no lifecycle entry (never touched a
 *  per-run resource) or already disposed (explicit dispose racing the backstop, or a second
 *  explicit call) is a no-op. This is the ONE function every teardown path funnels through:
 *  `exec()`'s owned-runCtx `finally` (generator-exec.ts), a REPL host's explicit session close,
 *  and a RunContext's own `[Symbol.asyncDispose]` (`makeRunContext`, RunContext.ts) all call
 *  this, never re-implement the guard. */
export async function disposeRunContext(runCtx: RunContext): Promise<void> {
  const lifecycle = lifecycles.get(runCtx);
  if (lifecycle === undefined || lifecycle.disposed) return;
  lifecycle.disposed = true;
  backstop.unregister(runCtx); // the explicit path won — the backstop must not fire again
  const pending = lifecycle.teardowns;
  lifecycle.teardowns = [];
  await Promise.allSettled(pending.map((fn) => fn()));
}
