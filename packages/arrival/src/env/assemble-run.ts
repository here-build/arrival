// assemble-run.ts — Stage B1's `assembleRun`: a free function (the env layer) minting a
// RunContext directly from a capability-set + shared config bag, via the memoized
// {@link Vocabulary} (`./vocabulary.js`) instead of `lower()`/`assembleEnv`/`instantiate`'s
// three-phase ambient. `RunContext` (run/RunContext.ts) stays a LEAF — it gains only the
// opaque `vocabulary`/`degraded` fields this function fills; the vocabulary-aware TYPE
// narrowing lives here, at the env-layer boundary, not on the run type itself.
//
// PRELUDE PASS — NOT run here (B2's job; see docs/plans/stage-b-runcontext-absorbs-assembly.md
// §Sub-stages). `assembleRun` mints a RunContext armed with this tuple's validated
// configuration + degraded surface + the frozen vocabulary map; a caller wanting per-run
// prelude effects (B1's `exec({ capabilities })` routing, for behavioral equivalence with the
// pre-B1 path) evaluates `Vocabulary.preludes` itself against its own live resolution frame —
// see `generator-exec.ts`'s routed branch, which does exactly that.

import type { EnvCapability } from "../common/capability.js";
import type { EvalSchemeInto } from "../common/scheme-env.js";
import type { DisplaySink, NoteSink } from "../run/note-sink.js";
import type { RunCache } from "../run/run-cache.js";
import type { EffectLog } from "../run/effect-log.js";
import type { ReadGuard } from "../run/read-guard.js";
import { RunContext } from "../run/RunContext.js";
import { buildVocabulary } from "./vocabulary.js";

export interface AssembleRunOptions {
  /** The capability set this run is armed with. */
  readonly capabilities: readonly EnvCapability[];
  /** The ONE shared config bag — see `ExecOptions.config` (generator-exec.ts) for the sharing
   *  contract (reference-identity dedup across a capability's root + dep appearances). */
  readonly config?: object;
  /** Threaded to `buildVocabulary` for a capability's `symbol.define`/`defineSyntax` Pass-2
   *  bake — required whenever any capability in the closure declares one (or a prelude, once
   *  B2 lands); see `Vocabulary`'s own doc. */
  readonly evalScheme: EvalSchemeInto;
  readonly strict?: boolean;
  readonly heapBudget?: number;
  readonly freezeRosettaReturns?: boolean;
  readonly signal?: AbortSignal;
  readonly cache?: RunCache;
  readonly effects?: EffectLog;
  readonly reads?: ReadGuard;
  readonly notes?: NoteSink;
  readonly display?: DisplaySink;
}

/** Obtain (or build) this tuple's {@link Vocabulary} and mint a fresh `RunContext` armed with
 *  it: `capabilityConfigurations` from `Vocabulary.configsByCapability` (replacing the
 *  instantiate-time table build `eval/exec-phases.ts`'s `instantiate` does for the ambient
 *  path), plus the opaque `vocabulary`/`degraded` handles. The RunContext's own
 *  `capabilityResources` store starts empty regardless (unchanged — resources spawn lazily on
 *  first dispatch, per `CallCtx.ts`'s `makeCallCtx`, orthogonal to which resolution surface a
 *  value was bound through). */
export async function assembleRun(opts: AssembleRunOptions): Promise<RunContext> {
  const vocabulary = await buildVocabulary(opts.capabilities, opts.config, opts.evalScheme);
  return new RunContext({
    strict: opts.strict,
    heapBudget: opts.heapBudget,
    freezeRosettaReturns: opts.freezeRosettaReturns,
    signal: opts.signal,
    cache: opts.cache,
    effects: opts.effects,
    reads: opts.reads,
    notes: opts.notes,
    display: opts.display,
    capabilityConfigurations: vocabulary.configsByCapability,
    vocabulary: vocabulary.map,
    degraded: vocabulary.degraded,
  });
}
