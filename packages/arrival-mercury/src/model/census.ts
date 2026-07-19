/**
 * census — the shared identity-dedup pass over a `StaticProv` circuit: one
 * pass numbers holes/ids across every projection so cross-projection
 * numbering can never drift by construction (docs/working-proposals/
 * provenance-beautiful-child/README.md §5 motivates the shared pass).
 *
 * A pure REPRESENTATION-sharing walk, never semantics: a circuit with no
 * aliasing anywhere produces an empty `idOf` (see `circuit-sexpr.ts`'s own
 * header for the byte-identical-when-unshared guarantee, which this module
 * preserves exactly).
 *
 * Two consumers today: `circuit-sexpr.ts` (its `:id N`/`(ref N)` dedup
 * consumes this module directly) and `compose-template.ts` (the
 * where-clause lift — a shared node's `♯k` id IS this module's `idOf`
 * number, so a human can cross-read `♯3` in a formula straight to `:id 3`/
 * `(ref 3)` in the sexpr dump of the SAME root). Future consumers (the
 * collapse-view machine's state badges, per-field access cones) read the
 * same map for the same reason: one census, so numbering can never drift
 * between projections by construction.
 *
 * ── why one pass answers both "is this shared" and "what number" ───────────
 *
 * Pass 1 (`countOccurrences`) counts every reachable node's OBJECT-IDENTITY
 * occurrence count — a node reachable ≥2 times from the census root is
 * "shared." Pass 2 (`assignIds`) walks the SAME root again, in the SAME
 * per-kind child order every `StaticProv` projection uses (mint→closed;
 * fused→sources; mux→source; build→parts; string→runs; choice→guards then
 * alts; fan→collection then body), and mints a fresh id for a ≥2-count node
 * the FIRST time its subtree finishes processing — a node's children (if
 * also shared) always mint before their parent, since `assignIds` recurses
 * into children before minting its own id. This is a POST-ORDER,
 * first-occurrence numbering, deterministic given the DAG's own structure
 * (object identity is fixed once a circuit is constructed, so two calls to
 * `census` on the same root always agree).
 *
 * Both passes stop descending on a revisit (a node already counted / already
 * assigned) — linear in the DAG's DISTINCT-node count, never exponential
 * under deep sharing (mirrors `circuit-verdict.ts`'s own "no fuel needed"
 * discipline, and the original `countOccurrences`'s own note, applied to a
 * census instead of a fold). Exhaustive over `StaticProv`'s ten members
 * WITHOUT a default arm in both passes — tsc's return-type check is the
 * totality proof, the same discipline every walker in this package holds
 * (I1).
 */
import type { StaticProv } from "./static-prov.js";

export interface Census {
  /** Reachable object-identity occurrence count from the census root — EVERY
   *  reachable node appears here, including count-1 (unshared) ones. */
  readonly countOf: ReadonlyMap<StaticProv, number>;
  /** The stable id for every node reachable ≥2 times (by object identity) —
   *  ABSENT for a count-1 node (mirrors `circuit-sexpr.ts`'s original
   *  invariant: an unshared circuit never mints an id at all). Assigned in
   *  ONE fixed post-order, first-occurrence DFS pass over the census root —
   *  see this file's header for the exact traversal and why it reproduces
   *  `circuit-sexpr.ts`'s pre-extraction numbering exactly. */
  readonly idOf: ReadonlyMap<StaticProv, number>;
}

/** Pass 1: count `prov`'s reachable object-identity occurrences. Stops
 *  descending on a REPEAT visit — a shared node's children were already
 *  counted the first time THAT reference was reached. Exhaustive over
 *  StaticProv's ten members WITHOUT a default arm — tsc's return-type check
 *  is the totality proof. */
function countOccurrences(prov: StaticProv, counts: Map<StaticProv, number>): void {
  const before = counts.get(prov) ?? 0;
  counts.set(prov, before + 1);
  if (before > 0) return;
  switch (prov.kind) {
    case "input":
    case "const":
    case "opaque":
      return;
    case "mint":
      prov.closed.forEach((c) => countOccurrences(c, counts));
      return;
    case "fused":
      prov.sources.forEach((c) => countOccurrences(c, counts));
      return;
    case "mux":
      countOccurrences(prov.source, counts);
      return;
    case "build":
      prov.parts.forEach((p) => countOccurrences(p.prov, counts));
      return;
    case "string":
      prov.runs.forEach((c) => countOccurrences(c, counts));
      return;
    case "choice":
      prov.guards.forEach((g) => countOccurrences(g, counts));
      prov.alts.forEach((a) => countOccurrences(a, counts));
      return;
    case "fan":
      countOccurrences(prov.collection, counts);
      countOccurrences(prov.body, counts);
      return;
  }
}

/** Pass 2: mint a stable id for every ≥2-count node, in POST-ORDER
 *  first-occurrence order (children mint before parents along one DFS
 *  spine — see this file's header). `assigned` doubles as the revisit guard:
 *  a node already visited (whether or not it ended up minting an id) is
 *  never re-descended-into. Exhaustive over StaticProv's ten members WITHOUT
 *  a default arm, matching `countOccurrences` above. */
function assignIds(prov: StaticProv, counts: ReadonlyMap<StaticProv, number>, ids: Map<StaticProv, number>, visited: Set<StaticProv>, nextId: { n: number }): void {
  if (visited.has(prov)) return;
  visited.add(prov);
  switch (prov.kind) {
    case "input":
    case "const":
    case "opaque":
      break;
    case "mint":
      prov.closed.forEach((c) => assignIds(c, counts, ids, visited, nextId));
      break;
    case "fused":
      prov.sources.forEach((c) => assignIds(c, counts, ids, visited, nextId));
      break;
    case "mux":
      assignIds(prov.source, counts, ids, visited, nextId);
      break;
    case "build":
      prov.parts.forEach((p) => assignIds(p.prov, counts, ids, visited, nextId));
      break;
    case "string":
      prov.runs.forEach((c) => assignIds(c, counts, ids, visited, nextId));
      break;
    case "choice":
      prov.guards.forEach((g) => assignIds(g, counts, ids, visited, nextId));
      prov.alts.forEach((a) => assignIds(a, counts, ids, visited, nextId));
      break;
    case "fan":
      assignIds(prov.collection, counts, ids, visited, nextId);
      assignIds(prov.body, counts, ids, visited, nextId);
      break;
  }
  if ((counts.get(prov) ?? 1) >= 2) ids.set(prov, nextId.n++);
}

/** `StaticProv` → `Census` — the shared identity-dedup pass. Pure and total;
 *  deterministic (object identity is fixed once `root` is constructed, so
 *  the traversal order — and therefore every count and every id — is exactly
 *  as deterministic as the DAG itself). Safe to call independently on any
 *  sub-circuit (a fan's body, a choice's guard) exactly as on a whole
 *  program's root — each call's numbering is scoped to ITS OWN root, same as
 *  `circuit-sexpr.ts`'s `circuitToSexpr` was scoped per top-level call before
 *  this extraction. */
export function census(root: StaticProv): Census {
  const countOf = new Map<StaticProv, number>();
  countOccurrences(root, countOf);
  const idOf = new Map<StaticProv, number>();
  assignIds(root, countOf, idOf, new Set(), { n: 0 });
  return { countOf, idOf };
}
