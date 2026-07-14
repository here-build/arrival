/**
 * RunContext — the per-run handle the hermetic-ctx migration threads, carried by
 * every value constructed during a run (`AValue.ctx`). See the memory
 * `project-arrival-hermetic-env-dissolution` for the full DAG.
 *
 * ── Why it exists ────────────────────────────────────────────────────────────
 * `exec()` must be HERMETIC: concurrent runs sharing one isolate (a CF Durable
 * Object) must not bleed run-state through module-level holders. The fix is to make
 * run-state DATA-LOCAL — minted once per exec, carried on the values/context rather
 * than reached for ambiently.
 *
 * ── What lives here, and what deliberately does NOT ──────────────────────────
 * Only state that is CONSTANT for one exec yet must differ between concurrent runs:
 * `strict` (nil-projection mode) and `heapMeter` (the per-run allocation bound).
 * It is intentionally lean; more fields land as ops move off the holders.
 *
 *  - NOT here: the singletons. nil/#t/#f/eof stay GLOBAL CONSTANTS — car-of-nil's
 *    strict is read from the THREADED run context (the `runCtx` parameter the
 *    tagless terms take), not from `nil.ctx`, so a constant nil bears no run-state
 *    and never needed to be per-run (the corrected plan).
 *  - NOT here: dynamic-extent state (exception-handler stack, call-site). That VARIES
 *    by call depth, so it can't ride a constant-per-run handle — it stays the holder
 *    family, dissolved separately through the trampoline.
 */

import type { RunCache } from "../run-cache.js";
import type { DisplaySink, NoteSink } from "../note-sink.js";
import type { EffectLog } from "../effect-log.js";
import type { ReadGuard } from "../read-guard.js";
import type { SourceLocation } from "../../errors.js";

/** Per-run allocation meter — the memory analogue of the wall-clock budget. The
 *  reference is fixed for the run; `used` is incremented in place as cells materialize. */
export interface HeapMeter {
  used: number;
  max: number;
}

/**
 * The per-run context. Minted once per `exec()` (see `makeRunContext`); carried
 * by every AValue built during the run (`AValue.ctx`), with ops reading run-state
 * off the operand (`operand.ctx.heapMeter`) or the threaded `runCtx` parameter
 * instead of a module holder.
 */
export interface RunContext {
  /** R7RS-strict nil-projection (`car`/`cdr` of nil throws) vs tolerant (yields nil). */
  readonly strict: boolean;
  /** Per-run allocation bound; `undefined` ⇒ unbounded (the default — only sandbox/agent runs opt in). */
  readonly heapMeter: HeapMeter | undefined;
  /** Freeze the borrowed JS source inside AJSObject/AJSArray the first time Scheme reads it, so a
   *  rosetta return (or any borrowed value) can't be mutated by the host afterward — prevention by
   *  construction, replacing the dev-only purity ASSERT. `false` opts out (host keeps it mutable). */
  readonly freezeRosettaReturns: boolean;
  /** The run's execution-budget signal, if any (see `EvalContext.signal` in evaluator.ts for the
   *  full war story — that's the trampoline's own copy, read at iteration boundaries). This is the
   *  SAME reference, stamped here at the same mint site, so every `runCtx` consumer (a callable
   *  body's `CallCtx.runCtx.signal`, not just the trampoline) can observe abort state — never
   *  independently re-derived, so the two can't drift out of sync. */
  readonly signal: AbortSignal | undefined;
  /** The run's cache (values/run-cache.ts — R2, arrival-mcp-rework-over-phases.md §2.2), if
   *  any; `undefined` ⇒ no interception (the default — only session/replay runs opt in). The
   *  baked rosetta `run` wrapper reads it HERE (`this.runCtx.cache`) — the same per-run
   *  hermetic seam `signal`/`heapMeter` ride — and gates record/replay per the stamped cache
   *  class. Constant for the run, like everything on this handle. */
  readonly cache: RunCache | undefined;
  /** The run's gathered-effect manifest (values/effect-log.ts — W1, arrival-plexus-
   *  effect-burst.md §2.3), if any; `undefined` ⇒ no burst arm (the default — a sink
   *  fires immediately, today's behavior). The baked rosetta `run` wrapper reads it
   *  HERE (`this.runCtx.effects`) — the same per-run hermetic seam `cache`/`signal`
   *  ride — and, for a `sink` penetration during a PRIME run (not a cache replay),
   *  enqueues instead of firing. Sibling of `cache`, not part of it: a burst run may
   *  carry both (an `effects` log alongside a `view`/`pure` cache) or `effects` alone
   *  (no cache at all). Constant for the run, like everything on this handle. */
  readonly effects: EffectLog | undefined;
  /** The run's read-tracking + deferral-guard seam (values/read-guard.ts — W2, arrival-
   *  plexus-effect-burst.md §2.4), if any; `undefined` ⇒ no tracking, no guard — byte-
   *  identical to today. When present, the eval loop wraps each top-level form's
   *  evaluation in `reads.tracker.region(...)` and, for a PRIME run gathering effects
   *  (mirroring the burst arm's own `cache?.mode !== "replay"` gate), checks
   *  `checkReadWriteGuard` after each form. Sibling of `cache`/`effects`, not a field on
   *  either: a run may track reads with no effect log at all (inert), gather effects
   *  with no tracker (no guard, no crash — an opt-out, not a lie), or carry both. */
  readonly reads: ReadGuard | undefined;
  /** The run's MODEL-FACING NOTE CHANNEL (values/note-sink.ts), if any; `undefined` ⇒ notes are
   *  dropped (the default — only a session run that RENDERS an observation opts in). Sibling of
   *  `cache`/`effects`/`reads`, riding the same per-run hermetic seam: a note belongs to the RUN,
   *  which is why the kwargs tolerance's old WeakMap (keyed on the decoded argument object) could
   *  never be drained by the renderer — the renderer never sees that object. */
  readonly notes: NoteSink | undefined;
  /** The run's DISPLAY channel (values/note-sink.ts) — where the MCP runner's `display` affordance
   *  records what a model asked to see. `undefined` ⇒ no display verb is bound (arrival itself has
   *  none, and never will: ports/IO are omitted by design). Sibling of `notes`, same per-run seam. */
  readonly display: DisplaySink | undefined;
  /** Origin discriminant. `"parse"` marks the parse-time family (`PARSE_CTX` /
   *  `makeParseCtx`): run-neutral like CONSTANT_CTX, but a STATED fact ("minted by the
   *  reader") instead of a fallback. Absent on live-run ctxs and CONSTANT_CTX. */
  readonly origin?: "parse";
  /** Source identity for parse-minted values — the `SourceLocation` the Parser computes
   *  for every datum. Present only on the parse family (`origin === "parse"`), and even
   *  there `undefined` for synthesized/location-less parse values (`PARSE_CTX`). This is
   *  the ctx channel of the span migration: `APair.setLocation` stays a derived MIRROR
   *  of this field during the migration (the Parser writes both), and leaf literals —
   *  which have no location slot at all — get source identity through here alone. */
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
 * runs), and everything constructed at bootstrap before a run exists. Immutable,
 * shared, bears no run-state (`strict=false`, no meter) — so it can never carry one
 * run's mode/meter into another run.
 */
