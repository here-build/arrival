/**
 * Host reaction envelope (Phase 5 R2–R5).
 *
 * A **unit** is a whole top-level `exec` / tool (RX-UNIT). Under a live envelope:
 *   - live Q≠[] penetrations arm subscriptions (via PathAtomBus.observe)
 *   - successful non-sink E≠[] commit invalidates overlapping foreign units
 *   - foreign invalidate ∩ subs(U) ≠ ∅ ⇒ re-invoke U = NEW RUN
 *   - **A-OPTIN** host-injected param atoms (`optInParams` + {@link ReactionHub.setParam})
 *     re-invoke only units that opted in — never baked `define/overridable` syntax
 *
 * Fresh run (**RX-FRESH**): fresh path log + prior-E + fresh `RunCache` in `record`
 * mode — never the parent's cache (that makes the envelope a silent no-op).
 *
 * Subs live on the envelope, replaced wholesale after each **successful** run
 * (**P-RX-SUB-REPLACE** / **RX-SUBS**). A failed run keeps the last successful set.
 * While a run is in flight, foreign writes that overlap **this-run** observations
 * provisionally mark dirty (**P-RX-INFLIGHT** — queue, not cancel).
 *
 * Self-write suppression (**RX-SELF** / **N-RX-SELF-LOOP**): a unit is not woken by
 * its own committed effects. Attribution mechanism is unasserted — the hub skips
 * the publishing source.
 *
 * **OQ-CYCLE-POLICY** (product pick for R2): within one `settle({maxRounds})` call
 * each envelope re-invokes **at most once**. That kills n-cycles (mutual wake)
 * without a timer; `maxRounds` is the cascade-depth safety cap and rejects loudly
 * with "did not quiesce in N rounds" when the dirty set cannot drain (**RX-SETTLE**).
 * Multiple overlapping foreign writes in one settle window coalesce to one re-run
 * (**P-RX-COALESCE** — bounded [1,k]).
 *
 * Gather/burst invalidation (**RX-CLOCK-2** / **OQ-BURST-CONFIRM**) is not wired
 * here yet — suite gather cases loud-skip until the burst-commit hook is named.
 *
 * Design: docs/working-proposals/cqs-reactivity/
 * Suite:  docs/working-proposals/cqs-reactivity/test-suite-design/reactivity/SUITE.md
 */

import { exec, type ExecOptions } from "../eval/generator-exec.js";
import { MemoryRunCache, type RunCache } from "./run-cache.js";
import {
  MemoryResourcePathLog,
  pathsOverlap,
  type ResourcePath,
  type ResourcePathLog,
} from "./resource-paths.js";
import { paramAtomKey, type PathAtomBus } from "./path-atom-bus.js";

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Per-run unit specification. `code` may be a thunk so the host can change the
 * program between re-invokes (e.g. **P-RX-SUB-REPLACE**, phase-gated X5 cases).
 *
 * The envelope injects `pathAtoms`, a fresh `record` cache, and a fresh
 * resource-path log — callers must not pass those (and they are stripped if present).
 *
 * **A-OPTIN** (`optInParams`): host-injected param atom names. When the hub's
 * {@link ReactionHub.setParam} changes one of those names, this unit re-invokes.
 * Absent / empty ⇒ param changes never wake this unit (**N-RX-NO-OPTIN**). The suite
 * asserts opt-in *behavior* only — never `define/overridable` syntax.
 */
export type ReactionUnitSpec = {
  code: string | (() => string);
  /**
   * Opt-in param atom names (**A-OPTIN** / **RX-PARAM-NS**). Keys are minted via
   * {@link paramAtomKey} — structurally disjoint from path keys.
   */
  optInParams?: readonly string[];
} & Omit<ExecOptions, "pathAtoms" | "cache" | "resourcePaths" | "runCtx">;

export interface SettleOptions {
  /** Cascade-depth safety cap. Rejects with "did not quiesce in N rounds" if exceeded. */
  maxRounds: number;
}

/**
 * Live host unit. `run()` arms once; foreign invalidations schedule re-invokes
 * drained by {@link ReactionHub.settle} / {@link ReactionEnvelope.settle}.
 */
