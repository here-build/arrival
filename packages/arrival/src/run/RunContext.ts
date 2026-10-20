/**
 * RunContext — the per-run handle, minted once per `exec()` and threaded explicitly as
 * `runCtx`. The run's identity: state CONSTANT for one run, DIFFERING between concurrent runs.
 *
 * Model: docs/execution.md §HERMETIC, §CTX-SPECIES, §CHANNELS — data-local run-state, two
 * ctx species (live-run / CONSTANT_CTX), seven channels' arm-subset-wise
 * `X | undefined ⇒ facility off` (resourcePaths alone defaults ON — §CHANNELS), two
 * run-flags (`silent`, `eagerStamps`) and the call-depth `ambient` holder (P19: no global state).
 * `membraneClosure` is the observation wrap (§REACTIVITY), not a CQS channel.
 * This file is their enforcement site.
 *
 * PLACEMENT TEST for a new field: varies between concurrent runs → here; never → global
 * singleton; within one run by call depth → dynamic-extent holder. Only the first belongs.
 *
 * Parse-time source identity does NOT live here — `SourceLocation` threads as a plain
 * `loc?` argument from Parser to leaf mints, landing on the value's own `.location`.
 */

import type { EvalTap } from "../eval/evaluator.js";
import type { AListAlike } from "../values/types.js";
import type { RunCache } from "./run-cache.js";
import type { DisplaySink, NoteSink } from "./note-sink.js";
import type { EffectLog } from "./effect-log.js";
import type { ReadGuard } from "./read-guard.js";
import { MemoryResourcePathLog, type ResourcePathLog } from "./resource-paths.js";
import { disposeRunContext } from "./run-lifecycle.js";
import { ArrivalError, RunContextBusyError, type ErrorClass } from "../errors.js";
import type { Invocation } from "../eval/dynamic-call-site.js";
import type { ClosureCallWindow, ClosureSite, RecordCoordinate } from "../eval/provenance-hooks.js";
import type { RegionScope } from "../membrane/region-scope.js";
import type { RegionId } from "../provenance/store/ids.js";
import type { PayloadStore, ProvenanceStore } from "../provenance/store/interfaces.js";

/** Per-run, per-capability resource store — lazily-produced Resources bag keyed by
 *  EnvCapability object (opaque so this leaf never imports the capability layer).
 *
 *  Filled by `makeCallCtx` on first dispatch of a resource-bearing verb: WeakMap
 *  get-or-compute. Absent ⇒ call `["arrival/get-resources"]` (fed assembly config) and
 *  store. Single-dispatch makes has-then-set the semaphore; concurrent fan-out shares
 *  the stored value/promise. Pending bag replaced in-slot on settle. Disposal is the
 *  capability's job (`onRunContextDispose`), not the store's. */
export type CapabilityResourceStore = WeakMap<object, unknown>;

/** Per-run, per-capability validated configuration — capability object → assembly config.
 *  Opaque keys, same as {@link CapabilityResourceStore}.
 *
 *  FILLED ONCE, eagerly, at mint (`assembleRun` from `Vocabulary.configsByCapability`) —
 *  never grown at dispatch. ReadonlyMap (roster known and finite at mint). Reused-runCtx
 *  REPL passes carry the table their first mint built. Public exec paths are
 *  vocabulary-bearing; only CONSTANT_CTX and the internal live-frame family
 *  (`*OverFrame` / `execInFrame`, generator-exec.ts) carry no table.
 *
 *  Read by makeCallCtx: becomes `this.configuration`; same lookup feeds get-resources.
 *  Keying by the run (not value) — a symbol factory mints one value for every assembly;
 *  per-assembly config on a value-keyed map would clobber (docs/execution.md §CALLCTX). */
export type CapabilityConfigurationTable = ReadonlyMap<object, unknown>;

/**
 * Host wrap around one membrane interaction. `undefined` on the run ⇒ identity
 * (facility off). `T` may be a `Promise` — reverse-membrane wrappers are async.
 *
 * MUST be reentrant: a wrap's `work()` may itself cross (host impl `@`s a
 * borrowed object, a reverse call's body reads a member). Nesting is the law,
 * not a bug.
 *
 * Closed over by reverse-membrane wrappers at mint (`scope.runCtx`) so a late
 * JS→Scheme call after `exec` returns still sees THIS run's wrap.
 */
