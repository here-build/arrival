/**
 * Region discipline for reverse-crossed callables (scheme→JS).
 *
 * A reverse lambda (a scheme callable handed to host JS — via `schemeToJs`'s
 * ACallable branch, or `z.procedure().decode`'s typed path) is region-bound to
 * the symbol invocation that exported it: the wrapper closes over a scope
 * token minted for THAT ONE call, and every rule below is enforced against
 * that token, never a global flag.
 *
 * ── Why an ambient holder ─────────────────────────────────────────────────
 * `z.procedure`'s `decode` is a plain zod-codec transform, `(callable) =>
 * wrapper` — zod's codec API gives it no side channel for "which invocation is
 * this a reverse crossing of". Rather than invent two different plumbing
 * conventions (an explicit parameter for `schemeToJs`, something ad hoc for
 * the codec), both paths read the SAME ambient "current region scope" —
 * mirroring the module-level holder pattern `eval/dynamic-call-site.ts` and
 * `eval/evaluator.ts`'s own run-env holder already use for the same reason:
 * single-threaded JS makes a module holder safe, and save/restore around the
 * owning call (`withRegionScope`) handles nesting. The wrapper CLOSES OVER
 * whatever scope is ambient at the moment it is minted — never re-reads the
 * holder later, so a wrapper invoked long after its minting call keeps
 * pointing at the SAME (by then closed) scope.
 *
 * ── What lives outside this file ─────────────────────────────────────────
 * Minting/opening a scope is the crossing seam's job (`rosetta.ts`'s
 * `createRosettaWrapper`, `scheme-zod.ts`'s `z.procedure`) — this module only
 * owns the token shape, the ambient holder, and the two educational doors.
 */

import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import {
  emitHostSchedule,
  emitTrackClose,
  emitTrackOpen,
  isEmissionEnabled,
} from "../../provenance/store/emit.js";
import { appendOrdinal, type OrdinalPath, type RecordId, type RegionEpoch, type RegionId, type TemplateHash } from "../../provenance/store/ids.js";
import type { ProvenanceStore } from "../../provenance/store/interfaces.js";
import type { HostScheduleTriple } from "../../provenance/store/records.js";
import { foldRegionStream, nextTrackOrdinal } from "../../provenance/store/fold.js";

/**
 * ── Region events + host-schedule ────────────────────────────────────────────────
 * This file's counters (`pending`, and `trackOrdinal` below) are exactly the "track
 * open/close" row's source of truth: a track (a wire whose expression is a
 * first-class lambda) is ONE re-entrant call, bracketed by `withRegionCall`'s
 * `pending++`/`pending--`. `noteTrackOpen`/`noteTrackClose` fire at those two
 * mutation points; both are flag-gated, detached (fire-and-forget, never awaited by
 * the real call), and no-op unless BOTH the emission flag is on AND a
 * `TrackCoordinate`/`TrackEmissionSink` pair was ambiently installed when the scope
 * was OPENED (captured once, into the scope, mirroring why `runCtx`/`dynSite` are
 * captured rather than re-read — see the file's original header) — the exact same
 * three-part no-op conjunction `eval/provenance-hooks.ts`'s hook uses, kept as an
 * INDEPENDENT ambient pair here (not a shared import) because pulling in
 * `eval/provenance-hooks.ts` from this leaf module would close a cycle
 * (`region-scope.ts` → `provenance-hooks.ts` → `rosetta.js` → `region-scope.ts`) —
 * exactly the class of layering violation this file's original header already
 * documents for `eval/evaluator.ts`.
 *
 * Host-schedule rides the SAME scope: an order-dependent selector host (sort's
 * comparator, the canonical `control`-callbackRole op — see `env/srfi/srfi-95.ts`) is
 * one exported symbol invocation, i.e. one `RegionScope`'s whole lifetime, so its
 * comparator verdicts accumulate on `scope.hostSchedule` via
 * `recordHostScheduleVerdict` and flush as ONE `HostScheduleRecord` at
 * `closeRegionScope` — "the sequence IS the record," never one record per triple.
 * NOTE (real-wiring gap): today's `deriveSortCompare` (`values/op-helpers.ts`)
 * invokes its comparator via `applyCallback` DIRECTLY under `CONSTANT_CTX` — it does
 * not go through `callableToHostFn`/`withRegionCall`, so no `RegionScope` is open
 * around a real sort's comparator calls yet, and `Array.prototype.sort`'s comparator
 * signature carries no element ordinals to attribute a triple to in the first place.
 * The machinery here (`recordHostScheduleVerdict`, the accumulator, the close-time
 * flush) is complete; the missing piece is `op-helpers.ts`-side — routing a real
 * host comparator loop through `withRegionCall` so a scope is open around it.
 */

