/**
 * eval/provenance-hooks.ts — Q11a's EVALUATOR-SIDE hook (docs/PROVENANCE-PLAN.md Q11a:
 * "src/eval/* emission hooks... find the port sites (membrane penetrations: rosetta
 * invocation exits, source-roled mints)"). Owns the ambient "current record coordinate"
 * a caller installs so a real membrane crossing inside `evaluator.ts`'s generic apply
 * can key an emission against it, plus the ONE call `evaluator.ts` makes at that
 * crossing. Modeled on `dynamic-call-site.ts`'s module-holder + save/restore idiom
 * (same file's own header explains why an ambient holder, not an explicit `ctx` field,
 * is this codebase's house pattern for this class of cross-cutting concern).
 *
 * ── Why NOT auto-detect "this call is a rosetta" structurally ──────────────────────
 * `Environment.defineRosetta` (`Environment.ts`) binds a bare async JS function
 * (`rosetta.ts`'s `createRosettaWrapper` output) — NOT an `ARosettaProcedure` AValue.
 * That class exists (`values/primitives/ACallable.ts`) but its own doc says it's a
 * stage-3-migration target; nothing constructs one today. So the generic apply site
 * (`evaluatePair` in `evaluator.ts`) cannot ask "is this callable a rosetta" by class
 * or brand — every callable reaches that site looking the same (a bare fn).
 *
 * What IS observable, without touching `rosetta.ts` or `op-helpers.ts` (both out of
 * this node's territory): `rosetta.ts`'s own mint path unconditionally flips
 * `inv.isProvenancePoint` on `ctx.currentInvocation` the instant a rosetta call settles
 * (`mintsPoint && inv && typeof inv.id === "number"` — see `rosetta.ts`'s
 * `createRosettaWrapper`). `w1-harness.ts` (Q9) documents this exact mechanism already:
 * "a direct execState run has no live currentInvocation to auto-mint against — see
 * rosetta.ts's mintsPoint && inv guard." This hook reuses that EXISTING signal after
 * the fact — it adds no new brand, and does not change WHEN or WHETHER the flip itself
 * happens; it only asks, post-settlement, "did that call just become a mint point."
 *
 * ── Why detached, not inline ─────────────────────────────────────────────────────
 * `notePotentialRosettaExit` NEVER wraps, replaces, or awaits the value/Promise the
 * trampoline is about to yield/return — it attaches its OWN independent `.then`/`.catch`
 * (for the async case) or runs synchronously off to the side (for the sync case),
 * so a slow, failed, or even THROWING emission can never perturb the real call's
 * timing, identity, or outcome — on OR off.
 */
import type { Invocation } from "./dynamic-call-site.js";
import { is_promise } from "./guards.js";
import { emitMint, isEmissionEnabled } from "../provenance/store/emit.js";
import type { OrdinalPath, RegionEpoch, RegionId, TemplateHash } from "../provenance/store/ids.js";
import type { PayloadStore, ProvenanceStore } from "../provenance/store/interfaces.js";
import { AValue } from "../values/primitives/AValue.js";
import { schemeToJs } from "../rosetta.js";
import type { SchemeValue } from "../values/types.js";

/** One port's static address (§5 C2/D1) — everything an emission needs BESIDES which
 *  store/region to write to (that's `EmissionSink`, below). The wireframe-walking
 *  driver (Q15/Q16) is the eventual real installer, advancing this per designated node
 *  as it walks a `WireframeGraph`; Q11a's own tests install one by hand around a short
 *  run (see `src/eval/__tests__/provenance-hooks.test.ts`). */
export interface RecordCoordinate {
  readonly templateHash: TemplateHash;
  readonly ordinalPath: OrdinalPath;
  readonly regionEpoch: RegionEpoch;
}

/** Where a coordinate's records actually land — the store ports plus which region's
 *  partition. Split from `RecordCoordinate` (a per-PORT address) because one sink
 *  typically serves MANY coordinates across a region's whole lifetime. */
export interface EmissionSink {
  readonly store: ProvenanceStore;
  readonly payloads: PayloadStore;
  readonly regionId: RegionId;
}

let _coordinate: RecordCoordinate | undefined;
let _sink: EmissionSink | undefined;

/** Read the ambient coordinate — `undefined` for every call today outside a test that
 *  installed one (nothing in production wires this yet; that's Q15/Q16's job). */
export function currentRecordCoordinate(): RecordCoordinate | undefined {
  return _coordinate;
}

/** Read the ambient sink (store/payloads/regionId a coordinate's emissions target). */
export function currentEmissionSink(): EmissionSink | undefined {
  return _sink;
}

