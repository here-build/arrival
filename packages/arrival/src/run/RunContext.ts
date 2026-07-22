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
 * isolate), the three ctx species (live-run / CONSTANT_CTX / parse), and the five channels'
 * arm-subset-wise `X | undefined ⇒ facility off` rule — is docs/execution.md §HERMETIC,
 * §CTX-SPECIES, §CHANNELS. This file is their enforcement site; the per-field docs below are
 * the landings those sections name.
 *
 * PLACEMENT TEST for a new field: does it vary between concurrent runs (→ here), never
 * (→ a global singleton — nil/#t/#f/eof carry no run-state, car-of-nil reads strict off the
 * threaded context), or within one run by call depth (→ a dynamic-extent holder — the
 * exception-handler stack, the call-site)? Only the first belongs on RunContext.
 */

import type { RunCache } from "./run-cache.js";
import type { DisplaySink, NoteSink } from "./note-sink.js";
import type { EffectLog } from "./effect-log.js";
import type { ReadGuard } from "./read-guard.js";
import type { SourceLocation } from "../errors.js";
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
  /** Origin discriminant. `"parse"` marks the parse-time family (`PARSE_CTX`/`makeParseCtx`,
   *  the {@link ParseContext} subclass): run-neutral like CONSTANT_CTX, but a stated fact rather
   *  than a fallback. Absent on live-run ctxs and CONSTANT_CTX. */
  readonly origin?: "parse";
  /** Source identity for parse-minted values — the `SourceLocation` the Parser computes per datum.
   *  Present only on the parse family, and `undefined` there for synthesized/location-less values.
   *  Leaf literals (no location slot) get source identity through here alone; `APair.setLocation`
   *  is a derived MIRROR the Parser also writes, so `[LOCATION]`-slot readers stay untouched. */
  readonly location?: SourceLocation;
  /** 1d: this run's per-capability resource store (see {@link CapabilityResourceStore}). The
   *  `arrival/tagless-final/apply` dispatch wrapper (via makeCallCtx) reads a value's resources
   *  from here, keyed by the value's owning capability. `undefined` on a RunContext minted with no
   *  producer (the bare-`env` exec path, CONSTANT_CTX, PARSE_CTX) — a resource-reading verb under
   *  such a run sees `this.resources === undefined`, same as a resource-less capability. */
  readonly capabilityResources?: CapabilityResourceStore;

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
    } = {},
    /** internal-only: `true` for the run-NEUTRAL singletons (CONSTANT_CTX, the ParseContext
     *  family) — they get no capabilityResources store (see that field's doc). Never pass this
     *  from an ordinary mint site; it exists only so CONSTANT_CTX/ParseContext can share this
     *  constructor's defaulting logic instead of duplicating it. */
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
    if (!_noResourceStore) {
      this.capabilityResources = new WeakMap<object, unknown>();
    }
  }

  /** STAGE 2 (run-lifecycle.ts): tears down whatever ended up scoped to THIS RunContext (a
   *  capability's per-run resources), so `await using runCtx = new RunContext(...)` disposes it at
   *  scope exit. Delegates to {@link disposeRunContext} — the SAME idempotent function a REPL host
   *  or `exec()`'s owned-runCtx `finally` calls explicitly, so all three teardown paths share one
   *  guard. A uniform prototype method — `CONSTANT_CTX`/`PARSE_CTX` inherit it too, but
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

/**
 * The parse-origin context family (docs/execution.md §CTX-SPECIES) — CONSTANT_CTX plus
 * `origin: "parse"` and the per-datum `SourceLocation`, which for leaf literals (symbols,
 * strings, numbers, chars, vectors, bytevectors, dicts) is their FIRST source identity (only
 * APair has a location slot; every other node kind's source identity lives on the ctx channel).
 *
 * CODE CONSEQUENCE: per-node ctxs mean parsed symbols no longer share CONSTANT_CTX's flyweight
 * intern table — each occurrence is its own instance (per-occurrence source identity and a
 * shared interned instance are mutually exclusive). Sound because eq?/eqv?/equals compare
 * `__name__`, never reference.
 */
export class ParseContext extends RunContext {
  readonly origin: "parse";
  readonly location: SourceLocation | undefined;

  constructor(location: SourceLocation | undefined) {
    super({}, true);
    this.origin = "parse";
    this.location = location;
  }
}

/** The shared LOCATION-LESS parse ctx — for synthesized or sourceless parse values
 *  (`makeParseCtx(undefined)` returns this singleton; no per-node allocation when
 *  there is no location to carry). */
export const PARSE_CTX: ParseContext = Object.freeze(new ParseContext(undefined));

/**
 * Mint the parse ctx for one parsed node. Location-bearing nodes get a small frozen
 * per-node ctx (frozen because parsed AST — and therefore its ctx — is shared across
 * runs); location-less ones share the `PARSE_CTX` singleton.
 */
export function makeParseCtx(location: SourceLocation | undefined): ParseContext {
  if (location === undefined) return PARSE_CTX;
  return Object.freeze(new ParseContext(location));
}

/** Narrowing read for the parse family: "was v minted by the reader, and where" — a door
 *  can point at the exact leaf via `ctx.location`. */
export function isParseCtx(ctx: RunContext): ctx is ParseContext {
  return ctx.origin === "parse";
}
