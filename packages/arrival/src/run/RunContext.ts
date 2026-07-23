/**
 * RunContext — the per-run handle, minted once per `exec()` by `new RunContext(...)` and
 * threaded explicitly through ops as `runCtx`. The run's identity: state CONSTANT for one
 * run yet DIFFERING between concurrent runs.
 *
 * TODO(ctx-elimination): this used to also be carried by every VALUE built during a run
 * (`AValue.ctx`) — that per-value field is gone (see AValue.ts's ctx-removal note); the
 * type itself is unchanged and stays the currency of every `runCtx` op parameter below.
 *
 * The model this type realizes — why run-state is DATA-LOCAL (hermetic exec on one shared
 * isolate), the two ctx species (live-run / CONSTANT_CTX), and the five channels'
 * arm-subset-wise `X | undefined ⇒ facility off` rule — is docs/execution.md §HERMETIC,
 * §CTX-SPECIES, §CHANNELS. This file is their enforcement site; the per-field docs below are
 * the landings those sections name.
 *
 * PLACEMENT TEST for a new field: does it vary between concurrent runs (→ here), never
 * (→ a global singleton — nil/#t/#f/eof carry no run-state, car-of-nil reads strict off the
 * threaded context), or within one run by call depth (→ a dynamic-extent holder — the
 * exception-handler stack, the call-site)? Only the first belongs on RunContext.
 *
 * NOTE — parse-time source identity does NOT live here. It used to (the retired
 * `ParseContext`/`PARSE_CTX`/`makeParseCtx` family: a one-hop envelope the Parser minted
 * per datum, wrapping a `SourceLocation` purely to hand it to the leaf minter one call
 * later, which unwrapped `.location` and stamped it on the value — ctx discarded
 * immediately after). Nothing else ever read `origin` or a ctx's `.location`, so the
 * envelope was retired: a `SourceLocation` now threads as a plain `loc?: SourceLocation`
 * argument straight from the Parser to `parse_argument`/`ADict.fromLiteralForms` to the
 * leaf mints, landing on the VALUE's own `.location` field (AValue) — no ctx involved.
 */

import type { RunCache } from "./run-cache.js";
import type { DisplaySink, NoteSink } from "./note-sink.js";
import type { EffectLog } from "./effect-log.js";
import type { ReadGuard } from "./read-guard.js";
import { disposeRunContext } from "./run-lifecycle.js";

/** The per-run, per-CAPABILITY resource store (1d) — a capability's lazily-produced `Resources`
 *  bag, keyed by the owning EnvCapability object, scoped to THIS RunContext (survives REPL passes
 *  that reuse it; a different RunContext gets its own). The key is opaque (`object`) so this leaf
 *  file never imports the capability layer.
 *
 *  Filled by `makeCallCtx` (CallCtx.ts) on first dispatch of a resource-bearing verb — a plain
 *  `WeakMap` get-or-compute: absent ⇒ call the owning capability's `["arrival/get-resources"]`
 *  (fed the per-assembly config the association carries) and store the result — a plain bag (sync
 *  `resources` factory) or a pending Promise (a real async acquire). Because JS runs one dispatch
 *  at a time, the `has`-then-`set` IS the semaphore: every later dispatch — including concurrent
 *  `map`/`filter` fan-out that only interleaves at `await` points — sees the stored value/promise
 *  and never spawns a second acquire. A pending bag is REPLACED in-slot by its resolved value on
 *  settle (the collapse), so warm reads are plain and microtask-free. Disposal is the capability's
 *  job (its `get-resources` registers `onRunContextDispose`), not the store's. */
export type CapabilityResourceStore = WeakMap<object, unknown>;

/** The per-run, per-CAPABILITY validated CONFIGURATION table (the relocation this same axis's
 *  RESOURCES already underwent, above) — capability object → its assembly's validated
 *  configuration, scoped to THIS RunContext. Opaque `object` keys, same as
 *  {@link CapabilityResourceStore}, so this leaf file never imports the capability layer.
 *
 *  Unlike the resource store, this table is FILLED ONCE, EAGERLY, at mint (`env/assemble-run.ts`'s
 *  `assembleRun`, from `Vocabulary.configsByCapability`) — never lazily grown at dispatch. A plain
 *  `ReadonlyMap` is enough (the full capability roster is known and finite the moment a RunContext
 *  is minted against a vocabulary tuple); reused-`runCtx` REPL passes carry the table their FIRST
 *  mint built. Since Stage C Cut 3b, EVERY public exec path (`execState`/`execExpr`, including
 *  their standalone bare-call default — the degenerate `BASE_ROSTER` tuple) is vocabulary-bearing
 *  and gets this table; only `CONSTANT_CTX` and the internal, non-public live-frame family
 *  (`execStateOverFrame`/`execOverFrame`/`execExprOverFrame`/`execInFrame`, generator-exec.ts —
 *  a caller-held raw `AmbientRuntime`, not a vocabulary tuple) carry no table.
 *
 *  Read by `makeCallCtx` (CallCtx.ts) at every dispatch of a value with an
 *  `associateCapability`-registered owner: `runCtx.capabilityConfigurations?.get(capability)`
 *  becomes `this.configuration`, and the SAME lookup feeds `resolveCapabilityResources`'s call to
 *  the capability's `["arrival/get-resources"]` — one source of truth for both channels. The
 *  motivating reason this axis moved off the bind-time association (docs/execution.md §CALLCTX):
 *  a symbol factory that mints ONE value at `define()` time for EVERY assembly of a capability
 *  cannot carry per-assembly config on a value-keyed WeakMap (a second assembly's config would
 *  silently clobber the first's); keying by THE RUN — which genuinely differs per assembly —
 *  cannot collide. */
