/**
 * RunContext — the per-run handle carried by every value built during a run
 * (`AValue.ctx`), minted once per `exec()` by `makeRunContext`. The run's identity: state
 * CONSTANT for one run yet DIFFERING between concurrent runs.
 *
 * The model this type realizes — why run-state is DATA-LOCAL (hermetic exec on one shared
 * isolate), the three ctx species (live-run / CONSTANT_CTX / parse), and the five channels'
 * arm-subset-wise `X | undefined ⇒ facility off` rule — is docs/RUN-MODEL.md §HERMETIC,
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

/** Per-run allocation meter. The reference is fixed for the run; `used` is incremented
 *  in place as cells materialize. */
export interface HeapMeter {
  used: number;
  max: number;
}

export interface RunContext {
  /** R7RS-strict nil-projection (`car`/`cdr` of nil throws) vs tolerant (yields nil). */
  readonly strict: boolean;
  /** Per-run allocation bound; `undefined` ⇒ unbounded (default — only sandbox/agent runs opt in). */
  readonly heapMeter: HeapMeter | undefined;
  /** The freeze contract (docs/MEMBRANE.md §BOXING): freeze a borrowed AJSObject/AJSArray source on
   *  first Scheme read. `false` opts out (host keeps it mutable). Default `true`. */
  readonly freezeRosettaReturns: boolean;
  /** The run's execution-budget signal — the SAME AbortSignal the trampoline reads, so all
   *  consumers observe abort state off one reference that cannot drift. */
  readonly signal: AbortSignal | undefined;
  /** The run's cache (run-cache.ts); `undefined` ⇒ no interception. Armed ⇒ gates record/replay
   *  per the stamped cache class (docs/RUN-MODEL.md §MODE-LAW). */
  readonly cache: RunCache | undefined;
  /** The run's gathered-effect manifest (effect-log.ts); `undefined` ⇒ no burst arm (a sink fires
   *  immediately). Armed ⇒ a `sink` penetration during a PRIME run gathers instead of firing
   *  (docs/RUN-MODEL.md §BURST). */
  readonly effects: EffectLog | undefined;
  /** The run's read-tracking + deferral-guard seam (read-guard.ts); `undefined` ⇒ no tracking, no
   *  guard. Armed ⇒ the eval loop wraps each top-level form in a tracking region and runs the
   *  read∩write guard after each form (docs/RUN-MODEL.md §READ-GUARD). */
  readonly reads: ReadGuard | undefined;
  /** The run's model-facing note channel (note-sink.ts); `undefined` ⇒ notes are dropped. */
  readonly notes: NoteSink | undefined;
  /** The run's display channel (note-sink.ts) — where the MCP runner's `display` affordance records
   *  what a model asked to see. `undefined` ⇒ no display verb is bound (arrival binds none). */
  readonly display: DisplaySink | undefined;
  /** Origin discriminant. `"parse"` marks the parse-time family (`PARSE_CTX`/`makeParseCtx`):
   *  run-neutral like CONSTANT_CTX, but a stated fact rather than a fallback. Absent on live-run
   *  ctxs and CONSTANT_CTX. */
  readonly origin?: "parse";
  /** Source identity for parse-minted values — the `SourceLocation` the Parser computes per datum.
   *  Present only on the parse family, and `undefined` there for synthesized/location-less values.
   *  Leaf literals (no location slot) get source identity through here alone; `APair.setLocation`
   *  is a derived MIRROR the Parser also writes, so `[LOCATION]`-slot readers stay untouched. */
  readonly location?: SourceLocation;
}

/** Mint a fresh per-run context for one `exec()`. The single place a RunContext is born. */
export function makeRunContext(
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
): RunContext {
  return {
    strict: opts.strict ?? false,
    heapMeter: opts.heapBudget === undefined ? undefined : { used: 0, max: opts.heapBudget },
    freezeRosettaReturns: opts.freezeRosettaReturns ?? true,
    signal: opts.signal,
    cache: opts.cache,
    effects: opts.effects,
    reads: opts.reads,
    notes: opts.notes,
    display: opts.display,
  };
}

/**
 * The run-NEUTRAL context (docs/RUN-MODEL.md §CTX-SPECIES). Carried by values that outlive
 * any single run: the singletons, quoted-literal AST nodes (`evalQuote` returns them by
 * reference across runs), everything constructed at bootstrap before a run exists. Frozen,
 * `strict=false`, no meter, all five channels `undefined` — nobody is listening, so a value
 * minted here can never carry one run's state into another.
 */
export const CONSTANT_CTX: RunContext = Object.freeze({
  strict: false,
  heapMeter: undefined,
  freezeRosettaReturns: true,
  signal: undefined,
  notes: undefined,
  display: undefined,
  cache: undefined,
  effects: undefined,
  reads: undefined,
});

/**
 * The parse-origin context family (docs/RUN-MODEL.md §CTX-SPECIES) — CONSTANT_CTX plus
 * `origin: "parse"` and the per-datum `SourceLocation`, which for leaf literals (symbols,
 * strings, numbers, chars, vectors, bytevectors, dicts) is their FIRST source identity (only
 * APair has a location slot; every other node kind's source identity lives on the ctx channel).
 *
 * CODE CONSEQUENCE: per-node ctxs mean parsed symbols no longer share CONSTANT_CTX's flyweight
 * intern table — each occurrence is its own instance (per-occurrence source identity and a
 * shared interned instance are mutually exclusive). Sound because eq?/eqv?/equals compare
 * `__name__`, never reference.
 */
export interface ParseContext extends RunContext {
  readonly origin: "parse";
  readonly location: SourceLocation | undefined;
}

/** The shared LOCATION-LESS parse ctx — for synthesized or sourceless parse values
 *  (`makeParseCtx(undefined)` returns this singleton; no per-node allocation when
 *  there is no location to carry). */
export const PARSE_CTX: ParseContext = Object.freeze({
  ...CONSTANT_CTX,
  origin: "parse" as const,
  location: undefined,
});

/**
 * Mint the parse ctx for one parsed node. Location-bearing nodes get a small frozen
 * per-node ctx (frozen because parsed AST — and therefore its ctx — is shared across
 * runs); location-less ones share the `PARSE_CTX` singleton.
 */
export function makeParseCtx(location: SourceLocation | undefined): ParseContext {
  if (location === undefined) return PARSE_CTX;
  return Object.freeze({ ...CONSTANT_CTX, origin: "parse" as const, location });
}

/** Narrowing read for the parse family: "was v minted by the reader, and where" — a door
 *  can point at the exact leaf via `ctx.location`. */
export function isParseCtx(ctx: RunContext): ctx is ParseContext {
  return ctx.origin === "parse";
}
