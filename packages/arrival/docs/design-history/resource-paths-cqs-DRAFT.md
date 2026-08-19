# DRAFT — Rosetta resource paths (CQS / confluence)

> **Living home (2026-08-10):** [`docs/working-proposals/cqs-reactivity/`](../../../../../../docs/working-proposals/cqs-reactivity/) — unified CQS + reactivity design, ship order, go-wave status. This file remains archaeology; edit the workdir for ongoing work.

**Status:** design only — **not 0.9 implementation.** Snapshot also under `docs/working-proposals/cqs-reactivity/sources/`.  
**Parked → ready for first ship (caveats):** go-wave code gates verified closed 2026-08-10 (see workdir `00-status.md`). Dual-chibi growth / T3 conflict re-exec remain non-blocking residual.

**Related:**
- Rationale (CQS as confluence): `docs/thinking/confluent-dataflow-graph-ir-2026-06-17.md` §6  
- Burst / deferred sinks / read-guard: `docs/working-proposals/arrival-plexus-effect-burst.md`, `docs/execution.md` §BURST / §READ-GUARD  
- Effects conflict re-exec (post-0.9): sibling draft `effects-conflict-reexec-DRAFT.md`  
- Cleanup board snapshot: `docs/working-proposals/cqs-reactivity/sources/CLEANUP-WORKBOARD-2026-07-28.md`

---

## 1. Problem

Effects in a run must not affect **data queries** in the same run (command–query separation as a **confluence / replay** guarantee).

Classic example:

- **Insert / mutate a DB row:** allowed.  
- **Query that table afterward in the same run:** back-edge — kills confluence and replay.  
- **“Insert is safe unless you query it after.”**

Hazard algebra:

```
write-set ∩ later-read-set ≠ ∅  ⇒  door
```

Prior art (ingredients, not a drop-in product): CQS (Meyer), STM read/write sets, snapshot isolation intuition, Build Systems à la Carte (traces), ocap membranes. Integration for **agent single-run + membrane** is the product claim.

**Upsert / hybrids** both read and write — need path sets on both sides, or coarse domain fallback.

---

## 2. Granularity ladder

| Precision | Example path | Freedom |
|---|---|---|
| **Fine (ideal)** | `["db","projects", projectId]`; aggregates e.g. table size as its own path | Only block real prefix overlaps |
| **Coarse (fallback)** | `["db"]` or `["db","projects"]` | Touch free **before first domain read**; after a domain is queried, later overlapping writes/queries follow the law |

Domain root = first path segment (`db`, `http`, …). No separate enum required.

---

## 3. API (locked)

**Rosetta-only.** Natives / tagless / sequence / pure Scheme: **no** `queries` / `effects` (bake door).

```ts
symbol.rosetta`name: doc`(
  {
    input, output, /* rest of Contract */,
    queries?: (...decodedArgs) => ReadonlyDeep<Tuple<string>[]>,
    effects?: (...decodedArgs) => ReadonlyDeep<Tuple<string>[]>,
  },
  impl,
)
```

- Each **tuple** = one resource path (non-empty string segments).  
- Return = **list of paths**, deeply readonly (not `Set` — equality by segments).  
- Path fns are **dynamic**: must be **called** with decoded args every penetration (ids in paths).  
- Empty list `[]` ≡ omit for that axis.

---

## 4. Overlap (prefix)

Paths **overlap** iff one is a **prefix** of the other:

| Effect | Query | Overlap |
|---|---|---|
| `db/projects/id` | `db/projects` | **yes** |
| `db/projects/id` | `db/projects/otherId` | **no** |
| `db` | `db/projects/id` | **yes** |
| `http/…` | `db/…` | **no** |

---

## 5. Evaluation order (load-bearing)

**Crash before execution — never use `impl` return for footprints.**

```
1. decode args
2. Q = queries?.(...decoded) ?? []
3. E = effects?.(...decoded) ?? []
4. if Q overlaps any PRIOR effect path in this run → door (do not call impl)
5. record E / Q on run log as appropriate (effects recorded at enqueue if gather)
6. only then: impl → encode / mint / cache
```