/** This scope's designated-node coordinate for track-open/close/host-schedule
 *  emission — the SAME three-field address shape `eval/provenance-hooks.ts`'s
 *  `RecordCoordinate` uses, kept as an independent type here per the
 *  no-cross-import rule above. */
export interface TrackCoordinate {
  readonly templateHash: TemplateHash;
  readonly ordinalPath: OrdinalPath;
  readonly regionEpoch: RegionEpoch;
}

/** Where a `TrackCoordinate`'s events land — store + region only (no
 *  `PayloadStore`: track-open/track-close/host-schedule are all payload-free kinds). */
export interface TrackEmissionSink {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
}

/** Shared by every RegionScope that never had a run signal to derive from
 *  (e.g. a direct-JS caller with no ctx at all — the same "no ambient scope"
 *  fallback every reverse-membrane consumer degrades to). Never fires, so
 *  sharing one instance across every unscoped wrapper adds no listener cost. */
const NEVER_ABORTS: AbortSignal = new AbortController().signal;

/**
 * The invocation-scope token a reverse wrapper closes over. `open`/
 * `pending` are mutated in place by `withRegionCall`/`closeRegionScope` — the
 * SAME object every wrapper minted against this scope shares, so the escape
 * door and the incomplete-call door see one source of truth.
 */
export interface RegionScope {
  /** False once the exporting symbol invocation has returned — every call
   *  after that point is an escape (rule 1). */
  open: boolean;
  /** Count of reverse calls started but not yet settled. Read at close time
   *  (rule 2) and decremented as each call settles (rule 3). */
  pending: number;
  /** Derived from the run's abort signal (rule 4) — never an independently
   *  triggerable signal; there is no "cancel this one scope" knob. */
  readonly signal: AbortSignal;
  /** The enclosing symbol invocation's RunContext — reverse-entry args mint
   *  under THIS, never `CONSTANT_CTX`. */
  readonly runCtx: RunContext;
  /** The enclosing symbol invocation, opaque here (the tap owns its shape;
   *  see `eval/evaluator.ts`'s own `Invocation = unknown`). Threaded to
   *  `withDynamicCallSite` so a re-entry's trace nests under THIS invocation
   *  instead of the lambda's definition-time lexical one. */
  readonly dynSite: unknown;
  /** Per-(callable, scope) wrapper identity: the same callable exported
   *  twice through this SAME scope gets back the SAME JS function. A WeakMap
   *  keyed by the callable value itself, owned by the scope — a fresh scope
   *  starts with a fresh, empty cache, so two invocations of the same symbol
   *  each get their own wrapper (never `===` across scopes).
   *
   *  Deliberately a plain `WeakMap`, not `DefaultedWeakMap` (@here.build/collections):
   *  TWO independent call sites build wrappers over this SAME cache with DIFFERENT
   *  factories — rosetta.ts's `callableToHostFn` (the untyped passthrough) and
   *  scheme-zod.ts's `z.procedure` decode (the typed `input`/`output`-marshaling
   *  wrapper). `DefaultedWeakMap` binds ONE factory at construction; forcing this
   *  cache into it would make whichever caller reaches an unset key FIRST silently
   *  win for the OTHER caller too (losing the typed marshaling, or vice versa) — a
   *  real behavior change, not a get-check-set collapse. The manual get-check-set
   *  idiom stays because the "value recipe" is genuinely per-call-site here, not
   *  derivable from the key alone. */
  readonly cache: WeakMap<object, (...args: unknown[]) => unknown>;

