/**
 * Region discipline for reverse-crossed callables (scheme→JS).
 *
 * A reverse lambda (scheme callable handed to host JS — `toJS`'s ACallable
 * branch, or `z.procedure().decode`) is region-bound to the symbol invocation that
 * exported it: the wrapper closes over a scope token minted for THAT ONE call, and
 * every rule below is enforced against that token, never a global flag.
 * Full map: `docs/membrane.md` §REGION.
 *
 * CURRENT SCOPE (P19): `z.procedure`'s `decode` is a plain zod-codec transform with no side
 * channel for "which invocation is this reverse crossing of". Both `toJS` and the codec read
 * the SAME current region scope — the `regionScope` slot of the crossing run's own
 * `RunContext.ambient` (call-depth holder, `run/RunContext.ts`), installed by `withRegionScope`
 * together with the `currentRun()` pointer for the SYNC window in which wrappers are minted.
 * No module-level holder: concurrent runs hold different RunContexts, so their scopes cannot
 * cross. The wrapper CLOSES OVER whatever scope is current at mint — never re-reads the
 * holder later, so a late call still sees the SAME (by then closed) scope.
 *
 * Minting/opening a scope is the crossing seam's job (baked `symbol.rosetta` run,
 * scheme-zod `z.procedure`). This module owns the token shape, the window, and doors.
 *
 * TRACK + HOST-SCHEDULE: counters (`pending`, `trackOrdinal`) are the track open/close
 * source of truth — a track is ONE re-entrant call, bracketed by `withRegionCall`'s
 * pending++/--. `noteTrackOpen`/`noteTrackClose` fire at those points; both are
 * detached and no-op unless the scope's run carries `RunContext.emission` (captured once at
 * OPEN — same reason runCtx/dynSite are captured) and is not `silent`.
 *
 * Host-schedule rides the same scope: an order-dependent selector host (sort comparator
 * — env/srfi/srfi-95.ts) is one exported symbol invocation; comparator verdicts
 * accumulate on `scope.hostSchedule` and flush as ONE HostScheduleRecord at
 * closeRegionScope — "the sequence IS the record." deferred: `deriveSortCompare`
 * (values/op-helpers.ts) still invokes comparators via applyCallback under CONSTANT_CTX
 * without withRegionCall, so no RegionScope is open around a real sort's comparator yet;
 * Array.prototype.sort also carries no element ordinals. Machinery here is complete;
 * missing piece is op-helpers routing through withRegionCall.
 */

import { CONSTANT_CTX, withAmbient, type RunContext } from "../run/RunContext.js";
import { currentRun, withCurrentRun } from "../run/current-run.js";
import type { AValue } from "../values/primitives/AValue.js";
import type { EgressMode, WrapperKey } from "../values/types.js";
import { RegionEscapeError, RegionIncompleteError } from "../errors.js";
import { claimInstanceOrdinal, emitHostSchedule, emitTrackClose, emitTrackOpen } from "../provenance/store/emit.js";
import {
  appendOrdinal,
  type OrdinalPath,
  type RecordId,
  type RegionEpoch,
  type RegionId,
  type TemplateHash,
} from "../provenance/store/ids.js";
import type { ProvenanceStore } from "../provenance/store/interfaces.js";
import type { HostScheduleTriple } from "../provenance/store/records.js";
import { foldRegionStream, nextTrackOrdinal } from "../provenance/store/fold.js";

/** Designated-node coordinate for track-open/close/host-schedule emission — same
 *  three-field address shape as eval/provenance-hooks RecordCoordinate; independent
 *  type here per the no-cross-import rule (preamble). */
export interface TrackCoordinate {
  readonly templateHash: TemplateHash;
  readonly ordinalPath: OrdinalPath;
  readonly regionEpoch: RegionEpoch;
}

/** Where a TrackCoordinate's events land — store + region only (payload-free kinds). */
export interface TrackEmissionSink {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
}

/** Shared by every RegionScope that never had a run signal (direct-JS caller with no
 *  ctx). Never fires — one instance across every unscoped wrapper, no listener cost. */
let _neverAborts: AbortSignal | undefined;
/** Lazy: `new AbortController()` is disallowed at workerd global (module-init) scope. */
function neverAborts(): AbortSignal {
  return (_neverAborts ??= new AbortController().signal);
}

/**
 * Invocation-scope token a reverse wrapper closes over. `open`/`pending` are mutated
 * in place by withRegionCall/closeRegionScope — the SAME object every wrapper minted
 * against this scope shares, so escape and incomplete doors see one source of truth.
 */
