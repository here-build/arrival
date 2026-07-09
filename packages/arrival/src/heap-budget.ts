// heap-budget.ts — a per-run ALLOCATION bound, the memory analogue of the wall-clock `budgetMs`.
//
// WHY: the wall-clock budget is checked at trampoline TICKs (loop-step / tail-call boundaries). A
// native collection op — `filter`/`map`/`append`/`join` — materializes its whole list in ONE
// synchronous JS loop that emits no TICK, so a single reduction over a large list runs uninterruptibly
// (a `(filter pred huge-list)` can burn tens of seconds before the trampoline regains control to check
// the deadline). Counting REDUCTIONS can't see inside that loop; counting ALLOCATIONS can. The killer
// pattern is O(K²) churn — re-materializing a list that grows by one each iteration (`(append seen
// fresh)` in a loop) — and cumulative element-charge catches it fast while a legitimately large LINEAR
// pass (materialize a 1M list a handful of times) stays well under a generous cap. Monotonic, like the
// EvalTrace entry cap: we bound cumulative work, not live heap.
//
// WHERE the charge happens: two chokepoints, both counting by input element BEFORE the op runs —
// `to_array` (env/pack-helpers.ts, the eager list->array path used by append/join/reverse/…) and
// the sequence-op dispatch (covering filter/map/reduce, which walk the spine/array directly via
// each term's own arrival/tagless-final method). The dispatch-level charge is necessary because
// value terms must stay evaluator-free (no currentRunEnv import; the meter is run-scoped context
// state, not a value-algebra concern) — `to_array` alone can't see ops that bypass it.
//
// OWNERSHIP: the meter lives on `RunContext.heapMeter` ONLY, minted once per `exec()` (see
// `makeRunContext`). Every value built during that run carries the SAME RunContext reference
// (`AValue.ctx` — see `ctxOf`), so a charge site reads `ctxOf(operand).heapMeter` (or the `runCtx`
// it's threaded through a CallCtx) directly — no env-node courier, no parent-chain walk. This is
// run-scoped and safe against async interleaving of concurrent runs by construction: each run's
// values carry their own run's RunContext, never a shared module-level ambient meter.

import type { RunContext, HeapMeter } from "./values/primitives/RunContext.js";
import { ArrivalError } from "./errors.js";

export type { HeapMeter };

/** The containment message. Carries "budget exceeded" so the same classifier that catches the
 *  wall-clock deadline (`/budget exceeded|abort|maximum call stack/i`) treats this as a contained
 *  outcome, not a genuine fault. Thrown as a `SchemeError` by the caller (which already imports it). */
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
  if (meter.used > meter.max) throw new ArrivalError(heapBudgetMessage(meter.max), []);
}