  /** This scope's `TrackCoordinate`, captured AMBIENTLY at `openRegionScope`
   *  time (mirrors `runCtx`/`dynSite`: closed over once, never re-read) —
   *  `undefined` for every scope minted outside `withTrackCoordinate`'s install
   *  window (today's entire production call graph). */
  readonly trackCoordinate: TrackCoordinate | undefined;
  /** Paired sink for `trackCoordinate`'s emissions — `undefined` exactly when
   *  `trackCoordinate` is. */
  readonly trackSink: TrackEmissionSink | undefined;
  /** One of this scope's counters, alongside `pending` — the NEXT ordinal ANY track
   *  event (open OR close, of any re-entrant call) minted under THIS scope will
   *  claim; see `mintTrackId`'s doc for why open and close each claim their OWN fresh
   *  ordinal rather than sharing one. Mutated in place (like `pending`), never reset
   *  mid-scope: two events must not collide on `RecordId` ("nested fans collide
   *  otherwise," the identical principle applied here). */
  trackOrdinal: number;
  /** Accumulated `(left, right, verdict)` triples for an order-dependent selector
   *  host's comparator schedule running under this scope — see
   *  `recordHostScheduleVerdict`. Flushed as ONE `HostScheduleRecord` at
   *  `closeRegionScope`, then drained (never double-flushed). */
  readonly hostSchedule: HostScheduleTriple[];
}

/**
 * Shared, permanently-open fallback scope for a reverse-membrane wrapper minted
 * OUTSIDE any real crossing — no `createRosettaWrapper`/`z.procedure` call is
 * live around it (a trace/display projection, e.g. `provenance/uneval.ts`
 * reaching `schemeToJs` directly, or a unit test calling `z.procedure(...)
 * .parse(...)` with no ambient scope set up). No symbol invocation exported the
 * resulting wrapper, so there is nothing to close and no escape/incomplete rule
 * to enforce — region.law's rows are about a REAL crossing; this is the
 * documented "no discipline" degradation for everything else, shared by both
 * consumers (`rosetta.ts`'s `schemeToJs`, `scheme-zod.ts`'s `z.procedure`) so
 * a callable crossing through either path outside a tracked invocation still
 * gets ONE (never-closing) identity cache instead of two independent ones.
 */
export const DETACHED_SCOPE: RegionScope = {
  open: true,
  pending: 0,
  signal: NEVER_ABORTS,
  runCtx: CONSTANT_CTX,
  dynSite: undefined,
  cache: new WeakMap(),
  // A detached scope was never minted under `withTrackCoordinate` — no
  // coordinate/sink means `noteTrackOpen`/`noteTrackClose`/`recordHostScheduleVerdict`
  // no-op unconditionally for every wrapper sharing this singleton.
  trackCoordinate: undefined,
  trackSink: undefined,
  trackOrdinal: 0,
  hostSchedule: [],
};

/** Mint a fresh, open scope for one symbol invocation. `parentSignal` is the
 *  enclosing RunContext's signal (`undefined` for a run with no budget/abort
 *  wiring, e.g. `CONSTANT_CTX`) — derived via `AbortSignal.any`, a genuine
 *  child signal, not the parent's own reference, so this scope's listener is
 *  independently disposed when the scope is GC'd rather than outliving it
 *  pinned to the run's controller. */
