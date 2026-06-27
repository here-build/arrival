/**
 * RunContext — the per-run handle the hermetic-ctx migration threads, and (later)
 * every value constructed during a run carries. See the memory
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
 *    strict is read from the active run's holder, not from `nil.ctx`, so a constant
 *    nil bears no run-state and never needed to be per-run (the corrected plan).
 *  - NOT here: dynamic-extent state (exception-handler stack, call-site). That VARIES
 *    by call depth, so it can't ride a constant-per-run handle — it stays the holder
 *    family, dissolved separately through the trampoline.
 */

/** Per-run allocation meter — the memory analogue of the wall-clock budget. The
 *  reference is fixed for the run; `used` is incremented in place as cells materialize. */
export interface HeapMeter {
  used: number;
  max: number;
}

/**
 * The per-run context. Minted once per `exec()` (see `makeRunContext`); eventually
 * carried by every AValue built during the run, with ops reading run-state off the
 * operand (`operand.ctx.heapMeter`) instead of a module holder.
 */
export interface RunContext {
  /** R7RS-strict nil-projection (`car`/`cdr` of nil throws) vs tolerant (yields nil). */
  readonly strict: boolean;
  /** Per-run allocation bound; `undefined` ⇒ unbounded (the default — only sandbox/agent runs opt in). */
  readonly heapMeter: HeapMeter | undefined;
  /** Tier-2 speculative evaluation: fan-out ops (filter/map) may emit a lazy AHalfBaked
   *  collection instead of awaiting the whole promise fan, so a monotone outer can early-collapse.
   *  (Was the `_speculate` apply-boundary holder; read off `operand.ctx`/`runCtx` instead.) */
  readonly speculate: boolean;
  /** Dev-only: when true, the syntax-rules expander emits a console trace of macro
   *  matching/expansion. A host/interpreter option (replaces the `DEBUG` Scheme
   *  variable), off by default; threaded to the expander via the macro invoke's runCtx. */
  readonly debug: boolean;
}

/** Mint a fresh per-run context for one `exec()`. The single place a RunContext is born. */
export function makeRunContext(opts: { strict?: boolean; heapBudget?: number; speculate?: boolean; debug?: boolean } = {}): RunContext {
  return {
    strict: opts.strict ?? false,
    heapMeter: opts.heapBudget === undefined ? undefined : { used: 0, max: opts.heapBudget },
    speculate: opts.speculate ?? false,
    debug: opts.debug ?? false,
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
  speculate: false,
  debug: false,
});
