/**
 * Evaluator-side emission hook: port sites (membrane penetrations — rosetta
 * exits, source-roled mints) inside `src/eval/*`. The emission target (store ports,
 * region, port coordinate) is NOT ambient: it rides the run as `RunContext.emission`
 * (docs/execution.md §3, P19), so concurrent recording runs on one isolate cannot
 * cross, and the run-flag `RunContext.silent` suppresses the mint for hermetic γ replay.
 *
 * WHY NOT STRUCTURAL DETECTION: rosetta mint paths flip
 * `inv.isProvenancePoint` when an invocation id is live. This hook reuses that
 * signal after the fact — a detached sidecar, not a special-case of every apply.
 *
 * DETACHED, NOT INLINE: `notePotentialRosettaExit` never wraps or awaits the
 * value/Promise the trampoline yields — it attaches its own independent
 * `.then`/`.catch` (or runs sync off to the side) so a slow/failed emission
 * never perturbs the real call's timing, identity, or outcome.
 *
 * MINT IDENTITY: one run's emission names ONE static coordinate, yet a run can cross the
 * membrane many times; the store upserts by `RecordId`, so every mint takes the next
 * per-crossing instance ordinal appended to the coordinate's ordinal path
 * (`claimInstanceOrdinal`, shared with track events so kinds cannot collide).
 */
import type { Invocation } from "./dynamic-call-site.js";
import { is_promise } from "../values/value-guards.js";
import { claimInstanceOrdinal, emitMint, emitTrackClose, emitTrackOpen } from "../provenance/store/emit.js";
import {
  appendOrdinal,
  type OrdinalPath,
  type RecordId,
  type RegionEpoch,
  type TemplateHash,
} from "../provenance/store/ids.js";
import { AValue } from "../values/primitives/AValue.js";
import { toJS } from "../membrane/rosetta.js";
import { isCrossingRaise, raiseMessage } from "../membrane/crossing-raise.js";
import type { RunContext, RunEmission } from "../run/RunContext.js";
import type { SchemeValue } from "../values/types.js";

/** One port's static address — everything an emission needs BESIDES which
 *  store/region to write to (the rest of `RunEmission`). */
export interface RecordCoordinate {
  readonly templateHash: TemplateHash;
  readonly ordinalPath: OrdinalPath;
  readonly regionEpoch: RegionEpoch;
}

/** A closure node's static address, derived by the recording host from the wireframe over the SAME
 *  parsed forms the run evaluates (`WireframeProgram.closureSites`, keyed by the lambda's BODY
 *  list — the pair a `lambda` literal and a `(define (f …) …)` shorthand share with their wireframe form): `templateHash` = content hash of the closure's private template (shared by every
 *  site of an identical lambda), `rootOrdinal` = the closure node's index in its enclosing graph. */
export interface ClosureSite {
  readonly templateHash: TemplateHash;
  readonly rootOrdinal: number;
}

/**
 * One closure CALL's emission window — a TRACK (docs/PROVENANCE.md §3): ports inside the call emit
 * under `coordinate` (= `[...parent, rootOrdinal, k]`, k = this call's instance among the parent's
 * calls of that site index), and the call opens/closes a track record at it. The parent is the
 * CALLER's window when the call runs in an apply site's synchronous prologue — calls within one
 * track are sequential, so `k` cannot depend on how sibling tracks interleave — else the window
 * that DEFINED the closure (evaluator.ts picks it; replay.ts `callerInstance` mirrors the rule).
 * Held on run-scoped state: the counters live on the parent window / the run's emission, never
 * module state.
 */
export interface ClosureCallWindow {
  readonly coordinate: RecordCoordinate;
  /** Next call ordinal per closure site INDEX (`ClosureSite.rootOrdinal`), for calls whose parent is
   *  this window. Keyed by index, not site, so two sites sharing an index still get distinct paths. */
  readonly calls: Map<number, number>;
  /** Next instance ordinal for events (port mints, track open/close) at this window. */
  instance: number;
}

/** Run-scoped root counters: the calls whose parent is the run's own root coordinate. */
const rootCalls = new WeakMap<RunEmission, Map<number, number>>();

/**
 * Open a closure call's window and its track (`track-open` now; the returned `close()` emits
 * `track-close`). `undefined` unless the run carries an emission target and `site` is a known closure.
 *
 * A SILENT run (hermetic playback replay) still opens the window — coordinates are how a replay
 * addresses the recorded payloads (`replay.ts`, D1) — but writes nothing: the counters advance exactly
 * as in the recording run, so a replayed call lands on the SAME `[…enclosing, r_C, k]` path.
 */