export function openRegionScope(opts: { runCtx: RunContext; dynSite: unknown }): RegionScope {
  const parentSignal = opts.runCtx.signal;
  return {
    open: true,
    pending: 0,
    signal: parentSignal === undefined ? NEVER_ABORTS : AbortSignal.any([parentSignal]),
    runCtx: opts.runCtx,
    dynSite: opts.dynSite,
    cache: new WeakMap(),
    // Captured NOW, from whatever `withTrackCoordinate` installed ambiently —
    // never re-read later (same rationale as runCtx/dynSite above).
    trackCoordinate: _trackCoordinate,
    trackSink: _trackSink,
    trackOrdinal: 0,
    hostSchedule: [],
  };
}

/**
 * The recovery half of `openRegionScope`: mint a scope for a track coordinate that
 * ALREADY HAS a durable history (a DO wake after eviction/hibernation), rather than
 * a brand-new one. `openRegionScope` always starts `pending: 0, trackOrdinal: 0`
 * because a fresh scope has no history; a RESUMED scope must not make that
 * assumption — reusing those zeros would (a) let `closeRegionScope` report
 * `pending: 0` even when the durable stream shows a `track-open` with no matching
 * `track-close` (a genuine crash — the in-flight call's promise is gone forever with
 * the evicted JS heap, so there is nothing left TO settle; the incomplete door is
 * the correct, honest answer, not a silent "0 pending"), and (b) re-mint
 * `track-open`/`track-close` ids starting at ordinal 0 again, COLLIDING (id-only
 * upsert) with ones already durable from before the eviction.
 *
 * Both numbers come from ONE fold over ONE `readStream` call — `foldRegionStream`
 * ("the SAME fold reconstructs region state on DO wake") for `pending`,
 * `nextTrackOrdinal` (scoped to `coordinate`, the same collision concern) for
 * `trackOrdinal`. Everything else is fresh, exactly like
 * `openRegionScope`: a resumed scope has no live wrapper cache or accumulated
 * host-schedule triples to recover (a WeakMap of JS closures and an in-flight
 * comparator run are not stream-derivable facts — see `fold.ts`'s own doc).
 *
 * Unlike `openRegionScope`, `coordinate`/`sink` are explicit parameters, not read
 * from the `withTrackCoordinate` ambient install — recovery is a distinct code path
 * (triggered by the DO runtime waking a hibernated object), not a normal mint at a
 * live crossing seam, so there is no ambient window to read from at that point.
 */
export async function reconstructRegionScope(opts: {
  runCtx: RunContext;
  dynSite: unknown;
  coordinate: TrackCoordinate;
  sink: TrackEmissionSink;
}): Promise<RegionScope> {
  const { runCtx, dynSite, coordinate, sink } = opts;
  const records = await sink.store.readStream(sink.regionId);
  const fold = foldRegionStream(records);
  const parentSignal = runCtx.signal;
  return {
    open: true,
    // Recovered: a crash that left a track-open with no matching
    // track-close survives the fold as `pending > 0` — closing this scope without
    // first resolving that (impossible; the original call is gone) correctly
    // throws the incomplete door, never silently reports a clean close.
    pending: fold.pending,
    signal: parentSignal === undefined ? NEVER_ABORTS : AbortSignal.any([parentSignal]),
    runCtx,
    dynSite,
    cache: new WeakMap(),
    trackCoordinate: coordinate,
    trackSink: sink,
    // Seeded past every ordinal this coordinate already used, so the next
    // track event this resumed scope mints cannot collide with a durable one.
    trackOrdinal: nextTrackOrdinal(records, coordinate),
    hostSchedule: [],
  };
}

/** Rule 1's door (errors-as-doors: names the mechanism, then the fix). */
function regionEscapeDoor(): Error {
  return new Error(
    "reverse lambda escaped its invocation — callbacks are region-bound to the calling symbol; " +
      "a wrapper handed to host JS may only be invoked WHILE the symbol call that exported it is " +
      "still running. Persistent handlers (a subscription kept past the call's return) need an " +
      "explicit capability granting a DETACHED scope — this is not that, by default.",
  );
}