export type CapabilityConfigurationTable = ReadonlyMap<object, unknown>;

/** Per-run allocation meter. The reference is fixed for the run; `used` is incremented
 *  in place as cells materialize. */
export interface HeapMeter {
  used: number;
  max: number;
}

/** Mint a fresh per-run context for one `exec()`. The single place a RunContext is born. Its
 *  `capabilityResources` store starts empty and is filled lazily on first dispatch of a
 *  resource-bearing verb (see {@link CapabilityResourceStore} and CallCtx.ts's makeCallCtx). */
export class RunContext {
  /** R7RS-strict nil-projection (`car`/`cdr` of nil throws) vs tolerant (yields nil). */
  readonly strict: boolean;
  /** Per-run allocation bound; `undefined` ⇒ unbounded (default — only sandbox/agent runs opt in). */
  readonly heapMeter: HeapMeter | undefined;
  /** The freeze contract (docs/membrane.md §BOXING): freeze a borrowed AJSObject/AJSArray source on
   *  first Scheme read. `false` opts out (host keeps it mutable). Default `true`. */
  readonly freezeRosettaReturns: boolean;
  /** The run's execution-budget signal — the SAME AbortSignal the trampoline reads, so all
   *  consumers observe abort state off one reference that cannot drift. */
  readonly signal: AbortSignal | undefined;
  /** The run's cache (run-cache.ts); `undefined` ⇒ no interception. Armed ⇒ gates record/replay
   *  per the stamped cache class (docs/execution.md §MODE-LAW). */
  readonly cache: RunCache | undefined;
  /** The run's gathered-effect manifest (effect-log.ts); `undefined` ⇒ no burst arm (a sink fires
   *  immediately). Armed ⇒ a `sink` penetration during a PRIME run gathers instead of firing
   *  (docs/execution.md §BURST). */
  readonly effects: EffectLog | undefined;
  /** The run's read-tracking + deferral-guard seam (read-guard.ts); `undefined` ⇒ no tracking, no
   *  guard. Armed ⇒ the eval loop wraps each top-level form in a tracking region and runs the
   *  read∩write guard after each form (docs/execution.md §READ-GUARD). */
  readonly reads: ReadGuard | undefined;
  /** The run's model-facing note channel (note-sink.ts); `undefined` ⇒ notes are dropped. */
  readonly notes: NoteSink | undefined;
  /** The run's display channel (note-sink.ts) — where the MCP runner's `display` affordance records
   *  what a model asked to see. `undefined` ⇒ no display verb is bound (arrival binds none). */
  readonly display: DisplaySink | undefined;
  /** 1d: this run's per-capability resource store (see {@link CapabilityResourceStore}). The
   *  `arrival/tagless-final/apply` dispatch wrapper (via makeCallCtx) reads a value's resources
   *  from here, keyed by the value's owning capability. Every ordinary mint gets a fresh (empty,
   *  lazily-filled) store — `undefined` ONLY for the run-NEUTRAL `CONSTANT_CTX` singleton
   *  (`_noResourceStore`, the constructor's internal-only flag) — a resource-reading verb under
   *  such a run sees `this.resources === undefined`, same as a resource-less capability. */
  readonly capabilityResources?: CapabilityResourceStore;
  /** This run's per-capability CONFIGURATION table (see {@link CapabilityConfigurationTable}).
   *  Filled ONCE at construction from `opts.capabilityConfigurations` — never grown later, unlike
   *  `capabilityResources`. Since Stage C Cut 3b, EVERY public exec path (`execState`/`execExpr`,
   *  including their standalone bare-call default) mints via `assembleRun` and gets this table;
   *  `undefined` only for `CONSTANT_CTX` and the internal, non-public live-frame family
   *  (`execStateOverFrame`/`execOverFrame`/`execExprOverFrame`/`execInFrame`, generator-exec.ts) —
   *  `makeCallCtx` (CallCtx.ts) then leaves `this.configuration` `undefined` too, same posture as
   *  a capability with no configuration schema at all. */
  readonly capabilityConfigurations?: CapabilityConfigurationTable;
  /** Stage B1 (docs/plans/stage-b-runcontext-absorbs-assembly.md) — the {@link
   *  Vocabulary.map | Vocabulary}'s flat name→value artifact this run resolves through, when
   *  minted via `env/assemble-run.ts`'s `assembleRun`. Kept OPAQUE here (`unknown`, not the real
   *  `AmbientValue`) so this LEAF file never imports the env layer — `env/vocabulary.ts` and its
   *  consumers narrow the type at their own boundary. Since Stage C Cut 3b, EVERY public exec path
   *  is vocabulary-bearing; `undefined` only for `CONSTANT_CTX` and the internal, non-public
   *  live-frame family (see `capabilityConfigurations`'s doc above — same carve-out, same reason). */
  readonly vocabulary?: ReadonlyMap<string, unknown>;
  /** Stage B1 — this run's tuple's degraded-capability list (the SAME shape `Vocabulary.degraded`
   *  carries — the retired `AssembledEnv.degraded`, pre Cut 3b, carried the shape before it),
   *  opaque here for the identical reason `vocabulary` is. `undefined` off the vocabulary path
   *  (`CONSTANT_CTX` + the internal live-frame family). */
  readonly degraded?: readonly unknown[];

