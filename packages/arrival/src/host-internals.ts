// `@inhuman.tools/arrival/host-internals` — the HOST-INTEGRATION tier: the run-observability
// machinery (effect log, run cache, read guard), the burst/note/display sinks, the membrane's
// callable-crossing seam, the mid-run assembly kernel (`createRuntimeAssembler`, for a
// host-armed `configuration.extensionRegistry`), the structural `SchemeEnv` contract a pack types
// against, and the interop-sealing marks the whiteroom Blob-law needs. The `-internals` name is
// the no-stability-contract signal (V's minimal-surface ruling, docs/plans/
// stage-c-corpse-deletion.md §"V's minimal-surface ruling") — a sibling contract between arrival
// core and the packages that embed a run (arrival-run, llm-plane-arrival-chain, the MCP/studio
// hosts), never the capability-authoring public surface.

// Interop sealing — `@arrival.private` (+ `markInteropBoundary`) marks a class opaque to a
// Scheme member-read (`(@ x :internal)` → nil). Off the package root (export restructure);
// this is its new home.
export { arrival, markInteropPrivate, markInteropBoundary } from "./membrane/interop-access.js";

// The callable-crossing seam: the ONE invocation site for any JS caller resolving a scheme
// callable value, plus its guard.
export { applyCallback, type ACallable } from "./values/primitives/ACallable.js";
export { is_callable_value } from "./values/value-guards.js";

// The run-neutral evaluation context + the evaluator's per-frame contract.
export { CONSTANT_CTX, type HeapMeter } from "./run/RunContext.js";
export { type EvalContext, type StackFrame } from "./eval/evaluator.js";

// The first-class run cache: a run's durable twin is (program, cache); `exec(src, { cache })`
// threads it onto the run's RunContext, and the baked rosetta membrane records/replays through it.
export { MemoryRunCache, canonicalJson, runCacheKey, type RunCache, type RunCacheEntry } from "./run/run-cache.js";

// The effect log + the read guard: `exec(src, { effects, reads })` gathers sink penetrations
// instead of firing them and (with `reads` armed) checks the read-your-deferred-write invariant.
export { MemoryEffectLog, burst, BurstDrainError, type EffectEntry, type EffectLog } from "./run/effect-log.js";
export {
  MemoryReadTracker,
  checkReadWriteGuard,
  ReadYourDeferredWriteError,
  type ReadEvent,
  type ReadTracker,
  type ReadGuard,
  type WriteSetResolver,
} from "./run/read-guard.js";

// The per-run model-facing note channel — a renderer mints one and drains it.
export { createNoteSink, createDisplaySink, type NoteSink, type DisplaySink } from "./run/note-sink.js";

// The structural env contract a pack/consumer types against (never the concrete `AmbientRuntime`
// class) — off the package root and the killed `/scheme-env` subpath; this is its new home.
export { type SchemeEnv } from "./common/scheme-env.js";

// The mid-run assembly kernel: `createRuntimeAssembler` applies host-registered `EnvPack`s onto
// an already-live env (backing a host-armed `configuration.extensionRegistry` — a genuinely
// different, mid-run operation from bootstrap assembly). Off the killed `/env` subpath.
export {
  createRuntimeAssembler,
  type EnvPack,
  type PackContext,
  type PreludeBindTarget,
  type RuntimeAssembler,
} from "./common/kernel.js";

// `bindValue` — binds a name into a live `AmbientRuntime` env, `fromJS`-boxing a raw JS value
// unless it's already a SchemeValue (or one of the small documented carve-outs). Exported here
// for the provenance analysis-stack relocation: `@inhuman.tools/arrival-provenance`'s
// `analysis/uneval.ts` (`buildUneval`) arms `uneval`'s re-execution scope with it — binding the
// run's output as `result` before evaluating a selector as one more tapped step. Not previously
// exported anywhere (uneval.ts was an in-package relative import); this is its first cross-package
// door.
export { bindValue } from "./env/AmbientRuntime.js";