export const CONSTANT_CTX: RunContext = Object.freeze({
  strict: false,
  heapMeter: undefined,
  freezeRosettaReturns: true,
  signal: undefined,
  // Run-NEUTRAL by definition: a note is addressed to the model watching ONE run, so a context that
  // outlives every run can have nowhere to put one. Notes minted under CONSTANT_CTX are dropped —
  // which is correct, not a gap: nobody is listening.
  notes: undefined,
  display: undefined,
  cache: undefined,
  effects: undefined,
  reads: undefined,
});

/**
 * The PARSE-ORIGIN context family — the third RunContext species (after live-run and
 * CONSTANT_CTX). Run-neutral by charter: parse happens BEFORE any run, so no meter, no
 * cache, no effects, no reads, no signal — a parse-minted value can never carry one
 * run's state into another (parsed AST is shared across runs by `evalQuote`). What it
 * ADDS over CONSTANT_CTX is provenance as a stated fact: `origin: "parse"` plus the
 * `SourceLocation` the Parser computes for every datum — which, for leaf literals
 * (symbols, strings, numbers, chars, vectors, bytevectors, dicts), is the FIRST source
 * identity they have ever carried (only APair has a location slot; see the consumer map
 * `docs/working-proposals/arrival-parse-ctx-consumer-map-2026-07-11.md`).
 *
 * Migration contract (staged — this wave): the ctx channel CARRIES the location;
 * `APair.setLocation` stays a derived MIRROR the Parser also writes, so every existing
 * `[LOCATION]`-slot reader (the evaluator tap gate, `scopeId`, the three cross-package
 * `Symbol.for("__location__")` readers) is untouched. The mirror dies in a later wave.
 *
 * Interning note: per-node ctxs mean parsed symbols no longer share CONSTANT_CTX's
 * flyweight intern table — each occurrence is its own instance (the accepted per-form
 * allocation cost; required, since per-occurrence source identity and a shared interned
 * instance are mutually exclusive). Sound because eq?/eqv?/equals compare `__name__`,
 * never reference (values/structural-equal.ts).
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

/** Narrowing read for the parse family — `ctxOf(v)` + this = "was v minted by the
 *  reader, and where" (the door-quality/error-reporting payoff: a door can point at
 *  the exact leaf via `ctx.location`). */
export function isParseCtx(ctx: RunContext): ctx is ParseContext {
  return ctx.origin === "parse";
}