/** Rule 2's door. */
function regionIncompleteDoor(pending: number): Error {
  return new Error(
    `symbol returned with ${pending} reverse-lambda call${pending === 1 ? "" : "s"} incomplete — ` +
      "every reverse-lambda call started during a symbol invocation must settle (resolve or reject) " +
      "before that symbol returns. Await each re-entry, or use a persistent-handler capability for " +
      "fire-and-forget work instead of leaving a call in flight.",
  );
}

/**
 * Close `scope` — called once, when the exporting symbol invocation settles
 * (rule 2). Flips `open` false FIRST (so a call that starts racing the close
 * still sees the door), then throws if any call is still in flight. Throwing
 * here (inside the crossing seam's `finally`) supersedes a normal return —
 * the settling symbol's own result is discarded in favor of the teaching
 * error, which is the point: an incomplete re-entry is a caller bug, not a
 * warning.
 */
export function closeRegionScope(scope: RegionScope): void {
  scope.open = false;
  // Flush BEFORE the incomplete-door throw — a host-schedule this scope DID
  // complete is independent of whether some OTHER reverse call is still pending;
  // losing a completed schedule to an unrelated door would under-report ("under-
  // reporting forbidden" spirit, applied to the host-schedule record).
  flushHostSchedule(scope);
  if (scope.pending > 0) throw regionIncompleteDoor(scope.pending);
}

/**
 * Run one reverse-lambda call under `scope`'s discipline (rules 1/3/4): door
 * if the scope already closed, else track `pending` for the call's lifetime
 * and race it against the scope's abort signal. `fn` is the actual re-entry
 * (jsToScheme the args → applyCallback → schemeToJs the result) — this
 * wrapper owns only the bookkeeping around it, never the marshaling.
 *
 * `pending++`/`pending--` are exactly this file's track-open/track-close counter
 * mutations (see the file header) — `noteTrackOpen`/`noteTrackClose` fire right
 * alongside them, detached, never perturbing the real call's timing or outcome.
 */
export async function withRegionCall<T>(scope: RegionScope, fn: () => Promise<T> | T): Promise<T> {
  if (!scope.open) throw regionEscapeDoor();
  scope.pending++;
  noteTrackOpen(scope);
  try {
    return await raceRegionAbort(Promise.resolve().then(fn), scope.signal);
  } finally {
    scope.pending--;
    noteTrackClose(scope);
  }
}

// ── Track-open/track-close/host-schedule emission ───────────────────────────────────
// See the file header block above for the full design rationale (why an independent
// ambient pair, why the scope is host-schedule's natural accumulation container).

/** The ambient "current track coordinate/sink" — installed by
 *  {@link withTrackCoordinate}, read (and captured into the scope, never re-read
 *  after) by {@link openRegionScope}. `undefined` for every scope minted outside an
 *  install window — today's entire production call graph, mirroring
 *  `RecordCoordinate`'s own "nothing wires this yet" state. */
let _trackCoordinate: TrackCoordinate | undefined;
let _trackSink: TrackEmissionSink | undefined;

/** Install a `TrackCoordinate`/`TrackEmissionSink` pair for the duration of a
 *  SYNCHRONOUS `fn` — save/restore, the same idiom {@link withRegionScope} uses.
 *  `openRegionScope` is itself always synchronous at every real call site (`rosetta.ts`'s
 *  `createRosettaWrapper` calls it before its first `await`), so a sync-only installer
 *  is sufficient — there is no async sibling to this function, unlike
 *  `eval/provenance-hooks.ts`'s `withRecordCoordinateAsync`. */
export function withTrackCoordinate<T>(coordinate: TrackCoordinate, sink: TrackEmissionSink, fn: () => T): T {
  const savedCoordinate = _trackCoordinate;
  const savedSink = _trackSink;
  _trackCoordinate = coordinate;
  _trackSink = sink;
  try {
    return fn();
  } finally {
    _trackCoordinate = savedCoordinate;
    _trackSink = savedSink;
  }
}