export type MembraneClosure = <T>(work: () => T) => T;

/** Identity when `runCtx` is missing or the wrap is unset. */
export function applyMembraneClosure<T>(runCtx: RunContext | undefined, work: () => T): T {
  const wrap = runCtx?.membraneClosure;
  return wrap === undefined ? work() : wrap(work);
}

/** What one CALL arms on the run handle (docs/execution.md §5). `deadline` is absolute on the
 *  `performance.now()` basis, computed ONCE per call; `budgetMs` rides along for the error message. */
export interface RunBoundOptions {
  readonly signal?: AbortSignal;
  readonly deadline?: number;
  readonly budgetMs?: number;
}

/** Restore token returned by {@link RunBound.arm}; hand it back to {@link RunBound.disarm}. */
export interface RunBoundToken {
  readonly signal: AbortSignal | undefined;
}

/** Live state of ONE call's trampolines, shared by every nested `run()` of the call (HOF callback,
 *  `apply`, `try` clause, macro expansion): how many sit on the HOST stack right now, and when the
 *  call last yielded to the event loop (the abort/budget check rides that yield). Per call — it
 *  lives on the bound — never global. The trampoline bounces through the microtask queue when
 *  `depth` reaches its limit so the host stack never overflows, and nested trampolines read the
 *  shared clock so a deep tower of short-stepping trampolines still reaches the check. */
export interface TrampolineNesting {
  depth: number;
  lastYield: number;
}

/**
 * The CALL-scoped bound (abort signal + wall-clock deadline) of a run handle. Bounds are per
 * CALL, not per run: a reused runCtx (REPL continuity) is armed afresh by each call, disarmed in
 * its `finally`. Every nested trampoline (`try` bodies, HOF callbacks, macro expansion, `require`)
 * reads THIS holder, so one call's budget and signal bound the whole call at every depth.
 * Structurally a `RunOptions` — pass it straight to `run()`.
 *
 * Seeded at mint from `opts.signal` (so a prelude pass, which runs unarmed, stays abortable).
 * Arming while already armed is a door: concurrent calls on one run handle are illegal.
 */
export class RunBound {
  /** Back to `depth` 0 whenever no trampoline of the call is on the host stack (re-zeroed on arm). */
  readonly nesting: TrampolineNesting = { depth: 0, lastYield: 0 };
  /** The armed call's EFFECTIVE signal: the caller's signal (or the seed) composed with this call's
   *  own internal controller, so a failed call can cancel its in-flight fan siblings. */
  signal: AbortSignal | undefined;
  deadline: number | undefined = undefined;
  budgetMs: number | undefined = undefined;
  /** The mint-time signal (e.g. a session signal): the floor a call that passes none falls back to. */
  readonly seedSignal: AbortSignal | undefined;
  #armed = false;
  /** Per-call controller (docs/execution.md §5): aborted when the call FAILS, so sibling fan
   *  tracks still in flight (`map` over async ports) stop at their next raceAbort / TICK instead
   *  of calling ports after the run is already lost. Fresh per arm; never outlives its call. */
  #controller: AbortController | undefined = undefined;

  constructor(signal?: AbortSignal) {
    this.signal = signal;
    this.seedSignal = signal;
  }

  /** True while a call holds the bound — nested entries INHERIT it instead of re-arming. */
  get armed(): boolean {
    return this.#armed;
  }

