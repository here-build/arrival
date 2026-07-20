/**
 * RunContext — the per-run handle carried by every value built during a run
 * (`AValue.ctx`), minted once per `exec()` by `makeRunContext`.
 *
 * WHY — `exec()` must be HERMETIC: concurrent runs sharing one isolate (a CF Durable
 * Object) must not bleed run-state through module-level holders. Run-state is therefore
 * DATA-LOCAL — minted once per exec, carried on the values/context, never reached for
 * ambiently.
 *
 * WHAT LIVES HERE — only state CONSTANT for one exec yet differing between concurrent
 * runs. NOT here: the singletons (nil/#t/#f/eof stay GLOBAL CONSTANTS — car-of-nil's
 * strict is read from the threaded run context, so a constant nil bears no run-state).
 * NOT here: dynamic-extent state (exception-handler stack, call-site) — that varies by
 * call depth, cannot ride a constant-per-run handle, and stays the holder family.
 *
 * The optional channels `cache`/`effects`/`reads`/`notes`/`display` are independent
 * per-run seams a host arms: each `undefined` ⇒ that facility is off (the default), each
 * read off `this.runCtx.<field>` at the one hermetic point, none a field of another — a
 * run may carry any subset. The baked rosetta `run` wrapper is their common reader.
 *
 * Three ctx species exist: live-run (above), CONSTANT_CTX (run-neutral, outlives any
 * run), and the parse family (`origin: "parse"`, carrying source location). The latter
 * two are run-neutral by charter, so a value minted before or outside a run can never
 * carry one run's state into another.
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
  /** Freeze the borrowed JS source inside AJSObject/AJSArray the first time Scheme reads it, so a
   *  rosetta return (or any borrowed value) cannot be mutated by the host afterward — prevention by
   *  construction. `false` opts out (host keeps it mutable). */
  readonly freezeRosettaReturns: boolean;
  /** The run's execution-budget signal — the SAME AbortSignal the trampoline reads, so all
   *  consumers observe abort state off one reference that cannot drift. */
  readonly signal: AbortSignal | undefined;
  /** The run's cache (run-cache.ts); `undefined` ⇒ no interception. Gates record/replay per the
   *  stamped cache class. */
  readonly cache: RunCache | undefined;
  /** The run's gathered-effect manifest (effect-log.ts); `undefined` ⇒ no burst arm (a sink fires
   *  immediately). A `sink` penetration during a PRIME run (not a cache replay) enqueues instead of
   *  firing. */
  readonly effects: EffectLog | undefined;
  /** The run's read-tracking + deferral-guard seam (read-guard.ts); `undefined` ⇒ no tracking, no
   *  guard. When present, the eval loop wraps each top-level form in `reads.tracker.region(...)` and,
   *  for a PRIME run gathering effects, checks `checkReadWriteGuard` after each form. */
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
 * The run-NEUTRAL context. Carried by values that outlive any single run: the
 * singletons, quoted-literal AST nodes (`evalQuote` returns them by reference across
 * runs), and everything constructed at bootstrap before a run exists. Immutable, shared,
 * bears no run-state (`strict=false`, no meter) — so it can never carry one run's
 * mode/meter into another. Its channels are all `undefined`: a note or effect is
 * addressed to ONE run, so a context outliving every run has nowhere to put one, and a
 * value minted here drops them — correct, not a gap: nobody is listening.
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
 * The parse-origin context family. What it ADDS over CONSTANT_CTX: `origin: "parse"` plus the
 * `SourceLocation` the Parser computes per datum — which, for leaf literals (symbols, strings,
 * numbers, chars, vectors, bytevectors, dicts), is the FIRST source identity they carry (only
 * APair has a location slot; every other node kind's source identity lives on the ctx channel).
 *
 * Per-node ctxs mean parsed symbols no longer share CONSTANT_CTX's flyweight intern table —
 * each occurrence is its own instance (per-occurrence source identity and a shared interned
 * instance are mutually exclusive). Sound because eq?/eqv?/equals compare `__name__`, never
 * reference.
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
