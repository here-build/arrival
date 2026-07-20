/**
 * store/fold.ts — fold-as-recovery ("On DO wake after eviction/
 * hibernation, scope tokens, pending counters, and wrapper caches are RECONSTRUCTED
 * by folding the region's records — the fold law is not just a test invariant, it is
 * the recovery mechanism. In-memory region state is a cache of the stream, never the
 * source of truth"). The law: "fold(events) = final region state... the SAME
 * fold reconstructs region state on DO wake."
 *
 * `foldRegionStream` is a PURE function over `readStream`'s output — no I/O, no
 * ambient state — so calling it twice against the identical durable stream (the
 * ProvenanceStore's records, which survive a DO's JS-heap eviction/hibernation by
 * definition — only the DERIVED in-memory counters/caches are lost) always returns
 * an IDENTICAL `RegionFoldState`. That purity is the whole recovery story: there is
 * no separate "recovery machinery" to keep in sync with the fold, because recovery
 * IS calling this function again.
 */
import type { ProvenanceStore } from "./interfaces.js";
import { assertNeverRecord, type HostScheduleRecord, type ProvenanceRecord } from "./records.js";
import type { OrdinalPath, RegionEpoch, RegionId, RegionSeq, TemplateHash } from "./ids.js";

/** Region/track state derivable ENTIRELY from a region's record stream —
 *  "open counts, completions, host schedules." Deliberately does not attempt to
 *  reconstruct per-wrapper identity caches (`RegionScope.cache`, a WeakMap of live JS
 *  closures) — those are genuinely NOT stream-derivable (a wrapper is a runtime
 *  object, not a fact), and the silent-region/γ machinery never needs a
 *  recovered wrapper, only a recovered COORDINATE to mint fresh ones against — see
 *  `nextTrackOrdinal` below, which is exactly that coordinate. */
export interface RegionFoldState {
  /** Count of `track-open` records observed — "started". */
  readonly started: number;
  /** Count of `track-close` records observed WITH `settled: true` —
   *  "completed". A `track-close` record with `settled: false` is representable at
   *  the record-shape level (see `records.ts`'s own doc) but production never emits
   *  one — the door catches an unsettled promise egress BEFORE that record would ever
   *  be written — so it is folded separately, never silently counted as completed. */
  readonly completed: number;
  /** Count of `track-close` records observed with `settled: false` — always 0 against
   *  a real stream (see `completed`'s doc); kept visible rather than silently merged
   *  so a future producer of such a record does not corrupt the completion count. */
  readonly unsettledCloses: number;
  /** `started - completed` — the completion invariant is `pending === 0` at
   *  region close. Never negative against a stream `foldRegionStream` itself produced
   *  in order (see the monotonicity law); a hand-built out-of-order fixture COULD
   *  drive it negative, which is exactly what the monotonicity law tests for. */
  readonly pending: number;
  /** Every `host-schedule` record observed, in stream (emission) order —
   *  "the sequence IS the record," reproduced here as one entry per host invocation
   *  that reached a close (a schedule accumulated but never flushed — e.g. the
   *  process crashed before `closeRegionScope` ran — leaves no record at all, by
   *  construction; there is nothing partial to recover, only what was durably
   *  flushed). */
  readonly hostSchedules: readonly HostScheduleRecord[];
  /** Highest `seq` observed in the folded records, or 0 for an empty stream. Exposed
   *  for recovery-path assertions (a resumed region's next `allocateSeq` call must
   *  return something greater) — this fold never MINTS a seq itself, only reports
   *  the durable high-water mark `ProvenanceStore.allocateSeq`'s own counter already
   *  tracks server-side (the store's counter is monotonic for the region's
   *  whole lifetime, never reset on reopen). */
  readonly lastSeq: RegionSeq;
}

const EMPTY_FOLD: RegionFoldState = {
  started: 0,
  completed: 0,
  unsettledCloses: 0,
  pending: 0,
  hostSchedules: [],
  lastSeq: 0,
};

/** The law: fold a region's ENTIRE record stream into its `RegionFoldState`. Pure —
 *  no store access, no ambient state — so this is safe to call as many times as a
 *  caller likes against the SAME `records` array (post-hoc query) or against a fresh
 *  `readStream` result after a simulated eviction (recovery) and get back the
 *  identical answer, which is the fold-as-recovery law itself. */
