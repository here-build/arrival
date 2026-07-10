/**
 * RunContext — the per-run handle the hermetic-ctx migration threads, carried by
 * every value constructed during a run (`AValue.ctx`). See the memory
 * `project-arrival-hermetic-env-dissolution` for the full DAG.
 *
 * ── Why it exists ────────────────────────────────────────────────────────────
 * `exec()` must be HERMETIC: concurrent runs sharing one isolate (a CF Durable
 * Object) must not bleed run-state through module-level holders. The fix is to make
 * run-state DATA-LOCAL — minted once per exec, carried on the values/context rather
 * than reached for ambiently.
 *
 * ── What lives here, and what deliberately does NOT ──────────────────────────
 * Only state that is CONSTANT for one exec yet must differ between concurrent runs:
 * `strict` (nil-projection mode) and `heapMeter` (the per-run allocation bound).
 * It is intentionally lean; more fields land as ops move off the holders.
 *
 *  - NOT here: the singletons. nil/#t/#f/eof stay GLOBAL CONSTANTS — car-of-nil's
 *    strict is read from the THREADED run context (the `runCtx` parameter the
 *    tagless terms take), not from `nil.ctx`, so a constant nil bears no run-state
 *    and never needed to be per-run (the corrected plan).
 *  - NOT here: dynamic-extent state (exception-handler stack, call-site). That VARIES
 *    by call depth, so it can't ride a constant-per-run handle — it stays the holder
 *    family, dissolved separately through the trampoline.
 */

import type { RunCache } from "../run-cache.js";

/** Per-run allocation meter — the memory analogue of the wall-clock budget. The
 *  reference is fixed for the run; `used` is incremented in place as cells materialize. */
export interface HeapMeter {
  used: number;
  max: number;
}

/**
 * The per-run context. Minted once per `exec()` (see `makeRunContext`); carried
 * by every AValue built during the run (`AValue.ctx`), with ops reading run-state
 * off the operand (`operand.ctx.heapMeter`) or the threaded `runCtx` parameter
 * instead of a module holder.
 */
export interface RunContext {
  /** R7RS-strict nil-projection (`car`/`cdr` of nil throws) vs tolerant (yields nil). */
  readonly strict: boolean;
  /** Per-run allocation bound; `undefined` ⇒ unbounded (the default — only sandbox/agent runs opt in). */
  readonly heapMeter: HeapMeter | undefined;
  /** Freeze the borrowed JS source inside AJSObject/AJSArray the first time Scheme reads it, so a
   *  rosetta return (or any borrowed value) can't be mutated by the host afterward — prevention by
   *  construction, replacing the dev-only purity ASSERT. `false` opts out (host keeps it mutable). */
  readonly freezeRosettaReturns: boolean;
  /** The run's execution-budget signal, if any (see `EvalContext.signal` in evaluator.ts for the
   *  full war story — that's the trampoline's own copy, read at iteration boundaries). This is the
   *  SAME reference, stamped here at the same mint site, so every `runCtx` consumer (a callable
   *  body's `CallCtx.runCtx.signal`, not just the trampoline) can observe abort state — never
   *  independently re-derived, so the two can't drift out of sync. */
  readonly signal: AbortSignal | undefined;
  /** The run's cache (values/run-cache.ts — R2, arrival-mcp-rework-over-phases.md §2.2), if
   *  any; `undefined` ⇒ no interception (the default — only session/replay runs opt in). The
   *  baked rosetta `run` wrapper reads it HERE (`this.runCtx.cache`) — the same per-run
   *  hermetic seam `signal`/`heapMeter` ride — and gates record/replay per the stamped cache
   *  class. Constant for the run, like everything on this handle. */
  readonly cache: RunCache | undefined;
}

/** Mint a fresh per-run context for one `exec()`. The single place a RunContext is born. */
export function makeRunContext(
  opts: {
    strict?: boolean;
    heapBudget?: number;
    freezeRosettaReturns?: boolean;
    signal?: AbortSignal;
    cache?: RunCache;
  } = {},
): RunContext {
  return {
    strict: opts.strict ?? false,
    heapMeter: opts.heapBudget === undefined ? undefined : { used: 0, max: opts.heapBudget },
    freezeRosettaReturns: opts.freezeRosettaReturns ?? true,
    signal: opts.signal,
    cache: opts.cache,
  };
}

/**
 * The run-NEUTRAL context. Carried by values that outlive any single run: the
 * singletons, quoted-literal AST nodes (`evalQuote` returns them by reference across
 * runs), and everything constructed at bootstrap before a run exists. Immutable,
 * shared, bears no run-state (`strict=false`, no meter) — so it can never carry one
 * run's mode/meter into another run.
 */
export const CONSTANT_CTX: RunContext = Object.freeze({
  strict: false,
  heapMeter: undefined,
  freezeRosettaReturns: true,
  signal: undefined,
  cache: undefined,
});