// ── Silent-region mode ────────────────────────────────────────────────────────────────
//
// "γ runs in a SILENT region: doors and discipline fully active, stream emission OFF."
// (Glass whole-program replay is ALSO a silent region.) A silent region suppresses ALL
// emission for its ENTIRE dynamic extent — every `note*`/`flush*` call site below,
// PLUS `eval/provenance-hooks.ts`'s `notePotentialRosettaExit` (mints) — while this
// file's doors (`regionEscapeDoor`, `regionIncompleteDoor`) stay fully active: they
// read `scope.open`/`scope.pending`,
// which `withRegionCall`/`closeRegionScope` still mutate exactly as before. Silence is
// an EMISSION concern, never a discipline concern — this file adds a suppression path,
// it does not touch a single door.
//
// DELIBERATELY a SEPARATE ambient from `_trackCoordinate`/`_trackSink` (never a field
// folded onto `TrackCoordinate`/`RecordCoordinate`, and never carried on `RegionScope`
// itself): a coordinate is a per-PORT address that gets SWAPPED by a nested
// `withTrackCoordinate`/`withRecordCoordinateAsync` install — γ replaying a nested wire, or
// any drill-in that installs its own coordinate deep inside a silent region's dynamic
// extent. If silence rode ON the coordinate, that swap would silently DROP it, and a
// mint minted under the nested coordinate could emit again the instant inner code
// installs its own. `_silentRegion` is instead a save/restore ambient that NO
// coordinate install anywhere ever touches, so a fresh coordinate minted deep inside
// `withSilentRegion`'s dynamic extent is STILL checked against the outer silence:
// leak-proof by construction (an orthogonal ambient nothing else can clear), not by
// caller discipline.
//
// There is deliberately NO "un-silence" primitive. The only way `_silentRegion` ever
// drops back to its prior value is the `withSilentRegion` call that raised it
// RETURNING (or its promise SETTLING) — so a nested LOUD region opened inside a silent
// one (no code path here ever sets `_silentRegion = false` on its own initiative) stays
// silent for its whole life: silence dominates a nested loud region exactly because
// nothing can clear it from inside.
//
// Read directly by `eval/provenance-hooks.ts` (imported from there, not duplicated) —
// safe in that direction: `provenance-hooks.ts` already transitively depends on this
// module today (`provenance-hooks.ts` → `rosetta.js` → `region-scope.ts`), so a direct
// import adds no new edge to the graph, let alone a cycle (the cycle this file's header
// warns about is the REVERSE edge, `region-scope.ts` → `provenance-hooks.ts`, which
// this section still does not add).
let _silentRegion = false;

/** Is emission currently suppressed by an enclosing silent region? Checked by every
 *  `note*`/`flush*` call site below AND by `eval/provenance-hooks.ts`'s
 *  `notePotentialRosettaExit` (mints) — the SAME conjunction `isEmissionEnabled()`
 *  already established: a single boolean read, checked early, before any other work. */
export function isSilentRegion(): boolean {
  return _silentRegion;
}

/** Run `fn` with silence raised for its ENTIRE dynamic extent — every emission call
 *  site this scope's discipline reaches (track open/close, host-schedule, and,
 *  transitively through `eval/provenance-hooks.ts`, mints) no-ops for the duration;
 *  doors (escape/incomplete) are completely unaffected, since they never read this
 *  ambient. Async-SETTLE restore (mirrors `withRecordCoordinateAsync`, not the
 *  sync-only `withTrackCoordinate`): γ's whole multi-tick replay run must stay silent
 *  until it actually finishes, not just until it first returns a pending Promise.
 *  Nests correctly with NO special-casing: a `withSilentRegion` called while already
 *  silent (silent-in-silent, or the "loud-in-silent" case where nothing ever clears
 *  the ambient in between) saves `true` and restores `true` — the outer region's
 *  silence is never prematurely lifted by an inner one finishing first. */
