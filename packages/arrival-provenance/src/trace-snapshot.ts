/**
 * Thin facade over `@here.build/arrival`'s (core) plain trace projection.
 *
 * `snapshotTrace`/`PlainTrace`/`PlainInv` moved to
 * `@here.build/arrival/src/provenance/trace-snapshot.ts` (core) — it reads
 * only `EvalTrace`'s plain-field shape (no mobx dependence), so it belongs
 * in core alongside the rest of the tracing spine. This file exists so every
 * sibling here keeps importing "./trace-snapshot.js" unchanged.
 *
 * Note: `snapshotTrace` accepts core's plain `EvalTrace` (or, structurally,
 * this package's `ObservableEvalTrace` — a subclass, so it satisfies the
 * same shape) — passing either works.
 */
export { snapshotTrace, type PlainTrace, type PlainInv } from "@here.build/arrival/provenance";
