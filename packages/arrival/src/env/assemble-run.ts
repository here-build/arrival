// assemble-run.ts — Stage B1's `assembleRun`: a free function (the env layer) minting a
// RunContext directly from a capability-set + shared config bag, via the memoized
// {@link Vocabulary} (`./vocabulary.js`) instead of `lower()`/`assembleEnv`/`instantiate`'s
// three-phase ambient. `RunContext` (run/RunContext.ts) stays a LEAF — it gains only the
// opaque `vocabulary`/`degraded` fields this function fills; the vocabulary-aware TYPE
// narrowing lives here, at the env-layer boundary, not on the run type itself.
//
// STAGE B2 — THE PER-RUN PRELUDE PASS lives here (see
// docs/plans/stage-b-runcontext-absorbs-assembly.md §Sub-stages, §The model): PRELUDE IS
// PER-RUN SYSTEM CODE, executed inside RunContext instantiation, EVERY run, C3 order (deps
// first — `Vocabulary.preludes` is already collected in that order, deduped by capability
// IDENTITY, so a diamond-DAG capability's prelude text appears exactly once in the array and
// this function's single pass over it is what makes execution single-per-run, not a separate
// dedup mechanism). Sequence:
//
//   1. Obtain (or build) the tuple's memoized {@link Vocabulary}.
//   2. Mint the `RunContext` — vocabulary/degraded/capabilityConfigurations attached, resource
//      store empty — so a prelude form dispatched in step 3 already has a REAL run to touch
//      resources against (a prelude registering into the loader's extension registry spawns
//      that registry INTO THIS RUN, not a bystander's).
//   3. THE PRELUDE PASS: a fresh, DISCARDED prelude scope (`mintFrame(user_env, …)` — same base
//      composition `generator-exec.ts`'s vocabulary-path branch uses for its own chain frame, so
//      base-pack builtins a prelude relies on — `+`, `string-length`, … — still resolve), seeded
//      with the preludeOnly overlay (assembly-time-only names, visible ONLY here) THEN the main
//      vocabulary map, evaluated via `opts.evalPrelude` — carrying THIS run's `runCtx` — for
//      every `{capability, text}` pair, C3 order. A `(define …)` a prelude form runs lands in
//      THIS scope and is DISCARDED with it (never leaks into user-facing resolution); a CLOSURE
//      a prelude mints keeps its lexical captures regardless (ordinary closure semantics — see
//      `EvalPreludeInto`'s own doc and the law suite, `env/__tests__/assemble-run.test.ts`).
//   4. Return the prelude-completed `RunContext` — the caller (generator-exec.ts's vocabulary
//      route) builds the user-facing resolution chain from the SAME `Vocabulary.map`, separately,
//      and never re-runs a prelude.
//
// `opts.evalScheme` stays runCtx-less and BUILD-time (feeds `buildVocabulary`'s `symbol.define`
// Pass-2 bake, shared across every run of this tuple); `opts.evalPrelude` is the NEW, RUN-time
// callback this stage adds — required whenever the tuple's closure contributes at least one
// `.spec.prelude` (a tuple with none never calls it, so a caller with no prelude-bearing
// capabilities in its set may omit it, same relaxed posture untyped fixtures already rely on).

import type { EnvCapability } from "../common/capability.js";
import type { EvalPreludeInto, EvalSchemeInto } from "../common/scheme-env.js";
import type { DisplaySink, NoteSink } from "../run/note-sink.js";
import type { RunCache } from "../run/run-cache.js";
import type { EffectLog } from "../run/effect-log.js";
import type { ReadGuard } from "../run/read-guard.js";
import { RunContext } from "../run/RunContext.js";
import { buildVocabulary } from "./vocabulary.js";
import { bindValue, mintFrame } from "./AmbientRuntime.js";
import { user_env } from "./env-roots.js";
import invariant from "tiny-invariant";

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
  /** Stage B2 — the PER-RUN PRELUDE PASS's evaluator (see this module's own header): carries
   *  THIS run's freshly-minted `runCtx` into every prelude form, so a resource-touching verb
   *  spawns/reads THIS run's bag. Required iff the tuple's C3 closure contributes at least one
   *  `.spec.prelude` — a tuple with none never calls it (checked at call time, not the type
   *  level, since "any prelude present" is a runtime fact of the closure, not the call site). */
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

  // Step 2 — mint the RunContext FIRST: the prelude pass (step 3, below) dispatches through
  // THIS run's own `runCtx`, so a resource-touching prelude verb spawns/reads THIS run's bag,
  // never a bystander's.
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
    degraded: vocabulary.degraded,
  });

  // Step 3 — THE PER-RUN PRELUDE PASS (see this module's own header for the full model).
  // `vocabulary.preludes` is already C3-ordered (deps-first) and identity-deduped (a diamond-DAG
  // capability contributes exactly one entry) — this single pass over it IS the single-execution
  // law; no separate dedup bookkeeping is needed here.
  if (vocabulary.preludes.length > 0) {
    invariant(
      opts.evalPrelude !== undefined,
      "assembleRun: this tuple's capabilities declare a prelude — AssembleRunOptions.evalPrelude is required",
    );
    // A fresh, DISCARDED-per-run frame — never reused, never returned. Composed exactly like
    // `generator-exec.ts`'s vocabulary-path chain frame (`mintFrame(user_env, …)`), so base-pack
    // builtins a prelude relies on (`+`, `string-length`, …) still resolve via `user_env`'s own
    // `__parent__` chain. preludeOnly bound AFTER the main map: the two maps are DISJOINT by
    // construction (`vocabulary.ts`'s `makeBindTarget` routes each name into EXACTLY one), so
    // this is not an override — it simply completes the prelude's own visibility (main + the
    // assembly-time-only overlay), matching §PRELUDE's "resolves exactly as a real binding would".
    const preludeScope = mintFrame(user_env, "assemble-run-prelude");
    for (const [name, value] of vocabulary.map) bindValue(preludeScope, name, value);
    for (const [name, value] of vocabulary.preludeOnly) bindValue(preludeScope, name, value);
    for (const { text } of vocabulary.preludes) {
      await opts.evalPrelude(preludeScope, text, runCtx);
    }
    // `preludeScope` is discarded here — nothing keeps a reference past this loop, so any
    // `(define …)` a prelude form ran is gone with it (the spec's confirmed discard ruling).
    // A closure a prelude minted keeps ITS OWN captured reference to `preludeScope` regardless
    // (ordinary lexical closure semantics — this function doing nothing further is exactly what
    // preserves that: nothing here forces the scope to be reclaimed, and nothing here rebinds it).
  }

  return runCtx;
}