  constructor(
    opts: {
      strict?: boolean;
      heapBudget?: number;
      freezeRosettaReturns?: boolean;
      signal?: AbortSignal;
      cache?: RunCache;
      effects?: EffectLog;
      reads?: ReadGuard;
      notes?: NoteSink;
      display?: DisplaySink;
      /** The CONFIGURATION relocation's supply seam — `env/assemble-run.ts`'s `assembleRun` is
       *  the one production caller, passing the table it built from `Vocabulary.configsByCapability`.
       *  The internal, non-public live-frame family + `CONSTANT_CTX` omit it (see the field's own
       *  doc above). */
      capabilityConfigurations?: CapabilityConfigurationTable;
      /** Stage B1 — see the field's own doc above. Supplied by `env/assemble-run.ts`'s
       *  `assembleRun` only. */
      vocabulary?: ReadonlyMap<string, unknown>;
      /** Stage B1 — see the field's own doc above. Supplied by `env/assemble-run.ts`'s
       *  `assembleRun` only. */
      degraded?: readonly unknown[];
    } = {},
    /** internal-only: `true` for the run-NEUTRAL singleton (CONSTANT_CTX) — it gets no
     *  capabilityResources store (see that field's doc). Never pass this from an ordinary
     *  mint site; it exists only so CONSTANT_CTX can share this constructor's defaulting
     *  logic instead of duplicating it. */
    _noResourceStore = false,
  ) {
    this.strict = opts.strict ?? false;
    this.heapMeter = opts.heapBudget === undefined ? undefined : { used: 0, max: opts.heapBudget };
    this.freezeRosettaReturns = opts.freezeRosettaReturns ?? true;
    this.signal = opts.signal;
    this.cache = opts.cache;
    this.effects = opts.effects;
    this.reads = opts.reads;
    this.notes = opts.notes;
    this.display = opts.display;
    this.capabilityConfigurations = opts.capabilityConfigurations;
    this.vocabulary = opts.vocabulary;
    this.degraded = opts.degraded;
    if (!_noResourceStore) {
      this.capabilityResources = new WeakMap<object, unknown>();
    }
  }

  /** STAGE 2 (run-lifecycle.ts): tears down whatever ended up scoped to THIS RunContext (a
   *  capability's per-run resources), so `await using runCtx = new RunContext(...)` disposes it at
   *  scope exit. Delegates to {@link disposeRunContext} — the SAME idempotent function a REPL host
   *  or `exec()`'s owned-runCtx `finally` calls explicitly, so all three teardown paths share one
   *  guard. A uniform prototype method — `CONSTANT_CTX` inherits it too, but
   *  `disposeRunContext` is registry-keyed and idempotent, so disposing a singleton nothing ever
   *  registered against is simply a no-op. */
  async [Symbol.asyncDispose](): Promise<void> {
    return disposeRunContext(this);
  }
}

/**
 * The run-NEUTRAL context (docs/execution.md §CTX-SPECIES). Carried by values that outlive
 * any single run: the singletons, quoted-literal AST nodes (`evalQuote` returns them by
 * reference across runs), everything constructed at bootstrap before a run exists. Frozen,
 * `strict=false`, no meter, all five channels `undefined` — nobody is listening, so a value
 * minted here can never carry one run's state into another.
 */
export const CONSTANT_CTX: RunContext = Object.freeze(new RunContext({}, true));