export interface RegionScope {
  /** False once the exporting symbol invocation has returned — later calls are escapes. */
  open: boolean;
  /** Reverse calls started but not yet settled. Read at close; decremented as each settles. */
  pending: number;
  /** True only for {@link detachedScope} — no real crossing owns it. */
  readonly detached?: true;
  /** Derived from the run's abort signal — never independently triggerable. */
  readonly signal: AbortSignal;
  /** Enclosing symbol invocation's RunContext — reverse-entry args mint under THIS. */
  readonly runCtx: RunContext;
  /** Enclosing symbol invocation, opaque (tap owns shape). Threaded to withDynamicCallSite
   *  so re-entry nests under THIS invocation, not the lambda's definition-time lexical one. */
  readonly dynSite: unknown;
  /**
   * Per-(callable, scope, FAMILY) wrapper identity: same callable exported twice through
   * this SAME scope UNDER THE SAME FAMILY → same JS function. Fresh scope → empty cache
   * (never `===` across scopes).
   *
   * TWO-LEVEL, keyed by WrapperKey: rosetta's callableToHostFn (untyped, keyed by
   * EgressMode) and scheme-zod's z.procedure decode (typed, keyed `"typed"`) share this
   * cache with DIFFERENT factories. A single-keyed map collides first-caller-wins across
   * families — same defect class as the (box, mode, scope) container-proxy law, one level
   * down. Explicit non-goal: schema collision WITHIN `"typed"` stays.
   */
  readonly cache: WeakMap<object, Map<WrapperKey, (...args: unknown[]) => unknown>>;

  /**
   * Per-(box, mode, scope) MEMBRANE egress-proxy identity — container twin of `cache`
   * (egress-proxy via MembraneExit.cache; rosetta egressAValue hands it from pinned scope).
   * Scope-owned so proxies don't outlive the scope (closed-scope wrapper resurrection) or
   * leak DETACHED-pinned materialization into live crossings. Bare (serialization) proxies
   * keep the module-level box-forever map in egress-proxy.ts.
   */
  readonly egressProxies: WeakMap<AValue, Map<EgressMode, object>>;

  /** TrackCoordinate taken from `runCtx.emission` at openRegionScope — undefined when
   *  the scope's run carries no `emission`. Captured once at open, never re-read. */
  readonly trackCoordinate: TrackCoordinate | undefined;
  /** Paired sink — undefined exactly when trackCoordinate is. */
  readonly trackSink: TrackEmissionSink | undefined;
  /** Next ordinal ANY track event under THIS scope will claim. Open and close each claim
   *  a FRESH ordinal (see mintTrackId). Mutated in place, never reset mid-scope. */
  trackOrdinal: number;
  /** Accumulated (left, right, verdict) triples — flush as ONE HostScheduleRecord at close. */
  readonly hostSchedule: HostScheduleTriple[];
}

/** Identity caches shared by every detached scope — KEYED RESIDENCY (P19): WeakMaps keyed by
 *  the callable / container box itself, so lifetime = the key's and nothing is attributed to a
 *  run (detached wrappers close over `CONSTANT_CTX`). Sharing them keeps `toJS(x) === toJS(x)`
 *  outside any crossing while every MUTABLE scope field (`pending`, `open`, the track and
 *  host-schedule counters) stays per-use. */
const detachedWrapperCache: RegionScope["cache"] = new WeakMap();
const detachedEgressProxies: RegionScope["egressProxies"] = new WeakMap();

/**
 * Permanently-open fallback for a reverse-membrane wrapper minted OUTSIDE any real
 * crossing (trace/display, unit tests without a current scope). Nothing to close; no
 * escape/incomplete rule. FRESH per use (P19: a shared mutable scope — `pending`,
 * `hostSchedule` — would be global state); only the key-owned identity caches are shared
 * (see above). A caller that must mint several wrappers under one detached scope (egress of
 * a container) pins ONE and threads it (`MembraneExit.scope`).
 */
export function detachedScope(): RegionScope {
  return {
    open: true,
    pending: 0,
    detached: true,
    // Lazy getter: neverAborts() constructs AbortController on first read (workerd).
    get signal(): AbortSignal {
      return neverAborts();
    },
    runCtx: CONSTANT_CTX,
    dynSite: undefined,
    cache: detachedWrapperCache,
    egressProxies: detachedEgressProxies,
    // CONSTANT_CTX carries no emission → note*/recordHostScheduleVerdict no-op unconditionally.
    trackCoordinate: undefined,
    trackSink: undefined,
    trackOrdinal: 0,
    hostSchedule: [],
  };
}

/** Mint a fresh open scope for one symbol invocation. parentSignal from RunContext
 *  (undefined for CONSTANT_CTX) — derived via AbortSignal.any so this scope's listener
 *  is independently disposed when GC'd rather than pinned to the run's controller. */