/** Install BOTH the coordinate and its sink for the duration of a SYNCHRONOUS `fn` —
 *  save/restore, the same idiom `dynamic-call-site.ts`'s `withDynamicCallSite` uses.
 *  Single-threaded JS makes the module holder safe; a nested install restores its
 *  parent's pair on exit, so once Q15/Q16 nest real regions here, an inner drill-in
 *  never bleeds its coordinate into the outer caller's continuation.
 *
 *  SYNC ONLY: `fn` must not itself await before the crossing(s) it's meant to cover —
 *  `finally` restores the ambient pair the instant `fn` RETURNS, not once a returned
 *  Promise SETTLES (matching `withDynamicCallSite`'s own contract). Wrapping a whole
 *  async interpreter run (as this node's own integration test does) needs
 *  {@link withRecordCoordinateAsync} instead. */
export function withRecordCoordinate<T>(coordinate: RecordCoordinate, sink: EmissionSink, fn: () => T): T {
  const savedCoordinate = _coordinate;
  const savedSink = _sink;
  _coordinate = coordinate;
  _sink = sink;
  try {
    return fn();
  } finally {
    _coordinate = savedCoordinate;
    _sink = savedSink;
  }
}

/** The async-safe sibling of {@link withRecordCoordinate}: restores the ambient pair
 *  only once `fn`'s returned Promise SETTLES, so every crossing that happens anywhere
 *  during a multi-tick run (a whole `execState` call, say) still observes the
 *  installed coordinate/sink. Kept as a SEPARATE function rather than overloading
 *  the sync one so a caller's choice of "restore on return" vs "restore on settle" is
 *  explicit at the call site, never inferred from what `fn` happens to return. */
export async function withRecordCoordinateAsync<T>(
  coordinate: RecordCoordinate,
  sink: EmissionSink,
  fn: () => Promise<T>,
): Promise<T> {
  const savedCoordinate = _coordinate;
  const savedSink = _sink;
  _coordinate = coordinate;
  _sink = sink;
  try {
    return await fn();
  } finally {
    _coordinate = savedCoordinate;
    _sink = savedSink;
  }
}

/** Structural shape of the eager-oracle's per-invocation mint flag — the same opaque
 *  narrowing discipline `dynamic-call-site.ts`'s `Invocation = unknown` already
 *  documents for this exact object (`provenance/trace.ts` owns its real shape; this
 *  file reads two fields off it structurally, imports nothing from that module). */
interface ProvenancePointInvocation {
  readonly id?: number;
  readonly isProvenancePoint?: boolean;
}

/** Peel a settled call result into a mint's payload shape (value + stamp ids, §5 D2).
 *  `schemeToJs` is the SAME "peel to plain JS" convention `provenance/uneval.ts` uses
 *  for its own `result`/`uneval(...).value` fields — one peeling idiom, not a second. */
function payloadOf(value: SchemeValue): { readonly value: unknown; readonly stampIds: readonly number[] } {
  const stampIds = value instanceof AValue ? [...value.provenance] : [];
  return { value: schemeToJs(value, {}), stampIds };
}

/**
 * THE hook — call once from `evaluator.ts`'s generic apply site, right after a call's
 * result is known (a plain value or a not-yet-settled Promise; NEVER a Bounce — the
 * caller only reaches this after the bounce/tail-call branch has already returned).
 *
 * No-ops before touching anything else unless: the flag is on, a coordinate AND sink
 * are both installed, and `inv` names a live invocation — the conjunction that makes
 * "sunset byte-identical when off" a one-line argument (a single boolean read on the
 * hot path when disabled, nothing else ever runs).
 */
export function notePotentialRosettaExit(inv: Invocation, result: SchemeValue | Promise<SchemeValue>): void {
  if (!isEmissionEnabled()) return;
  const coordinate = _coordinate;
  const sink = _sink;
  if (coordinate === undefined || sink === undefined) return;
  const point = inv as ProvenancePointInvocation | undefined;
  if (point === undefined || typeof point.id !== "number") return;

  const id = {
    templateHash: coordinate.templateHash,
    ordinalPath: coordinate.ordinalPath,
    regionEpoch: coordinate.regionEpoch,
  };

  const settle = (value: SchemeValue): void => {
    // Read AFTER settlement — `rosetta.ts`'s mint path flips this flag synchronously,
    // before its wrapper's returned Promise resolves, so it is always current here.
    if (point.isProvenancePoint !== true) return; // not a mint point — no record
    const { value: peeled, stampIds } = payloadOf(value);
    // Fire-and-forget by design (a "flag-gated SIDECAR" per the task brief): production
    // correctness never depends on this write landing. The direct `emitMint` API
    // (called straight, awaited, by a caller that wants the durability guarantee) is
    // the correct seam for anything that must observe a write failure — this detached
    // path deliberately swallows one instead of propagating it into evaluator.ts's
    // hot call path.
    void emitMint({
      store: sink.store,
      payloads: sink.payloads,
      regionId: sink.regionId,
      id,
      value: peeled,
      stampIds,
    }).catch(() => {});
  };

  if (is_promise(result)) {
    void (result as Promise<SchemeValue>).then(settle, () => {}); // a rejected crossing mints nothing
  } else {
    settle(result);
  }
}
