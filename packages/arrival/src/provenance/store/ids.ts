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

/** §5 D3's OTHER named hash: "site-hash (spans KEPT — plane identity; the two sites
 *  render as two wires)." Minted by Q8b's wireframe hasher (`wireframe/hash.ts`'s
 *  `siteHash`) by combining a `TemplateHash` with the instantiation site's `scopeId`
 *  span. Distinct namespace from `TemplateHash` even though both are opaque strings —
 *  never interchange them (a record keys on `TemplateHash`, the PLANE keys on this). */
export type SiteHash = string;

/** §5 C2/D1: "record id = (template hash, instance-ordinal PATH, region epoch)."
 *  A PATH, not a flat integer — "nested fans collide otherwise" (panel round 1).
 *
 *  Q8b's ROOT-BINDER PROGRAM ORDER ruling (docs/PROVENANCE-PLAN.md Q8b, D6: "top-level
 *  program order... is owned by the root binder chain"): the FIRST entry of a path is
 *  the owning `WireframeGraph`'s own root ordinal for that designated node — its
 *  position in `graph.nodes` (stable across re-parses of identical source, since the
 *  builder's walk is a deterministic left-to-right, program-order traversal; see
 *  `wireframe/hash.ts`'s `rootOrdinalPath`). This is NOT optional/skippable even for a
 *  node with no enclosing fan/loop: `TemplateHash` is content-addressed (spans
 *  stripped, §5 D3), so two structurally-identical designated nodes at DIFFERENT
 *  static sites (e.g. two separate top-level `(fetch-item 1)` calls) would otherwise
 *  collide on `(templateHash, [], regionEpoch)`. The root ordinal is what keeps
 *  `RecordId` collision-free WITHOUT widening `TemplateHash` itself back into a
 *  position-sensitive address (which would defeat the dedup §5 D3 wants). Deeper
 *  entries append one ordinal per nested fan/loop INSTANCE (a runtime count, not a
 *  static position) via `appendOrdinal` below — the z-axis (§6) instance coordinate. */
export type OrdinalPath = readonly number[];

/** The empty path — a graph's own root, before any ordinal (root or instance) has been
 *  appended. Not itself a valid `RecordId.ordinalPath` for any real designated node
 *  (every node gets at least its root ordinal, per the comment above) — exists as the
 *  base case composition ops build from. */
export const ROOT_ORDINAL_PATH: OrdinalPath = [];

/** Append one ordinal — a nested fan/loop INSTANCE's index — to a path. The z-axis
 *  (§6 "z-axis = instance-ordinal space") composition primitive: nested regions stack
 *  ordinals depth-first, one per enclosing instantiation, from a graph's own root
 *  ordinal (§5 D1's first entry) down to the record's site. */
export function appendOrdinal(parent: OrdinalPath, ordinal: number): OrdinalPath {
  return [...parent, ordinal];
}

/** §5 round 3 m4: "aggregation runs are PATH-SCOPED... a run is (parent ordinal-path,
 *  start, count)." The parent path an `AggregationRun` (`records.ts`) scopes against —
 *  drop the trailing (own-instance) ordinal, keeping every ordinal ABOVE it. Empty
 *  parent for a length-1 (root-only) path — "inner-loop/fan ordinals restart per outer
 *  element, so runs never span parents" bottoms out at the graph's own root. */
export function parentOrdinalPath(path: OrdinalPath): OrdinalPath {
  return path.slice(0, -1);
}

/** The trailing (own-instance) ordinal — `undefined` for the empty path (never a real
 *  node's path; see `ROOT_ORDINAL_PATH`'s doc). Pairs with `parentOrdinalPath`: every
 *  non-empty path is exactly `appendOrdinal(parentOrdinalPath(p), trailingOrdinal(p))`. */
export function trailingOrdinal(path: OrdinalPath): number | undefined {
  return path.length === 0 ? undefined : path[path.length - 1];
}

/** Deterministic lexicographic order over paths — shorter-is-earlier on a shared
 *  prefix (a parent sorts before any of its children), matching the plane's z-axis
 *  depth-first stacking (§6). Used for the template-store's reverse index (Q8b
 *  amendment) so a "list every site under this template" query returns a stable order,
 *  and for any consumer that needs `OrdinalPath` values as a `Map`/sort key alongside
 *  `ordinalPathKey`. */
export function compareOrdinalPaths(a: OrdinalPath, b: OrdinalPath): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Stable string key for an `OrdinalPath` alone — the same collision-free JSON
 *  encoding `recordIdKey` folds in below, exposed standalone for consumers keying
 *  purely on the instance coordinate (the template-store's reverse index: one
 *  `TemplateHash` maps to MANY sites, each disambiguated by its own path). */
export function ordinalPathKey(path: OrdinalPath): string {
  return JSON.stringify(path);
}

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