  arm(opts: RunBoundOptions): RunBoundToken {
    if (this.#armed) throw new RunContextBusyError();
    const token: RunBoundToken = { signal: this.signal };
    this.#armed = true;
    this.nesting.depth = 0;
    const controller = new AbortController();
    this.#controller = controller;
    this.signal = opts.signal === undefined ? controller.signal : AbortSignal.any([opts.signal, controller.signal]);
    this.deadline = opts.deadline;
    this.budgetMs = opts.budgetMs;
    return token;
  }

  /** The armed call failed: cancel everything still running under it. No-op when unarmed. */
  abortCall(): void {
    this.#controller?.abort(new DOMException("the call failed; in-flight work cancelled", "AbortError"));
  }

  disarm(token: RunBoundToken): void {
    this.#controller = undefined;
    this.signal = token.signal;
    this.deadline = undefined;
    this.budgetMs = undefined;
    this.nesting.depth = 0;
    this.#armed = false;
  }
}

/** Restore token returned by {@link RunObservation.arm}. */
export interface RunObservationToken {
  readonly tap: EvalTap | undefined;
  readonly nodeFilter: ((node: AListAlike) => boolean) | undefined;
}

/**
 * The CALL-scoped observation arm (tap + node filter) of a run handle — the sibling of
 * {@link RunBound}. A closure captures its DEFINITION-time EvalContext, so a fn defined in run 1
 * and called in run 2 must read the CALLING run's tap here, never the one it was born under
 * (else its body logs into run 1's trace under a cross-trace parent). Armed per top-level form,
 * restored on exit: a REPL reuses one runCtx across calls with different taps.
 */
export class RunObservation {
  tap: EvalTap | undefined = undefined;
  nodeFilter: ((node: AListAlike) => boolean) | undefined = undefined;

  arm(tap: EvalTap | undefined, nodeFilter: ((node: AListAlike) => boolean) | undefined): RunObservationToken {
    const token: RunObservationToken = { tap: this.tap, nodeFilter: this.nodeFilter };
    this.tap = tap;
    this.nodeFilter = nodeFilter;
    return token;
  }

  disarm(token: RunObservationToken): void {
    this.tap = token.tap;
    this.nodeFilter = token.nodeFilter;
  }
}

/** Where THIS run's provenance records land (docs/execution.md §CHANNELS row 7): the store
 *  ports, the region partition, and the static address of the emitting port. `undefined` on
 *  the run ⇒ emission off. Plain data — a run-constant, never swapped mid-run. */
export interface RunEmission {
  readonly store: ProvenanceStore;
  readonly payloads: PayloadStore;
  readonly regionId: RegionId;
  readonly coordinate: RecordCoordinate;
  /** Closure nodes the run evaluates, keyed by the lambda's body list (pair identity)
   *  (`WireframeProgram.closureSites`): a CALL of one is a track, and its ports emit under
   *  `[...coordinate, rootOrdinal, k, n]`. Absent ⇒ closure calls are not windowed. */
  readonly closureSites?: ReadonlyMap<object, ClosureSite>;
}

/** Key → value shape of the call-depth ambient holder. */
export interface RunAmbientSlots {
  dynSite?: Invocation;
  regionScope?: RegionScope;
  /** The closure-call window of the apply site whose synchronous prologue is running — how a HOF's
   *  element callback (a native called by `map`, with no `CallCtx` of its own) finds its track. */
  closureCall?: ClosureCallWindow;
  /** The call expression of that same apply site — a crossing's static site (`scopeId`), tap or no tap. */
  callNode?: object;
  track?: { readonly coordinate: RecordCoordinate; readonly sink: unknown };
}
export type RunAmbient = RunAmbientSlots;

/** Door: an ambient window was opened on a context that cannot hold one, or its body went async. */
export class AmbientWindowError extends ArrivalError {
  public readonly name = "AmbientWindowError";
  readonly "arrival/error-category": ErrorClass = "other";
  constructor(message: string) {
    super(message, []);
  }
}

/**
 * Run `fn` with `runCtx.ambient[key] = value`, restoring the previous value on exit. SYNC
 * windows only: a single-threaded isolate cannot interleave a sync body, so the holder is
 * race-free; a thenable-returning `fn` would leave the slot set across an await boundary
 * (where a concurrent call on this run could observe it), so it is refused with a door.
 * CONSTANT_CTX has no live ambient (frozen) — a window on it is a door.
 */
export function withAmbient<K extends keyof RunAmbientSlots, T>(
  runCtx: RunContext,
  key: K,
  value: RunAmbientSlots[K],
  fn: () => T,
): T {
  if (Object.isFrozen(runCtx.ambient)) {
    throw new AmbientWindowError(
      `withAmbient("${key}") on a run-neutral context (CONSTANT_CTX): it outlives every run and has no call-depth holder. Open the window on a live RunContext.`,
    );
  }
  const holder = runCtx.ambient;
  const had = Object.hasOwn(holder, key);
  const prev = holder[key];
  holder[key] = value;
  const restore = (): void => {
    if (had) holder[key] = prev;
    else delete holder[key];
  };
  let result: T;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  restore();
  if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
    throw new AmbientWindowError(
      `withAmbient("${key}"): the window body returned a thenable. Ambient windows are SYNC-only (an await boundary would let another call observe the slot); thread the value explicitly across async work.`,
    );
  }
  return result;
}