export function openRegionScope(opts: { runCtx: RunContext; dynSite: unknown }): RegionScope {
  const parentSignal = opts.runCtx.signal;
  return {
    open: true,
    pending: 0,
    signal: parentSignal === undefined ? neverAborts() : AbortSignal.any([parentSignal]),
    runCtx: opts.runCtx,
    dynSite: opts.dynSite,
    cache: new WeakMap(),
    egressProxies: new WeakMap(),
    // Captured NOW from the run's emission target — never re-read (same as runCtx/dynSite).
    trackCoordinate: opts.runCtx.emission?.coordinate,
    trackSink: opts.runCtx.emission,
    trackOrdinal: 0,
    hostSchedule: [],
  };
}

/**
 * Recovery half of openRegionScope: mint a scope for a track coordinate that ALREADY
 * has durable history (DO wake after eviction/hibernation). openRegionScope always
 * starts pending:0, trackOrdinal:0; a RESUMED scope must not:
 *   (a) report pending:0 when the durable stream shows track-open with no matching
 *       track-close (crash — in-flight promise gone with the heap; incomplete door is
 *       the honest answer), or
 *   (b) re-mint track ids from ordinal 0, COLLIDING with durable ones (id-only upsert).
 *
 * Both numbers from ONE fold over ONE readStream — foldRegionStream for pending,
 * nextTrackOrdinal for trackOrdinal. Everything else fresh (WeakMap of closures and
 * in-flight comparator triples are not stream-derivable — fold.ts).
 *
 * coordinate/sink are explicit parameters, not read off `runCtx.emission` — recovery is a
 * DO wake path that names the durable coordinate it is resuming.
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
    // Crash that left track-open without track-close → pending > 0; close throws incomplete.
    pending: fold.pending,
    signal: parentSignal === undefined ? neverAborts() : AbortSignal.any([parentSignal]),
    runCtx,
    dynSite,
    cache: new WeakMap(),
    egressProxies: new WeakMap(),
    trackCoordinate: coordinate,
    trackSink: sink,
    // Seeded past every ordinal this coordinate already used.
    trackOrdinal: nextTrackOrdinal(records, coordinate),
    hostSchedule: [],
  };
}

/** Rule 1's door (errors-as-doors: names the mechanism, then the fix). */
function regionEscapeDoor(): Error {
  return new RegionEscapeError();
}

/** Rule 2's door. */
function regionIncompleteDoor(pending: number): Error {
  return new RegionIncompleteError(pending);
}

/**
 * Close scope when the exporting symbol invocation settles. Flips open false FIRST
 * (racing call still sees the door), then throws if any call is still in flight.
 * Throw inside the seam's finally supersedes a normal return — incomplete re-entry
 * is a caller bug, not a warning.
 */
export function closeRegionScope(scope: RegionScope): void {
  scope.open = false;
  // Flush BEFORE incomplete-door throw — a completed host-schedule is independent of
  // whether some OTHER reverse call is still pending.
  flushHostSchedule(scope);
  if (scope.pending > 0) throw regionIncompleteDoor(scope.pending);
}

/**
 * One reverse-lambda call under scope discipline (rules 1/3/4): door if closed, else
 * track pending for the call's lifetime and race against the abort signal. `fn` owns
 * marshaling; this wrapper owns only bookkeeping. noteTrackOpen/Close fire detached
 * alongside pending++/--.
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

// ── Silent mode ──
//
// SILENT RUN: doors and discipline fully active, stream emission OFF (γ whole-program
// replay runs on a hermetic RunContext minted `silent: true`). `RunContext.silent` suppresses
// every note*/flush* site below PLUS provenance-hooks notePotentialRosettaExit (mints);
// escape/incomplete doors stay active (they read scope.open/pending, still mutated). Silence
// is an EMISSION concern, never a discipline concern. It is a flag on the run, read as
// `scope.runCtx.silent` — a concurrent loud run on the same isolate never sees it.

/** One track event's RecordId — claims a FRESH trailing ordinal every call. Collision-
 *  freedom is structural: ProvenanceStore upsert dedupes on recordIdKey alone (not kind),
 *  so open and close sharing one id would collapse into ONE record. Correlate open/close
 *  by STREAM ORDER (seq), never id-matched pairing. */
function mintTrackId(scope: RegionScope, coordinate: TrackCoordinate): RecordId {
  // A scope opened off the run's emission shares ONE instance counter with every other event
  // kind at that coordinate (port mints, sibling scopes) — id-only upsert would collapse them.
  const emission = scope.runCtx.emission;
  const ordinal =
    emission !== undefined && emission.coordinate === coordinate
      ? claimInstanceOrdinal(emission)
      : scope.trackOrdinal++;
  return {
    templateHash: coordinate.templateHash,
    ordinalPath: appendOrdinal(coordinate.ordinalPath, ordinal),
    regionEpoch: coordinate.regionEpoch,
  };
}