export function openClosureCall(
  runCtx: RunContext,
  parent: ClosureCallWindow | undefined,
  site: ClosureSite | undefined,
): { readonly window: ClosureCallWindow; readonly close: () => void } | undefined {
  const emission = runCtx.emission;
  if (emission === undefined || site === undefined) return undefined;
  const silent = runCtx.silent;
  let counters = parent?.calls;
  if (counters === undefined) {
    counters = rootCalls.get(emission) ?? new Map<number, number>();
    rootCalls.set(emission, counters);
  }
  const k = counters.get(site.rootOrdinal) ?? 0;
  counters.set(site.rootOrdinal, k + 1);
  const base = parent?.coordinate ?? emission.coordinate;
  const coordinate: RecordCoordinate = {
    templateHash: site.templateHash,
    ordinalPath: appendOrdinal(appendOrdinal(base.ordinalPath, site.rootOrdinal), k),
    regionEpoch: base.regionEpoch,
  };
  const window: ClosureCallWindow = { coordinate, calls: new Map(), instance: 0 };
  const eventId = (): RecordId => ({
    templateHash: coordinate.templateHash,
    ordinalPath: appendOrdinal(coordinate.ordinalPath, window.instance++),
    regionEpoch: coordinate.regionEpoch,
  });
  const openId = eventId();
  if (!silent) void emitTrackOpen({ store: emission.store, regionId: emission.regionId, id: openId }).catch(() => {});
  let closed = false;
  return {
    window,
    close: () => {
      if (closed) return;
      closed = true;
      const closeId = eventId();
      if (silent) return;
      void emitTrackClose({ store: emission.store, regionId: emission.regionId, id: closeId, settled: true }).catch(
        () => {},
      );
    },
  };
}

/** Where a port crossing lands: the innermost closure-call window if any, else the run's coordinate.
 *  Exported for recording hosts that mint their own crossings (the Q16 harness's sources). */
export function mintId(emission: RunEmission, window: ClosureCallWindow | undefined): RecordId {
  if (window !== undefined) {
    return {
      templateHash: window.coordinate.templateHash,
      ordinalPath: appendOrdinal(window.coordinate.ordinalPath, window.instance++),
      regionEpoch: window.coordinate.regionEpoch,
    };
  }
  const { coordinate } = emission;
  return {
    templateHash: coordinate.templateHash,
    ordinalPath: appendOrdinal(coordinate.ordinalPath, claimInstanceOrdinal(emission)),
    regionEpoch: coordinate.regionEpoch,
  };
}

/** Structural shape of the per-invocation mint flag — opaque Invocation
 *  narrowed structurally (provenance/trace.ts owns the real shape). */
interface ProvenancePointInvocation {
  readonly id?: number;
  readonly isProvenancePoint?: boolean;
}

/** Peel a settled call result into a mint's payload shape — one membrane exit. */
function payloadOf(value: SchemeValue): { readonly value: unknown; readonly stampIds: readonly number[] } {
  const stampIds = value instanceof AValue ? [...value.provenance] : [];
  return { value: toJS(value), stampIds };
}

/**
 * THE hook — call once from evaluator.ts's generic apply site after a call's
 * result is known (plain value or pending Promise; NEVER a Bounce).
 *
 * No-ops unless: the run has an `emission` target, is not `silent`, and `inv`
 * names a live invocation — one field read on the hot path when disabled.
 */
export function notePotentialRosettaExit(
  runCtx: RunContext,
  inv: Invocation,
  result: SchemeValue | Promise<SchemeValue>,
  window?: ClosureCallWindow,
): void {
  const emission = runCtx.emission;
  if (emission === undefined) return;
  // Silent run (γ / glass whole-program replay) suppresses this mint — a run flag, not a holder.
  if (runCtx.silent) return;
  const point = inv as ProvenancePointInvocation | undefined;
  if (point === undefined || typeof point.id !== "number") return;

  // An async crossing's id is claimed at call START (ordinals follow start order, which is
  // deterministic; completion order is not — P18). A sync result settles immediately, so its claim
  // below is the same moment. A non-point async call wastes its ordinal: ids stay unique, gaps are inert.
  const started = is_promise(result) ? mintId(emission, window) : undefined;

  const settle = (value: SchemeValue): void => {
    // Read AFTER settlement — rosetta mint flips this flag synchronously before
    // the wrapper Promise resolves.
    if (point.isProvenancePoint !== true) return;
    const { value: peeled, stampIds } = payloadOf(value);
    const id = started ?? mintId(emission, window);
    // Fire-and-forget sidecar: production correctness never depends on this
    // write. Direct emitMint is the durability seam; this path swallows failures.
    void emitMint({
      store: emission.store,
      payloads: emission.payloads,
      regionId: emission.regionId,
      id,
      value: peeled,
      stampIds,
    }).catch(() => {});
  };

  const settleRaised = (error: unknown): void => {
    // Only a HOST crossing's throw is a recorded raise; validation/abort errors mint nothing.
    if (!isCrossingRaise(error)) return;
    void emitMint({
      store: emission.store,
      payloads: emission.payloads,
      regionId: emission.regionId,
      id: started ?? mintId(emission, window),
      value: raiseMessage(error),
      stampIds: [],
      raised: true,
    }).catch(() => {});
  };

  if (is_promise(result)) {
    void (result as Promise<SchemeValue>).then(settle, settleRaised);
  } else {
    settle(result);
  }
}