export async function withSilentRegion<T>(fn: () => Promise<T>): Promise<T> {
  const saved = _silentRegion;
  _silentRegion = true;
  try {
    return await fn();
  } finally {
    _silentRegion = saved;
  }
}

/** One track event's `RecordId` — claims a FRESH trailing ordinal from
 *  `scope.trackOrdinal` every call (never reused across open/close, and never across
 *  two different tracks). Collision-freedom matters structurally, not just for tidy
 *  ids: `ProvenanceStore`'s upsert contract (`fakes.ts`'s `append`) dedupes on
 *  `recordIdKey(id)` ALONE — it does not fold `kind` into the key — so an open and a
 *  close sharing one id would silently collapse into ONE record (the close's write
 *  clobbering the open's) instead of two. Correlating a track's open with its close is
 *  therefore by STREAM ORDER (open's `seq` always precedes its close's) —
 *  "completed ≤ started, monotone" is a COUNT invariant over the ordered stream,
 *  never an id-matched pairing. */
function mintTrackId(scope: RegionScope, coordinate: TrackCoordinate): RecordId {
  return {
    templateHash: coordinate.templateHash,
    ordinalPath: appendOrdinal(coordinate.ordinalPath, scope.trackOrdinal++),
    regionEpoch: coordinate.regionEpoch,
  };
}

/** Fires at `withRegionCall`'s `pending++` (a track STARTING). No-ops (checked FIRST,
 *  before any other work — the sunset-byte-identical contract) unless the emission
 *  flag is on AND `scope` was minted with a coordinate/sink installed. */
function noteTrackOpen(scope: RegionScope): void {
  if (!isEmissionEnabled()) return;
  if (isSilentRegion()) return; // silent region — doors stay active, emission doesn't
  const { trackCoordinate: coordinate, trackSink: sink } = scope;
  if (coordinate === undefined || sink === undefined) return;
  const id = mintTrackId(scope, coordinate);
  // Detached — never awaits, never perturbs the real call (mirrors
  // `eval/provenance-hooks.ts`'s `notePotentialRosettaExit`).
  void emitTrackOpen({ store: sink.store, regionId: sink.regionId, id }).catch(() => {});
}

/** Fires at `withRegionCall`'s `pending--` (a track SETTLING — resolve or reject,
 *  `finally` runs either way, so production always reaches here with `settled: true`;
 *  see `emitTrackClose`'s own doc). Mints its OWN fresh id (see `mintTrackId`'s doc for
 *  why it must not reuse the open's) — no-ops under the same flag/coordinate/sink
 *  conjunction as `noteTrackOpen`. */
function noteTrackClose(scope: RegionScope): void {
  if (!isEmissionEnabled()) return;
  if (isSilentRegion()) return; // silent region — doors stay active, emission doesn't
  const { trackCoordinate: coordinate, trackSink: sink } = scope;
  if (coordinate === undefined || sink === undefined) return;
  const id = mintTrackId(scope, coordinate);
  void emitTrackClose({ store: sink.store, regionId: sink.regionId, id, settled: true }).catch(() => {});
}

/** Record one order-dependent selector host's comparator verdict —
 *  appends ONLY, onto `scope.hostSchedule`; the actual `HostScheduleRecord` emission
 *  happens once, at `closeRegionScope` (`flushHostSchedule` below), never per call
 *  here — "the sequence IS the record." `left`/`right` are the compared
 *  elements' own `RecordId["ordinalPath"]`s (whatever the caller can attribute them
 *  to); `verdict` is the raw comparator result (negative/zero/positive). A caller with
 *  no live scope (or emission off) gets a harmless no-op — this function never throws
 *  and never allocates when the flag is off (checked first). */