/** Mint a fresh per-run context for one `exec()`. Single birth place.
 *  `capabilityResources` starts empty; filled lazily on first resource-bearing dispatch. */
export class RunContext {
  /** R7RS-strict nil-projection (`car`/`cdr` of nil throws) vs tolerant (yields nil). */
  readonly strict: boolean;
  /** Call-scoped execution bound (signal + deadline), armed per call — see {@link RunBound}. */
  readonly bound: RunBound;
  /** Call-scoped observation (tap + node filter), armed per top-level form — see {@link RunObservation}. */
  readonly observation: RunObservation;
  /** Run cache; `undefined` ⇒ no interception. Armed ⇒ gates record/replay by cache class
   *  (docs/execution.md §MODE-LAW). */
  readonly cache: RunCache | undefined;
  /** Gathered-effect manifest; `undefined` ⇒ sink fires immediately. Armed ⇒ PRIME-run
   *  sink penetrations gather (docs/execution.md §BURST). */
  readonly effects: EffectLog | undefined;
  /** Read-tracking + deferral-guard; `undefined` ⇒ no tracking. Armed ⇒ eval loop wraps
   *  each top-level form and runs the read∩write guard (docs/execution.md §READ-GUARD). */
  readonly reads: ReadGuard | undefined;
  /**
   * Resource-path prior-effect set for CQS (run/resource-paths.ts).
   * Unlike cache/effects/reads (opt-in `undefined` = facility off), ordinary mints
   * always get a fresh {@link MemoryResourcePathLog} so CQS is on by default for
   * live runs. CONSTANT_CTX leaves it `undefined`. Override via ctor or
   * ExecOptions.resourcePaths (harness spy / custom log).
   */
  readonly resourcePaths: ResourcePathLog | undefined;
  /**
   * Opt-in runtime assert that every CQS path segment is a string (default false).
   * Type-level `ResourcePath` is the real law; this is for non-prod harness stress.
   * Threaded from ExecOptions.strictCQSstrings.
   */
  readonly strictCQSstrings: boolean;
  /** Model-facing note channel; `undefined` ⇒ notes dropped. */
  readonly notes: NoteSink | undefined;
  /** Display channel — MCP runner's display affordance. `undefined` ⇒ no display verb
   *  (arrival binds none). */
  readonly display: DisplaySink | undefined;
  /** Per-capability resource store. Every ordinary mint gets a fresh empty WeakMap;
   *  `undefined` ONLY for CONSTANT_CTX (`_noResourceStore`). */
  readonly capabilityResources?: CapabilityResourceStore;
  /** Per-capability configuration table — filled once at construction. `undefined` only
   *  for CONSTANT_CTX and the internal live-frame family. */
  readonly capabilityConfigurations?: CapabilityConfigurationTable;
  /** Vocabulary name→value map this run resolves through when minted via `assembleRun`.
   *  Opaque (`unknown`) so this leaf never imports the env layer. `undefined` only for
   *  CONSTANT_CTX and the internal live-frame family. */
  readonly vocabulary?: ReadonlyMap<string, unknown>;
  /** This tuple's degraded-capability list (same shape as `Vocabulary.degraded`). Opaque. */
  readonly degraded?: readonly unknown[];
  /**
   * Host wrap around every membrane interaction (borrowed-store read, host-fn
   * fire, reverse-membrane re-entry, result egress). `undefined` ⇒ identity.
   * Not a CQS channel — observation, not temporal zoning (docs/execution.md
   * §REACTIVITY). CONSTANT_CTX leaves it unset.
   */
  readonly membraneClosure: MembraneClosure | undefined;
  /** Channel 7 — provenance emission target; `undefined` ⇒ facility off (docs/execution.md §3). */
  readonly emission: RunEmission | undefined;
  /** Region-silent run (hermetic γ replay): emits nothing, mints no live stamps. Default false. */
  readonly silent: boolean;
  /** Stamp eagerly on the value plane (hermetic replay). Default false. */
  readonly eagerStamps: boolean;
  /** Call-depth dynamic-extent holder (dynSite / regionScope / track), mutated only through
   *  {@link withAmbient}. Per-run, so concurrent runs cannot cross (P19). Frozen on CONSTANT_CTX. */
  readonly ambient: RunAmbient;

