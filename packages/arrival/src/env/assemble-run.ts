// assemble-run.ts — `assembleRun`: env-layer free function minting a RunContext from a
// capability-set + shared config via memoized {@link Vocabulary} (`./vocabulary.js`).
// `RunContext` stays a leaf — gains only opaque `vocabulary`/`degraded` fields this
// function fills; vocabulary-aware type narrowing lives here, at the env boundary.
//
// PER-RUN PRELUDE PASS (docs/environments.md §PRELUDE): prelude is per-run system code,
// executed inside RunContext instantiation, every run, C3 order (deps first).
// `Vocabulary.preludes` is already C3-ordered and identity-deduped (diamond DAG once) —
// this function's single pass IS the single-execution law.
//
// Sequence:
//   1. Obtain (or build) the tuple's memoized Vocabulary.
//   2. Mint RunContext (vocabulary/degraded/capabilityConfigurations attached, resource
//      store empty) so a prelude form already has a real run for resources.
//   3. Prelude pass: fresh DISCARDED null-rooted scope, seeded with preludeOnly then
//      main map (caller folds BASE_ROSTER into the tuple so base builtins resolve as
//      ordinary members — never parent-chain fallback). Evaluate via `opts.evalPrelude`
//      carrying THIS run's runCtx. A `(define …)` lands in this scope and dies with it;
//      a closure keeps its lexical captures (ordinary closure semantics).
//   4. Return the prelude-completed RunContext. Caller builds the user-facing resolution
//      chain from the same Vocabulary.map separately; never re-runs prelude.
//
// `opts.evalScheme` is BUILD-time (feeds `buildVocabulary` Pass-2 bake, shared across
// runs of this tuple). `opts.evalPrelude` is RUN-time — required iff the closure has
// at least one `.spec.prelude`.
//
// RUNCTX REUSE: `opts.runCtx` supplied ⇒ reuse verbatim (REPL continuity). Invariant:
// reused run's vocabulary must be THIS tuple's — checked by IDENTITY against the
// memoized `Vocabulary.map`. Mismatch → `RunContextVocabularyMismatchError` (no silent
// misresolve). Match ⇒ skip prelude (already ran at original mint; re-running would
// double-fire effects).

import type { EnvCapability } from "../common/capability.js";
import type { EvalPreludeInto, EvalSchemeInto } from "../common/scheme-env.js";
import type { DisplaySink, NoteSink } from "../run/note-sink.js";
import type { RunCache } from "../run/run-cache.js";
import type { EffectLog } from "../run/effect-log.js";
import type { ReadGuard } from "../run/read-guard.js";
import { RunContext } from "../run/RunContext.js";
import { buildVocabulary } from "./vocabulary.js";
import { bindValue, mintResolvingFrame } from "./AmbientRuntime.js";
import { RunContextVocabularyMismatchError } from "../errors.js";
import invariant from "tiny-invariant";

export interface AssembleRunOptions {
  /** Capability set this run is armed with. */
  readonly capabilities: readonly EnvCapability[];
  /** ONE shared config bag — reference-identity dedup across root + dep appearances
   *  (see `ExecOptions.config`, generator-exec.ts). */
  readonly config?: object;
  /** Threaded to `buildVocabulary` for Pass-2 bake — required when any capability
   *  declares `symbol.define`/`defineSyntax` (or a prelude). */
  readonly evalScheme: EvalSchemeInto;
  /** Per-run prelude evaluator — carries this run's `runCtx`. Required iff the tuple's
   *  C3 closure has at least one `.spec.prelude` (runtime fact of the closure). */
  readonly evalPrelude?: EvalPreludeInto;
  readonly strict?: boolean;
  readonly heapBudget?: number;
  readonly freezeRosettaReturns?: boolean;
  readonly signal?: AbortSignal;
  readonly cache?: RunCache;
  readonly effects?: EffectLog;
  readonly reads?: ReadGuard;
  readonly notes?: NoteSink;
  readonly display?: DisplaySink;
  /** Reuse an existing RunContext (REPL continuity) — tuple-identity checked, prelude
   *  not re-run (module header). */
  readonly runCtx?: RunContext;
}

/** Obtain (or build) this tuple's {@link Vocabulary} and mint a fresh `RunContext`
 *  armed with it. `capabilityResources` starts empty (spawn lazily on first dispatch).
 *  `opts.runCtx` supplied ⇒ reuse (tuple-identity checked, no re-prelude). */
export async function assembleRun(opts: AssembleRunOptions): Promise<RunContext> {
  const vocabulary = await buildVocabulary(opts.capabilities, opts.config, opts.evalScheme);

  if (opts.runCtx !== undefined) {
    if (opts.runCtx.vocabulary !== vocabulary.map) throw new RunContextVocabularyMismatchError();
    return opts.runCtx;
  }

  // Mint first: prelude pass dispatches through THIS run's runCtx.
  const runCtx = new RunContext({
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
    degraded: vocabulary.degraded });

  // Per-run prelude (module header). preludes already C3-ordered + identity-deduped.
  if (vocabulary.preludes.length > 0) {
    invariant(
      opts.evalPrelude !== undefined,
      "assembleRun: this tuple's capabilities declare a prelude — AssembleRunOptions.evalPrelude is required",
    );
    // Fresh discarded null-rooted frame. Main map + preludeOnly are disjoint by
    // construction (`makeBindTarget`); both complete prelude visibility.
    const preludeScope = mintResolvingFrame("assemble-run-prelude");
    for (const [name, value] of vocabulary.map) bindValue(preludeScope, name, value);
    for (const [name, value] of vocabulary.preludeOnly) bindValue(preludeScope, name, value);
    for (const { text } of vocabulary.preludes) {
      await opts.evalPrelude(preludeScope, text, runCtx);
    }
    // preludeScope discarded — defines die with it; closures keep captures.
  }

  return runCtx;
}
