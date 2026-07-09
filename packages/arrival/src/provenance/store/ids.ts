/**
 * store/ids.ts — the identity primitives §5's record/payload vocabulary is built from.
 * Split out of interfaces.ts/records.ts so neither imports the other for an id type.
 *
 * Q10 (docs/PROVENANCE-PLAN.md) — store interfaces + fakes, LEAF node: nothing in
 * `src/eval`/`src/values` imports this yet. Real hashing (Q8b), real region-open/epoch
 * minting (Q11b/Q13), and real record emission (Q11a) are later nodes; this file only
 * fixes the SHAPE those nodes must produce/consume, per docs/PROVENANCE.md §5.
 */
/* eslint-disable sonarjs/redundant-type-aliases -- these aliases ARE the point of the
 * file: each one names a spec-§5 identity role (which opaque string/number a signature
 * means), so `allocateSeq(regionId): Promise<RegionSeq>` reads as the spec row it
 * implements. Inlining `string` everywhere would erase exactly that vocabulary. */

/** §5 D3: "template-hash (spans STRIPPED — dedup and store identity...)". Minted by
 *  Q8b's wireframe hasher; opaque string here — a record's static node address. */
export type TemplateHash = string;

/** §5 C2/D1: "record id = (template hash, instance-ordinal PATH, region epoch)."
 *  A PATH, not a flat integer — "nested fans collide otherwise" (panel round 1).
 *  Each entry is one fan/loop instance's ordinal on the way from the region's root
 *  binder down to this record's site; empty for a site with no enclosing fan/loop. */
export type OrdinalPath = readonly number[];

/** §5 C2/D1 (third id component) + §5 order rule ("per-region monotonic sequence +
 *  region epoch"): an opaque incarnation token for one region's lifetime-segment.
 *  Minted by region-open machinery (Q11b/Q13) — this store treats it as an opaque
 *  disambiguator, never derives or bumps it. Distinct from `semanticsEpoch`
 *  (§5 C6's STREAM header, the interpreter-version pin Q18 reads) — a region can
 *  reopen many times against one fixed semantics epoch. */
export type RegionEpoch = string;

/** Store-side partition key — WHICH region's durable stream (`ProvenanceStore`
 *  methods key by this). Not itself a spec-named id; the region-epoch id component
 *  disambiguates records *within* a region's lifetime, this picks the region. */
export type RegionId = string;

/** §5 D4: "keyed by a per-region monotonic sequence" — allocated by
 *  `ProvenanceStore.allocateSeq`, monotonic per `RegionId` for the region's whole
 *  lifetime (never resets on reopen; `RegionEpoch` is the disambiguator for that). */
export type RegionSeq = number;

/** §5 A1: payloads are "R2 for oversize payloads... by hash reference" / "hash-only
 *  stub after eviction" — content identity for `PayloadStore`. Callers (Q11a) mint the
 *  hash; this store persists/serves under whatever hash it is given (put is upsert-by-
 *  hash, same contract shape as `ProvenanceStore.append`'s upsert-by-`RecordId`). */
export type PayloadHash = string;

/** §5 C2/D1: deterministic record identity — the compound key idempotent upsert keys
 *  on. Two `append` calls with an identical `RecordId` are the SAME record (a retry),
 *  never two records. */
export interface RecordId {
  readonly templateHash: TemplateHash;
  readonly ordinalPath: OrdinalPath;
  readonly regionEpoch: RegionEpoch;
}

/** Stable string key for a `RecordId` — the thing a `Map`/upsert actually dedupes on.
 *  Exported so `ProvenanceStore` implementations (fake now, workerd adapter later,
 *  per PROVENANCE-PLAN.md's harness decision) agree on one collision-free encoding
 *  instead of each inventing its own. */
export function recordIdKey(id: RecordId): string {
  // JSON-encoded, not a delimited join: templateHash/regionEpoch are opaque strings
  // minted elsewhere and must not be assumed delimiter-safe.
  return JSON.stringify([id.templateHash, id.regionEpoch, id.ordinalPath]);
}