  constructor(
    opts: {
      strict?: boolean;
      signal?: AbortSignal;
      cache?: RunCache;
      effects?: EffectLog;
      reads?: ReadGuard;
      /**
       * Override path log (harness spy). Ordinary mint: fresh MemoryResourcePathLog.
       * CONSTANT_CTX (`_noResourceStore`): undefined unless explicitly supplied.
       * Note: `?? new MemoryResourcePathLog()` — you cannot pass `undefined` to
       * disable on an ordinary mint; use CONSTANT_CTX for facility-off.
       */
      resourcePaths?: ResourcePathLog;
      /** See {@link RunContext.strictCQSstrings}. Default false. */
      strictCQSstrings?: boolean;
      notes?: NoteSink;
      display?: DisplaySink;
      /** Supply seam for configuration table — `assembleRun` is the production caller. */
      capabilityConfigurations?: CapabilityConfigurationTable;
      /** Supplied by `assembleRun` only. */
      vocabulary?: ReadonlyMap<string, unknown>;
      /** Supplied by `assembleRun` only. */
      degraded?: readonly unknown[];
      /** See {@link RunContext.membraneClosure}. */
      membraneClosure?: MembraneClosure;
      /** See {@link RunContext.emission}. */
      emission?: RunEmission;
      /** See {@link RunContext.silent}. Default false. */
      silent?: boolean;
      /** See {@link RunContext.eagerStamps}. Default false. */
      eagerStamps?: boolean;
    } = {},
    /** Internal: `true` for CONSTANT_CTX — no capabilityResources store. Never pass from
     *  an ordinary mint. */
    _noResourceStore = false,
  ) {
    this.strict = opts.strict ?? false;
    this.bound = new RunBound(opts.signal);
    this.observation = new RunObservation();
    this.cache = opts.cache;
    this.effects = opts.effects;
    this.reads = opts.reads;
    this.strictCQSstrings = opts.strictCQSstrings ?? false;
    this.notes = opts.notes;
    this.display = opts.display;
    this.capabilityConfigurations = opts.capabilityConfigurations;
    this.vocabulary = opts.vocabulary;
    this.degraded = opts.degraded;
    this.membraneClosure = opts.membraneClosure;
    this.emission = opts.emission;
    this.silent = opts.silent ?? false;
    this.eagerStamps = opts.eagerStamps ?? false;
    this.ambient = _noResourceStore ? Object.freeze({}) : {};
    // eslint-disable-next-line unicorn/no-negated-condition -- resource-store init is the live path; _noResourceStore is the hermetic opt-out
    if (!_noResourceStore) {
      this.capabilityResources = new WeakMap<object, unknown>();
      this.resourcePaths = opts.resourcePaths ?? new MemoryResourcePathLog();
    } else {
      this.resourcePaths = opts.resourcePaths;
    }
  }

  /** The armed call's abort signal (or the mint-time seed while unarmed). */
  get signal(): AbortSignal | undefined {
    return this.bound.signal;
  }

  /** Tear down resources scoped to THIS RunContext. Delegates to {@link disposeRunContext}
   *  — same idempotent function REPL hosts and exec's owned-runCtx finally call.
   *  CONSTANT_CTX inherits it; registry-keyed dispose is a no-op when nothing registered. */
  async [Symbol.asyncDispose](): Promise<void> {
    return disposeRunContext(this);
  }
}

/**
 * Run-NEUTRAL context (docs/execution.md §CTX-SPECIES). Carried by values that outlive
 * any single run: singletons, quoted-literal AST nodes, bootstrap-time construction.
 * Frozen, strict=false, all channels undefined — a value minted here cannot
 * carry one run's state into another.
 */
export const CONSTANT_CTX: RunContext = Object.freeze(new RunContext({}, true));