export function foldRegionStream(records: readonly ProvenanceRecord[]): RegionFoldState {
  if (records.length === 0) return EMPTY_FOLD;
  let started = 0;
  let completed = 0;
  let unsettledCloses = 0;
  let lastSeq = 0;
  const hostSchedules: HostScheduleRecord[] = [];
  // "The stream's total order is EMISSION order (settlement order for async)" —
  // fold over a COPY sorted by seq so a caller handing in an out-of-order slice (a law
  // test probing monotonicity under injected reordering) still folds in the order that
  // actually matters, exactly like `ProvenanceStoreFake.readStream` already returns.
  const ordered = records.toSorted((a, b) => a.seq - b.seq);
  for (const record of ordered) {
    if (record.seq > lastSeq) lastSeq = record.seq;
    switch (record.kind) {
      case "track-open":
        started++;
        break;
      case "track-close":
        if (record.settled) completed++;
        else unsettledCloses++;
        break;
      case "host-schedule":
        hostSchedules.push(record);
        break;
      case "mint":
      case "mux-decision":
      case "fan-instantiation":
      case "ingress-binding":
        // "Region/track state" is scoped to track open/close counts + host
        // schedules (the completion invariant, the schedule) — the other four kinds
        // carry no region-lifecycle information a fold needs to recover; the
        // aggregation (path-scoped RLE) and the demand-lattice queries own reading
        // these, not this fold.
        break;
      default:
        assertNeverRecord(record);
    }
  }
  return { started, completed, unsettledCloses, pending: started - completed, hostSchedules, lastSeq };
}

/** Convenience: read a region's stream and fold it in one call — the exact shape
 *  "on DO wake... reconstructed by folding the region's records" describes.
 *  A DO-wake recovery call site (`region-scope.ts`'s `reconstructRegionScope`) and a
 *  post-hoc "what was this region's state" query call THIS SAME function — one fold,
 *  two callers, per the law's own statement. */
export async function foldRegionState(store: ProvenanceStore, regionId: RegionId): Promise<RegionFoldState> {
  return foldRegionStream(await store.readStream(regionId));
}

/** The coordinate shape `nextTrackOrdinal` scopes over — the same three fields as
 *  `region-scope.ts`'s `TrackCoordinate`, duplicated here (not imported) for the same
 *  no-cross-import reason that file's own header documents: `store/` sits BELOW
 *  `membrane/region-scope.ts` in the dependency order, so this module must
 *  not name a type from it. */
export interface FoldTrackCoordinate {
  readonly templateHash: TemplateHash;
  readonly ordinalPath: OrdinalPath;
  readonly regionEpoch: RegionEpoch;
}

/** Recovery's OTHER half, alongside `pending`: the next free trailing ordinal for
 *  track-open/track-close ids minted under `coordinate` (`region-scope.ts`'s
 *  `mintTrackId` — `appendOrdinal(coordinate.ordinalPath, scope.trackOrdinal++)`).
 *  A resumed scope that reset `trackOrdinal` to 0 would re-mint ids that COLLIDE
 *  (id-only upsert) with ones already durable from before the eviction that
 *  wiped the in-memory counter — this is the fold-derived seed that prevents that.
 *  Scoped to records whose `(templateHash, regionEpoch)` match `coordinate` AND whose
 *  `ordinalPath` is exactly `coordinate.ordinalPath` plus one trailing ordinal (a
 *  DIRECT track event under this coordinate, never a deeper nested one — mirrors
 *  `store/ids.ts`'s own path-scoping discipline for aggregation runs). */
export function nextTrackOrdinal(records: readonly ProvenanceRecord[], coordinate: FoldTrackCoordinate): number {
  const prefixLen = coordinate.ordinalPath.length;
  let maxOrdinal = -1;
  for (const record of records) {
    if (record.kind !== "track-open" && record.kind !== "track-close") continue;
    const { id } = record;
    if (id.templateHash !== coordinate.templateHash) continue;
    if (id.regionEpoch !== coordinate.regionEpoch) continue;
    if (id.ordinalPath.length !== prefixLen + 1) continue;
    let matchesPrefix = true;
    for (let i = 0; i < prefixLen; i++) {
      if (id.ordinalPath[i] !== coordinate.ordinalPath[i]) {
        matchesPrefix = false;
        break;
      }
    }
    if (!matchesPrefix) continue;
    const trailing = id.ordinalPath[prefixLen];
    if (trailing > maxOrdinal) maxOrdinal = trailing;
  }
  return maxOrdinal + 1;
}