export interface ReactionEnvelope {
  /** Initial (or forced) top-level exec. Arms / replaces subs on success. */
  run(): Promise<unknown>;
  /** Drain this unit's dirty flag (and, via hub, peers) until quiet or budget. */
  settle(opts: SettleOptions): Promise<void>;
  /** Kill the envelope — no further re-invokes; in-flight completion discards new subs. */
  dispose(): void;
  readonly disposed: boolean;
  /** True when a foreign invalidate has armed a re-invoke that has not yet run. */
  readonly dirty: boolean;
  /** Successful + failed top-level execs started for this unit (includes initial). */
  readonly runCount: number;
  /** Last unwrapped `exec` result (undefined before first run). */
  readonly lastResult: unknown;
  /** Last run's cache (probe for **RX-FRESH** / **N-RX-REINVOKE-NOT-REPLAY**). */
  readonly lastCache: RunCache | undefined;
  /** Last run's resource-path log (probe for prior-E / path-log freshness). */
  readonly lastPathLog: ResourcePathLog | undefined;
  /** Last **successful** subscription paths (envelope-owned; replaced on success). */
  readonly subscriptionPaths: readonly ResourcePath[];
  /** Param names this unit opted into (**A-OPTIN**); empty when not opted in. */
  readonly optInParams: readonly string[];
}

export interface ReactionHub {
  /**
   * Shared {@link PathAtomBus} for bare `exec` writers and the harness
   * `invalidate` shortcut (**RX-EXT** / X2b foreign-write driver). Envelope units
   * use private buses that publish through this hub — they do **not** share this
   * instance as pathAtoms.
   */
  readonly bus: PathAtomBus;
  /** Register a live unit on this hub. */
  unit(spec: ReactionUnitSpec): ReactionEnvelope;
  /** Harness / foreign write: invalidate paths as if an external unit committed them. */
  invalidate(paths: readonly ResourcePath[]): void;
  /**
   * Host-owned param atom write (**A-OPTIN**). Units that listed `name` in
   * `optInParams` mark dirty. Param keys never enter path prior-E (**N-RX-OPTIN-NOT-DOOR-FUEL**).
   */
  setParam(name: string, value: unknown): void;
  /** Read a host-owned param atom value (undefined if never set). */
  getParam(name: string): unknown | undefined;
  /** True when the hub holds a value for this param name. */
  hasParam(name: string): boolean;
  /** Drain dirty flags across all units on this hub. */
  settle(opts: SettleOptions): Promise<void>;
  /** Dispose every unit still registered. */
  disposeAll(): void;
}

// ── Hub ──────────────────────────────────────────────────────────────────────

/** Create a shared reaction hub (one bus + multi-unit settle). */
export function createReactionHub(): ReactionHub {
  return new ReactionHubImpl();
}

class ReactionHubImpl implements ReactionHub {
  readonly bus: PathAtomBus;
  /** @internal */
  readonly _envelopes = new Set<ReactionEnvelopeImpl>();
  /** Host-owned param atom store (A-OPTIN). Keys are bare names; atom keys via paramAtomKey. */
  private readonly params = new Map<string, unknown>();

  constructor() {
    this.bus = new HubPublicBus(this);
  }

  unit(spec: ReactionUnitSpec): ReactionEnvelope {
    const env = new ReactionEnvelopeImpl(this, spec);
    this._envelopes.add(env);
    return env;
  }

  invalidate(paths: readonly ResourcePath[]): void {
    this.publish(paths, null);
  }

  setParam(name: string, value: unknown): void {
    // Store under bare name. Atom identity is paramAtomKey(name) — RX-PARAM-NS.
    // Touch is host-intent: always mark opted-in units dirty (even if value equals prior).
    this.params.set(name, value);
    void paramAtomKey(name); // pin encoding; never path-shaped
    for (const env of this._envelopes) {
      if (env.disposed) continue;
      if (env.optInParams.includes(name)) env.markDirty();
    }
  }

  getParam(name: string): unknown | undefined {
    return this.params.get(name);
  }

  hasParam(name: string): boolean {
    return this.params.has(name);
  }

  /**
   * Publish committed effect paths. `source === null` means bare bus / harness
   * (foreign to every unit). Self-suppression skips `source` when non-null.
   */
  publish(paths: readonly ResourcePath[], source: ReactionEnvelopeImpl | null): void {
    if (paths.length === 0) return;
    for (const env of this._envelopes) {
      if (env === source) continue; // RX-SELF
      if (env.disposed) continue;
      if (env.subsOverlap(paths)) env.markDirty();
    }
  }

