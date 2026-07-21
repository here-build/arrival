// heap-budget.ts — the per-run ALLOCATION bound (the memory analogue of the wall-clock
// `budgetMs`). Ownership, the mints-not-borrows rule, the TICK blind spot it exists for, and the
// string/bigint blind spots all live in docs/execution.md §BUDGETS — the single home. Monotonic:
// it bounds cumulative work, not live heap.
//
// WHERE this file charges (the local mechanism §BUDGETS names but does not site): two chokepoints,
// both counting by input element BEFORE the op runs — `to_array` (env/pack-helpers.ts, the eager
// list->array path used by append/join/reverse/…) and the sequence-op dispatch (filter/map/reduce,
// which walk the spine/array directly via each term's own tagless-final method). The dispatch-level
// charge is necessary because value terms must stay EVALUATOR-FREE (no currentRunEnv import; the
// meter is run-scoped context state, not a value-algebra concern) — `to_array` alone can't see ops
// that bypass it.
//
// The charge site reads `ctxOf(operand).heapMeter` (or the `runCtx` threaded through a CallCtx)
// directly — no env-node courier, no parent-chain walk — because every value built during a run
// carries the SAME RunContext (docs/execution.md §HERMETIC), which is also what makes the meter
// safe against async interleaving of concurrent runs.

import type { RunContext, HeapMeter } from "./run/RunContext.js";
import { BudgetExceededError } from "./errors.js";

export type { HeapMeter };

/** The containment message. Carries "budget exceeded" so the same classifier that catches the
 *  wall-clock deadline (`/budget exceeded|abort|maximum call stack/i`) treats this as a contained
 *  outcome, not a genuine fault. Thrown as a `BudgetExceededError` by the caller (which already
 *  imports it). */
export function heapBudgetMessage(max: number): string {
  return (
    `heap budget exceeded (${max} cells) — a run materialized more list cells than its allocation ` +
    `bound allows (likely an unbounded-growth loop, e.g. (append acc x) re-copying a growing list).`
  );
}

/** Charge the run's allocation meter by `count` elements; contain the run if it passes `max`.
 *  Materializing tagless terms (APair/AVector map/filter/reduce/sort) charge their OWN heap
 *  through the runCtx `symbol.tagless` threads them — the primitive owns its algebra AND its
 *  cost. A meter-less run (no heapBudget) is a no-op. */
export function chargeHeap(runCtx: RunContext | undefined, count: number): void {
  const meter = runCtx?.heapMeter;
  if (meter === undefined) return;
  meter.used += count;
  if (meter.used > meter.max) throw new BudgetExceededError(heapBudgetMessage(meter.max), []);
}