/** Fires at withRegionCall's pending++. No-ops unless the run emits (coordinate/sink) and is not silent. */
function noteTrackOpen(scope: RegionScope): void {
  if (scope.runCtx.silent) return; // doors stay active, emission doesn't
  const { trackCoordinate: coordinate, trackSink: sink } = scope;
  if (coordinate === undefined || sink === undefined) return;
  const id = mintTrackId(scope, coordinate);
  // Detached — never awaits, never perturbs the real call.
  void emitTrackOpen({ store: sink.store, regionId: sink.regionId, id }).catch(() => {});
}

/** Fires at withRegionCall's pending-- (finally — settled true either way). Own fresh id. */
function noteTrackClose(scope: RegionScope): void {
  if (scope.runCtx.silent) return; // doors stay active, emission doesn't
  const { trackCoordinate: coordinate, trackSink: sink } = scope;
  if (coordinate === undefined || sink === undefined) return;
  const id = mintTrackId(scope, coordinate);
  void emitTrackClose({ store: sink.store, regionId: sink.regionId, id, settled: true }).catch(() => {});
}

/** Append one order-dependent selector comparator verdict onto scope.hostSchedule;
 *  emission is once at close (flushHostSchedule) — "the sequence IS the record."
 *  No-op when emission off or no live scope; never throws. */
export function recordHostScheduleVerdict(
  scope: RegionScope,
  left: OrdinalPath,
  right: OrdinalPath,
  verdict: number,
): void {
  if (scope.runCtx.silent) return; // never accumulate under silence
  if (scope.trackCoordinate === undefined || scope.trackSink === undefined) return;
  scope.hostSchedule.push({ left, right, verdict });
}

/** Emit scope's entire schedule as ONE HostScheduleRecord at the scope's own coordinate
 *  (host call as a whole, not per-track). Drains hostSchedule first so double-close never
 *  double-flushes. Zero triples ⇒ emitHostSchedule itself no-ops. */
function flushHostSchedule(scope: RegionScope): void {
  if (scope.runCtx.silent) return; // doors stay active, emission doesn't
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
 * Reject value the moment signal aborts, without waiting for value to settle —
 * in-flight-cancellation half of rule 4. NOT imported from evaluator's raceAbort:
 * this leaf sits below the evaluator in the dependency order (host-agnostic FFI
 * leaves — rosetta / scheme-zod reach here); pulling the evaluator for a 15-line
 * Promise/AbortSignal helper is a layering violation. Abandoned promise's settlement
 * is swallowed (no unhandled rejection).
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

// ── Current region scope (call-depth slot of the crossing run) ──

/** The scope current inside a {@link withRegionScope} window whose run is the run-neutral
 *  CONSTANT_CTX (frozen `ambient` — no per-run slot to hold it). This is the CONSTANT_CTX leg
 *  of the SAME sync window `currentRun()` tolerates (docs/execution.md §1): set and restored
 *  inside `withCurrentRun`'s synchronous body, so it can never be observed across an await,
 *  and it only ever holds a scope whose `runCtx` is CONSTANT_CTX — nothing to attribute to a
 *  run. Live runs never touch it. */
let constantWindowScope: RegionScope | undefined;

/** Scope a reverse wrapper should close over if minted RIGHT NOW — undefined outside
 *  any tracked crossing (no sync window open). Treat undefined as "no region discipline"
 *  (always-open passthrough), never as an error. */
export function currentRegionScope(): RegionScope | undefined {
  const run = currentRun();
  if (run === undefined) return undefined;
  return Object.isFrozen(run.ambient) ? constantWindowScope : run.ambient.regionScope;
}

/** Install scope as current for the duration of fn (sync only — real callers mint
 *  wrappers synchronously; crossing's async work is outside this window): points
 *  {@link currentRun} at `scope.runCtx` and fills that run's `regionScope` slot (for a
 *  CONSTANT_CTX scope — detached or test-opened — the {@link constantWindowScope} leg). */
export function withRegionScope<T>(scope: RegionScope, fn: () => T): T {
  const { runCtx } = scope;
  if (!Object.isFrozen(runCtx.ambient)) {
    return withCurrentRun(runCtx, () => withAmbient(runCtx, "regionScope", scope, fn));
  }
  return withCurrentRun(runCtx, () => {
    const saved = constantWindowScope;
    constantWindowScope = scope;
    try {
      return fn();
    } finally {
      constantWindowScope = saved;
    }
  });
}

/** {@link withRegionScope} for a SYNCHRONOUS call whose RETURN VALUE may be a thenable (a host
 *  impl that is `async`, an egress element that is a pending promise): the window covers only
 *  the call's synchronous prologue — the returned promise is passed through untouched and
 *  never awaited inside the window, so the slot cannot leak across an await boundary. */
export function withRegionScopeCall<T>(scope: RegionScope, call: () => T): T {
  return withRegionScope(scope, () => ({ result: call() })).result;
}
