// `@inhuman.tools/arrival/host-internals` — the HOST-INTEGRATION tier: run-observability
// (effect log, run cache, read guard), burst/note/display sinks, the membrane's
// callable-crossing seam, the mid-run assembly kernel (`createRuntimeAssembler`, for a
// host-armed `configuration.extensionRegistry`), the structural `SchemeEnv` contract a
// pack types against, and the interop-sealing marks the whiteroom Blob-law needs.
// The `-internals` name is the no-stability-contract signal — a sibling contract between
// arrival core and packages that embed a run (arrival-run, llm-plane-arrival-chain,
// MCP/studio hosts), never the capability-authoring public surface.

// Interop sealing — `@arrival.private` (+ `markInteropBoundary`) marks a class opaque to
// a Scheme member-read (`(@ x :internal)` → nil).
export { arrival, markInteropPrivate, markInteropBoundary } from "../membrane/interop-access.js";

// Callable-crossing seam: the ONE invocation site for any JS caller resolving a scheme
// callable value, plus its guard.
export { applyCallback, type ACallable } from "../values/primitives/ACallable.js";
export { is_callable_value } from "../values/value-guards.js";

// Run-neutral evaluation context + the evaluator's per-frame contract.
export { CONSTANT_CTX, type HeapMeter } from "../run/RunContext.js";
export { type EvalContext, type StackFrame } from "../eval/evaluator.js";

// RUN-READER DOOR — cross-cutting prerequisite for MCP DI: discovery takes run context,
// extracts each symbol whose owning capability is an mcp capability, renders it in
// prelude. `ownerOf` answers "who owns this minted symbol value"; `symbolsOwnedBy`
// composes it against a run's vocabulary into the consumer-shaped catalog/prelude query.
// Contract/introspection data still comes from `contractOf` (`/lsp-internals`) — this
// door is ownership only.
export { ownerOf, symbolsOwnedBy } from "../run/CallCtx.js";

// First-class run cache: a run's durable twin is (program, cache); `exec(src, { cache })`
// threads it onto RunContext; the baked rosetta membrane records/replays through it.
export { MemoryRunCache, canonicalJson, runCacheKey, type RunCache, type RunCacheEntry } from "../run/run-cache.js";

// Effect log + read guard: `exec(src, { effects, reads })` gathers sink penetrations
// instead of firing them and (with `reads` armed) checks the read-your-deferred-write
// invariant.
export { MemoryEffectLog, burst, BurstDrainError, type EffectEntry, type EffectLog } from "../run/effect-log.js";
export {
  MemoryReadTracker,
  checkReadWriteGuard,
  writeSetOfResourcePaths,
  ReadYourDeferredWriteError,
  type ReadEvent,
  type ReadTracker,
  type ReadGuard,
  type WriteSetResolver } from "../run/read-guard.js";

// Resource-path CQS: domain-lane temporal zoning. Ordinary runs always carry a path
// log; `exec(src, { resourcePaths, strictCQSstrings })` injects a spy / strict mode.
// `serializeResourcePath` is the Phase 4 host-footprint key encoding (writeSetOf / atoms).
export {
  MemoryResourcePathLog,
  applyResourcePathCqs,
  assertNoResourcePathProducers,
  pathsOverlap,
  anyPathOverlap,
  findOverlappingPair,
  serializeResourcePath,
  ResourcePathConflictError,
  ResourcePathDeclarationError,
  ResourcePathProducerError,
  type ResourcePath,
  type ResourcePathFn,
  type ResourcePathLog,
} from "../run/resource-paths.js";

// Phase 5 R1 — path-keyed atom bus (observe at Q≠[]; stage E for run-commit invalidate).
// MobX sits behind AtomProxy; product law never asserts MobX API.
export type { AtomProxy, ProxyAtom } from "../run/atom-proxy.js";
export {
  atomKey,
  keysArePrefixRelated,
  wouldNotify,
  isPathAtomKey,
  paramAtomKey,
  MemoryPathAtomBus,
  ProxyPathAtomBus,
  createMemoryAtomProxy,
  type PathAtomBus,
} from "../run/path-atom-bus.js";
// `createMobxAtomProxy` is deliberately NOT re-exported here. Its module has a
// top-level `import { createAtom } from "mobx"`, and mobx is an OPTIONAL peer — a
// static re-export would make every host-internals consumer fail to resolve the
// barrel without mobx installed, i.e. silently promote the optional peer to a hard
// dependency. Reach it by its own subpath instead:
//   import { createMobxAtomProxy } from "@inhuman.tools/arrival/mobx-atom-proxy";

// Phase 5 R2–R3 — host reaction envelope (re-invoke = new top-level exec; self-suppress;
// settle with OQ-CYCLE-POLICY at-most-once-per-unit). Not a public FRP surface.
export {
  createReactionHub,
  type ReactionHub,
  type ReactionEnvelope,
  type ReactionUnitSpec,
  type SettleOptions,
} from "../run/reaction-envelope.js";

// Per-run model-facing note channel — a renderer mints one and drains it.
export { createNoteSink, createDisplaySink, type NoteSink, type DisplaySink } from "../run/note-sink.js";

// Structural env contract a pack/consumer types against (never the concrete
// `AmbientRuntime` class).
export { type SchemeEnv } from "../common/scheme-env.js";

// Mid-run assembly kernel: `createRuntimeAssembler` applies host-registered `EnvPack`s
// onto an already-live env (backing a host-armed `configuration.extensionRegistry` —
// a genuinely different, mid-run operation from bootstrap assembly).
export {
  createRuntimeAssembler,
  type EnvPack,
  type PackContext,
  type PreludeBindTarget,
  type RuntimeAssembler } from "../common/kernel.js";

// `bindValue` — binds a name into a live `AmbientRuntime` env, `fromJS`-boxing a raw JS
// value unless it's already a SchemeValue (or one of the small documented carve-outs).
// Cross-package door for arrival-provenance's `analysis/uneval.ts` (`buildUneval`) —
// arms `uneval`'s re-execution scope by binding the run's output as `result` before
// evaluating a selector as one more tapped step.
export { bindValue } from "../env/AmbientRuntime.js";