  async settle(opts: SettleOptions): Promise<void> {
    const maxRounds = opts.maxRounds;
    if (!Number.isFinite(maxRounds) || maxRounds < 0) {
      throw new Error(`settle: maxRounds must be a non-negative number, got ${maxRounds}`);
    }
    // OQ-CYCLE-POLICY: each envelope re-invokes at most once per settle() call.
    // Overlapping foreign writes in one window coalesce via the boolean dirty flag
    // (P-RX-COALESCE / F-RX4 — re-runs ∈ [1, k]).
    const ran = new Set<ReactionEnvelopeImpl>();
    let rounds = 0;
    for (;;) {
      const dirty = [...this._envelopes].filter((e) => e.dirty && !e.disposed);
      if (dirty.length === 0) return;

      const batch = dirty.filter((e) => !ran.has(e));
      if (batch.length === 0) {
        // Remaining dirty units already ran this settle — treat as quiesced
        // (n-cycle absorbed). Clear flags so a later settle starts clean.
        for (const e of dirty) e.clearDirty();
        return;
      }

      if (rounds >= maxRounds) {
        throw new Error(`did not quiesce in ${maxRounds} rounds`);
      }
      rounds++;

      for (const e of batch) {
        ran.add(e);
        e.clearDirty();
        await e.reinvoke();
      }
    }
  }

  disposeAll(): void {
    for (const e of [...this._envelopes]) e.dispose();
  }

  /** @internal */
  _unregister(env: ReactionEnvelopeImpl): void {
    this._envelopes.delete(env);
  }
}

// ── Public bus (bare exec + harness) ─────────────────────────────────────────

/**
 * PathAtomBus shared for non-envelope writers. Observations are ignored (no
 * unit owns them); staged effects publish as foreign on commitRun.
 */
class HubPublicBus implements PathAtomBus {
  private staged: ResourcePath[] = [];

  constructor(private readonly hub: ReactionHubImpl) {}

  observe(_paths: readonly ResourcePath[]): void {
    // Bare writers are not subscription units — observe is a no-op here.
  }

  stageEffects(paths: readonly ResourcePath[]): void {
    for (const p of paths) {
      if (p.length > 0) this.staged.push(p);
    }
  }

  commitRun(): void {
    const effects = this.staged;
    this.staged = [];
    this.hub.publish(effects, null);
  }

  abandonRun(): void {
    this.staged = [];
  }

  invalidate(paths: readonly ResourcePath[]): void {
    this.hub.publish(
      paths.filter((p) => p.length > 0),
      null,
    );
  }
}

// ── Per-envelope bus ─────────────────────────────────────────────────────────

/** PathAtomBus private to one envelope — observe/stage feed that unit only. */
class EnvelopeAtomBus implements PathAtomBus {
  constructor(private readonly env: ReactionEnvelopeImpl) {}

  observe(paths: readonly ResourcePath[]): void {
    this.env.noteObserved(paths);
  }

  stageEffects(paths: readonly ResourcePath[]): void {
    this.env.stage(paths);
  }

  commitRun(): void {
    this.env.onCommitSuccess();
  }

  abandonRun(): void {
    this.env.onAbandon();
  }

  invalidate(paths: readonly ResourcePath[]): void {
    // Harness shortcut on an envelope bus — treat as foreign (no self-attribution).
    this.env.hub.publish(
      paths.filter((p) => p.length > 0),
      null,
    );
  }
}

// ── Envelope ─────────────────────────────────────────────────────────────────

class ReactionEnvelopeImpl implements ReactionEnvelope {
  readonly hub: ReactionHubImpl;
  private readonly spec: ReactionUnitSpec;
  private readonly atomBus: EnvelopeAtomBus;
  /** Frozen opt-in set from construction (A-OPTIN). */
  readonly optInParams: readonly string[];

  private _disposed = false;
  private _dirty = false;
  private _runCount = 0;
  private _lastResult: unknown = undefined;
  private _lastCache: RunCache | undefined = undefined;
  private _lastPathLog: ResourcePathLog | undefined = undefined;

  /** Last successful subscription set (RX-SUBS). */
  private subs: ResourcePath[] = [];
  /** Paths observed during the in-flight run (pending replace). */
  private runObserved: ResourcePath[] = [];
  /** Effect paths staged during the in-flight run. */
  private staged: ResourcePath[] = [];
  /** True while an exec for this unit is on the stack. */
  private running = false;

  constructor(hub: ReactionHubImpl, spec: ReactionUnitSpec) {
    this.hub = hub;
    this.spec = spec;
    this.optInParams = Object.freeze([...(spec.optInParams ?? [])]);
    this.atomBus = new EnvelopeAtomBus(this);
  }

  get disposed(): boolean {
    return this._disposed;
  }
  get dirty(): boolean {
    return this._dirty;
  }
  get runCount(): number {
    return this._runCount;
  }
  get lastResult(): unknown {
    return this._lastResult;
  }
  get lastCache(): RunCache | undefined {
    return this._lastCache;
  }
  get lastPathLog(): ResourcePathLog | undefined {
    return this._lastPathLog;
  }
  get subscriptionPaths(): readonly ResourcePath[] {
    return this.subs;
  }

  /** @internal */
  noteObserved(paths: readonly ResourcePath[]): void {
    for (const p of paths) {
      if (p.length > 0) this.runObserved.push(p);
    }
  }

