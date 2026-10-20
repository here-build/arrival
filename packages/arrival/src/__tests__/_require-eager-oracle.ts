/**
 * Eager-stamp test doors — a run that accumulates provenance (`eagerStamps: true`).
 *
 * Production runs mint with `eagerStamps: false`: hot paths skip accumulation unless
 * something opts in. The suites that assert REAL accumulated stamps (CI agreement oracle,
 * lineage goldens, conservation, standalone native-op calls) opt in PER RUN, not per
 * process: the flag rides the `RunContext` (P17-P19: no global state), so concurrent
 * runs with and without it never cross.
 *
 * - `execEager` / `execStateEager` / `execOverFrameEager` / `execStateOverFrameEager`:
 *   the exec doors with `eagerStamps: true` merged into the options.
 * - `eagerRunCtx` / `eagerCallCtx()`: for direct native-op calls (`op.call(eagerCallCtx(), …)`).
 */
import { exec, execOverFrame, execState, execStateOverFrame } from "../eval/generator-exec.js";
import { type CallCtx, testCallCtx } from "../run/CallCtx.js";
import { RunContext } from "../run/RunContext.js";

/** A run handle with eager stamping on — for direct-call tests. */
export const eagerRunCtx: RunContext = new RunContext({ eagerStamps: true });

/** A `CallCtx` over {@link eagerRunCtx} — `this` for a raw native op under test. */
export const eagerCallCtx = (): CallCtx => testCallCtx({ runCtx: eagerRunCtx });

export const execEager = ((code, options = {}) => exec(code, { ...options, eagerStamps: true })) as typeof exec;
export const execStateEager = ((code, options = {}) =>
  execState(code, { ...options, eagerStamps: true })) as typeof execState;
export const execOverFrameEager = ((code, options) =>
  execOverFrame(code, { ...options, eagerStamps: true })) as typeof execOverFrame;
export const execStateOverFrameEager = ((code, options) =>
  execStateOverFrame(code, { ...options, eagerStamps: true })) as typeof execStateOverFrame;