If footprints used the return value, the world would already have moved.

---

## 6. Storage heuristic (derived — no free-form sink/view for this axis)

Call path producers every time:

| Produced | Run treats penetration as |
|---|---|
| any **effect** paths (`E` non-empty) | **Effect** — effect log / gather family |
| any **query** paths (`Q` non-empty) | **Cached value** — run-cache / view-style reuse |
| **both** | **Hybrid** (upsert): effect entry + cacheable return if any |
| **neither** | no path tracking (compat with today’s rosettas) |

So “is this an effect?” / “is this a cached query?” is **derived from dynamic path production**, not arbitrary `provenance: "sink"` / `cacheClass: "view"` for **this** law. (Those contract fields may remain for other laws until unified; path heuristic owns CQS storage.)

---

## 7. Law (CQS)

- **Query after overlapping prior effect** → door before impl.  
- **Effects alone** with no later overlapping query → free.  
- **Query then effect** on overlapping paths → allowed (motivating query, then mutate).  
- Teaching door names both paths and says: don’t query a resource this run already mutated; next call after commit, or drop the read.

---

## 8. Internals (sketch — not implemented)

| Piece | Role |
|---|---|
| `Contract.queries?` / `effects?` | Optional path producers; bake only on rosetta |
| `run/resource-paths.ts` | Prefix overlap; run-local prior-effect path set; optional query log |
| Rosetta `run` wrapper | After decode, before `penetrateThroughCache` / impl: compute Q/E, check, then fire |
| `EffectLog` | Carry effect paths on entries when `E≠∅` (at **enqueue** under burst) |
| `RunCache` | When `Q≠∅`, treat like cacheable value when cache armed |

**Orthogonal:** `read-guard.ts` (deferred sink vs later host-predicted keys). Can share clocks later; v1 separate.

---

## 9. Spec + invariants suite (when we implement)

### Spec home

`packages/arrival/docs/execution.md` **§RESOURCE-PATHS** (normative) + GLOSSARY entry.  
This draft stays design-history until then.

### Law suite (F10-style)

**Pure:** `resource-path-overlap.law.test.ts` — prefix table (parent/child/sibling/disjoint/empty).

**Integration:** `resource-path-cqs.law.test.ts` — tiny test capability:

| Id | Invariant |
|---|---|
| I1 | Conflict: effect then overlapping query → throw **and impl not called** |
| I2 | Sibling paths: no conflict |
| I3 | Effects only, no queries: all ok |
| I4 | Query then effect same tree: ok |
| I5 | Dynamic path from arg id |
| I6 | `E≠∅` ⇒ effect-log when armed |
| I7 | **superseded 2026-08-19:** `Q≠∅` is CQS journal only. Interpreter cache is `cacheClass: "view"` (opt-in), never implied by a query. |
| I8 | Hybrid both non-empty |
| I9 | Native cannot declare paths (bake) |
| I10 | Order: path fns → check → impl |

### Bake policy (open once)

Hybrid with non-void output: **allow** (upsert returns row).

---

## 10. Ship order (when unparked)

```
1. Spec text in execution.md
2. Pure overlap + ResourcePathLog + pure laws
3. Contract + bake (rosetta-only)
4. Rosetta chokepoint wire + integration laws I1–I10
5. Opt-in demo capability in tests only; packs later
```

**Not in first ship:** Class B SRFI renames, dual-chibi growth, real sql pack path helpers, conflict re-exec (T3), plexus field trackers.

---

## 11. Explicit non-goals

- Inferring paths from types or return values  
- Native/tagless effects  
- Full STM multi-agent concurrency  
- Replacing burst/confirm product with this alone  

---

## 12. Session note

Designed in cleanup/orchestration session after dual-chibi and go-wave. **Do not continue implementation of this design until the go-wave residual is closed** (review/commit/verify M1–M6 + W8 + cross-fix member/assoc defaultCompare). This file exists so the design is not lost when attention returns to the queue.