  /** @internal */
  stage(paths: readonly ResourcePath[]): void {
    for (const p of paths) {
      if (p.length > 0) this.staged.push(p);
    }
  }

  /** @internal — successful run clock (called from bus.commitRun via exec). */
  onCommitSuccess(): void {
    const effects = this.staged;
    this.staged = [];
    // RX-SUBS / P-RX-SUB-REPLACE: replace wholesale on success.
    // If dispose raced mid-run, discard — do not install (N-RX-DISPOSE-INFLIGHT).
    if (!this._disposed) {
      this.subs = this.runObserved.slice();
    } else {
      // Disposed mid-flight: drop provisional observations; keep subs empty (already cleared).
      this.subs = [];
    }
    this.runObserved = [];
    // Publish after subs replace so a same-tick foreign listener sees stable state.
    // Self is skipped by source attribution (RX-SELF).
    if (effects.length > 0) {
      this.hub.publish(effects, this);
    }
  }

  /** @internal — failed run: drop staged + this-run observe; keep last successful subs. */
  onAbandon(): void {
    this.staged = [];
    this.runObserved = [];
  }

  /**
   * @internal — path overlap against live subs, plus provisional this-run observations
   * while in flight so a foreign write during `deferredRead` still queues run2
   * (**P-RX-INFLIGHT** — no cancel, no drop).
   */
  subsOverlap(writes: readonly ResourcePath[]): boolean {
    for (const w of writes) {
      for (const q of this.subs) {
        if (pathsOverlap(w, q)) return true;
      }
      if (this.running) {
        for (const q of this.runObserved) {
          if (pathsOverlap(w, q)) return true;
        }
      }
    }
    return false;
  }

  /** @internal */
  markDirty(): void {
    if (!this._disposed) this._dirty = true;
  }

  /** @internal */
  clearDirty(): void {
    this._dirty = false;
  }

  async run(): Promise<unknown> {
    return this.invoke();
  }

  /** @internal — re-invoke after foreign invalidate (same path as run). */
  async reinvoke(): Promise<unknown> {
    return this.invoke();
  }

  private async invoke(): Promise<unknown> {
    if (this._disposed) {
      throw new Error("ReactionEnvelope: invoke after dispose");
    }
    if (this.running) {
      throw new Error("ReactionEnvelope: re-entrant invoke (sequential multi-envelope only)");
    }
    this.running = true;
    this._runCount++;
    // RX-FRESH: all three axes, every time.
    const cache = new MemoryRunCache("record");
    const pathLog = new MemoryResourcePathLog();
    this._lastCache = cache;
    this._lastPathLog = pathLog;
    // Reset per-run accumulators (commit/abandon also clear; belt + suspenders).
    this.runObserved = [];
    this.staged = [];

    const { code: codeSpec, optInParams: _optIn, ...rest } = this.spec;
    const code = typeof codeSpec === "function" ? codeSpec() : codeSpec;

    // A-OPTIN: merge hub param atoms into config.params for opted-in names only.
    // Param values never touch resourcePaths / prior-E (N-RX-OPTIN-NOT-DOOR-FUEL).
    const execOpts: ExecOptions = {
      ...rest,
      // Live envelope prefers strictCQSstrings (RX-STRICT); caller may override true/false.
      strictCQSstrings: rest.strictCQSstrings ?? true,
      pathAtoms: this.atomBus,
      cache,
      resourcePaths: pathLog,
    };
    if (this.optInParams.length > 0) {
      const baseConfig = (rest.config ?? {}) as Record<string, unknown>;
      const baseParams =
        baseConfig.params !== undefined &&
        typeof baseConfig.params === "object" &&
        baseConfig.params !== null
          ? { ...(baseConfig.params as Record<string, unknown>) }
          : {};
      for (const name of this.optInParams) {
        if (this.hub.hasParam(name)) baseParams[name] = this.hub.getParam(name);
      }
      execOpts.config = { ...baseConfig, params: baseParams };
    }

    try {
      const result = await exec(code, execOpts);
      this._lastResult = result;
      return result;
    } catch (e) {
      // exec already called abandonRun on owned pathAtoms when it fails.
      throw e;
    } finally {
      this.running = false;
    }
  }

  async settle(opts: SettleOptions): Promise<void> {
    // Unit-level settle drains the whole hub (cross-unit wakes need peers).
    return this.hub.settle(opts);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._dirty = false;
    this.subs = [];
    // Keep runObserved if mid-flight so onCommitSuccess still sees dispose and discards;
    // do not clear runObserved here — commit path checks _disposed.
    this.staged = [];
    this.hub._unregister(this);
  }
}