export function recordHostScheduleVerdict(
  scope: RegionScope,
  left: OrdinalPath,
  right: OrdinalPath,
  verdict: number,
): void {
  if (!isEmissionEnabled()) return;
  if (isSilentRegion()) return; // never accumulate under silence — nothing to flush later either
  if (scope.trackCoordinate === undefined || scope.trackSink === undefined) return;
  scope.hostSchedule.push({ left, right, verdict });
}

/** Emit `scope`'s ENTIRE accumulated comparator schedule as ONE
 *  `HostScheduleRecord`, keyed at the scope's OWN coordinate (the host invocation's
 *  own address — never a per-track ordinal; the schedule belongs to the host call as
 *  a whole, not to any one comparator invocation). Drains `hostSchedule` first
 *  (`splice(0)`) so a scope that somehow closes twice — or any future retry path —
 *  never double-flushes the same triples. Zero triples ⇒ `emitHostSchedule` itself
 *  no-ops (never an empty record on the wire). */
function flushHostSchedule(scope: RegionScope): void {
  if (!isEmissionEnabled()) return;
  if (isSilentRegion()) return; // silent region — doors stay active, emission doesn't
  if (scope.hostSchedule.length === 0) return;
  const { trackCoordinate: coordinate, trackSink: sink } = scope;
  if (coordinate === undefined || sink === undefined) return;
  const triples: HostScheduleTriple[] = scope.hostSchedule.splice(0);
  const id: RecordId = {
    templateHash: coordinate.templateHash,
    ordinalPath: coordinate.ordinalPath,
    regionEpoch: coordinate.regionEpoch,
  };
  void emitHostSchedule({ store: sink.store, regionId: sink.regionId, id, triples }).catch(() => {});
}

/**
 * Reject `value` the moment `signal` aborts, without waiting for `value`
 * itself to settle — the in-flight-cancellation half of rule 4. Deliberately
 * NOT imported from `eval/evaluator.ts`'s `raceAbort` (byte-identical logic):
 * this leaf module is reached from `rosetta.ts`/`scheme-zod.ts`, which sit
 * BELOW the evaluator in the dependency order (host-agnostic FFI leaves —
 * see `docs/reference/arrival-graal-guest-not-host-dsl.md`); pulling in the
 * ~3300-line evaluator module for one Promise/AbortSignal helper would be a
 * real layering violation for a 15-line utility. The abandoned promise's
 * eventual settlement is swallowed so it never surfaces as an unhandled
 * rejection, mirroring `raceAbort`'s own contract.
 */
function raceRegionAbort<T>(value: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void Promise.resolve(value).catch(() => {});
    return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// ── Ambient "current region scope" ──────────────────────────────────────────
// See the file header for why this is ambient rather than threaded through
// `RosettaOptions`: `z.procedure`'s codec transform has no parameter for it.
// Single-threaded JS + save/restore around the owning call makes the holder
// safe, exactly like evaluator.ts's `_dynamicCallSite`.
let _currentRegionScope: RegionScope | undefined = undefined;

/** The scope a reverse wrapper should close over if minted RIGHT NOW —
 *  `undefined` outside any tracked crossing (e.g. `z.procedure().parse(...)`
 *  called directly in a unit test, or `schemeToJs` reached from a trace/
 *  display path that never opened a scope). Callers must treat `undefined`
 *  as "no region discipline for this wrapper" (an always-open, uncached,
 *  never-region-bound passthrough) — never as an error. */
export function currentRegionScope(): RegionScope | undefined {
  return _currentRegionScope;
}

/** Install `scope` as ambient for the duration of `fn` (sync only — every
 *  real caller mints wrappers synchronously; the crossing's own async work
 *  happens outside this window, see `createRosettaWrapper`). */
export function withRegionScope<T>(scope: RegionScope, fn: () => T): T {
  const saved = _currentRegionScope;
  _currentRegionScope = scope;
  try {
    return fn();
  } finally {
    _currentRegionScope = saved;
  }
}
