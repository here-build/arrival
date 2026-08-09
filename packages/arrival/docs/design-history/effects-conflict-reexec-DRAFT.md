# DRAFT — Effects model + conflict re-exec (post-0.9)

> **Living home for CQS + path producers + reactivity attachment (2026-08-10):**  
> [`docs/working-proposals/cqs-reactivity/`](../../../../../../docs/working-proposals/cqs-reactivity/).  
> Resource-path §0b here is snapshotted there; conflict re-exec (T3+) stays later.

> **Not for 0.9 implementation of T3/T4.** Design only. Core gather/burst already ships; conflict re-exec is unbuilt.

**Sources:** `run/effect-log.ts`, `run/run-cache.ts`, `run/read-guard.ts`, `docs/execution.md` §MODE-LAW / §BURST, rosetta sink penetration, membrane §REGION, `arrival-mcp` confirm-burst.

---

## 0. Charter

**Gather sinks into an ordered, non-deduplicating log while the program runs; drain them later under host atomicity; detect when the world moved between gather and fire; never pretend a deferred effect was already applied.**

Conflict re-exec is the missing middle: how the host decides “still valid” vs “re-derive / refuse” before fire.

### Related law — CQS / read-after-write (confluence)

**Source:** `docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md` §6  
(not implemented as product law; related to but distinct from deferred-sink read-guard).

**Rule:** effects in a run must not affect any **data query** in that same run.  
DB example: **insert is safe; query of that table afterward in the same run is the hazard**  
(“insert is safe unless you query it after”).

**Resource granularity (V, 2026-07-24) — ladder, not one size:**

| Precision | Example resource key | Freedom |
|---|---|---|
| **Fine (ideal)** | table + row id; table + size/count aggregate; entity+field | Writes free on unobserved resources; only block `write-set ∩ later read-set` at that grain |
| **Coarse (reasonable fallback)** | whole DB / connection / “sql domain” | **Touches allowed before first domain read, or after last domain read**; once a domain is read mid-run, later writes to that domain are the back-edge (and writes that already ran before the first read remain OK) |

Fine grain needs hosts to declare/infer footprints. Coarse grain needs only **domain identification** (sql / http / plexus-doc / …) plus first/last read clocks per domain — enough for many agent pipelines without row-level modeling.

**Hybrid verbs (upsert, RETURNING mutators):** neither pure query nor pure command — classify by declared write-set + read-set at whatever grain is available, or fall back to domain-level “this domain was already read ⇒ no more writes.”

---

## 0b. Resource paths on rosetta (API + run heuristic) — V 2026-07-24

### Surface (rosetta-only)

Only `symbol.rosetta` may declare world footprints. Natives / tagless / pure Scheme: no paths.

```ts
symbol.rosetta`…`(
  {
    input, output, /* contract… */,
    queries?: (...decodedArgs) => ReadonlyDeep<Tuple<string>[]>,
    effects?: (...decodedArgs) => ReadonlyDeep<Tuple<string>[]>,
  },
  impl,
)
```

- Each **tuple** = one resource path (`["db","projects", id]`).
- Return is a **list of paths**, deeply readonly (not `Set` — path equality is by segments).
- Functions are **dynamic**: must be **invoked** at the call with decoded args (paths can depend on ids). Never treat presence of the field alone as “has effects.”

### Crash before execution

Path producers run **after decode, before `impl`**.  
The return value of `impl` is **not** used for classification or conflict detection.

1. Decode args  
2. `Q = queries?.(...args) ?? []`, `E = effects?.(...args) ?? []`  
3. **Conflict check** (prefix overlap of paths) against the run’s prior effect/query logs  
4. If conflict → **door / throw** — do not start `impl`  
5. Only then run `impl`  
6. **Store** by heuristic below (still from `Q`/`E`, not from return)

Using the return for footprints would mean effects already ran — too late for CQS / confluence.

### Storage heuristic (no arbitrary sink/view declarations for this axis)

| After calling path fns | Run treats the penetration as |
|---|---|
| `E` non-empty (any effect path produced) | **Effect** — effect-log / gather / deferred commit family |
| `Q` non-empty (any query path produced) | **Cached value** — run-cache / view-style reuse of the result |
| both | **both** — hybrid (upsert): effect entry **and** cacheable return if the call returns a value; conflict rules still use both path sets |
| neither | no domain tracking (untracked silent penetration) |

So “is this an effect?” / “is this a cached query?” is **derived from dynamic path production**, not free-form `provenance: "sink"` / `cacheClass: "view"` for this purpose. (Those axes may remain for other laws until unified; this stream owns the path-derived heuristic.)

### Prefix intersection

Paths overlap iff one is a prefix of the other:

- effect `["db","projects", id]` ∩ query `["db","projects"]` → **yes**  
- effect `["db","projects", id]` ∩ query `["db","projects", otherId]` → **no**

### Law (same as §0 CQS)

On a call that produces query paths \(Q\): if any **already-enqueued** effect path overlaps any path in \(Q\) → crash **before** impl.  
Writes alone with no later overlapping query stay free.

---

## 1. Current 0.9 reality (what works)

### Seams on `RunContext` (arm-or-off)

| Channel | Armed | Off |
|---|---|---|
| `cache` | Mode-law membrane interception | No record/replay |
| `effects` | Sink **gather** instead of fire | Sink fires immediately |
| `reads` | Read tracking + post-form read∩write guard | No tracking |

Chokepoint: baked rosetta `run` wrapper only.

### Gather condition

```
sink && effects !== undefined && cache?.mode !== "replay"
```

- **PRIME** (no cache or `mode: "record"`): enqueue `{ verbName, decodedArgs, enqueuedAtReadClock?, rawArgs? }`, return void.
- **FOLD** (`mode: "replay"`): never gather; tombstone path.
- **No `effects`:** fire immediately.

### EffectLog vs RunCache

| | EffectLog | RunCache |
|---|---|---|
| Shape | Append-only sequence | Content-keyed Map |
| Duplicates | Two entries always | Tombstone once |
| Poison | Log left AS-IS on failed drain | Rejection evicts in-flight |

`MemoryEffectLog` + `burst(log, executor)`: strict index order, one pass, no retry. Mid-throw → `BurstDrainError` with remaining. **No** conflict comparator inside core (header states unbuilt).

### Mode law / axes

Lineage role `sink` ⊥ cache class (`view`/`pure`/absent). Sinks use gather + optional effect tombstone, not value cache.

### Read-guard

A burst must not read its own deferred write. `enqueuedAtReadClock` fencepost is load-bearing. Host-injected `writeSetOf` may abstain.

### Region scope

Reverse lambdas re-enter under live `runCtx.effects` — closes burst-bypass. Post-return sinks forbidden.

### MCP consumer (T0–T2)

Gather → hold whole burst if any risky → confirm-burst with `RigAlteredCheck`. **Default `noRigAlteredCheck` always unaltered** — T2 honesty, not T3 world-safety.

### What 0.9 can claim

T0 gather + ordered drain; T1 re-fire captured invocations; T2 human confirm when MCP wired. **Not** T3 world-safe confirm or T4 atomic CRDT commit.

---

## 2. Unbuilt (conflict re-exec)

| Piece | Today | Needed |
|---|---|---|
| Conflict / rig-altered comparator | Seam only; default no-op | Real re-derivation vs current world |
| Re-execution policy | Manual re-issue | Spec: re-derive / refuse / force |
| Atomic drain + rollback | No core rollback | Host liminality / transact |
| Uneval-powered re-derive | Stub | Depends on buildUneval e2e (postponed for MCP) |

**Conflict** = world that motivated a gathered effect is no longer the world against which firing is sound (peer edit, re-fetched view, concurrent session).

---

## 3. Proposed post-0.9 semantics

### Layer split

```
HOST: atomicity, CRDT, RigAlteredCheck, product policy
        ▲
ARRIVAL CORE: gather, clocks, burst order, poison, mode law, region, seams only
```

Core does not import plexus. Comparator injectable like `writeSetOf`.

### Lifecycle

1. Prime: views fire; sinks gather; read-guard per form.
2. Pre-commit: non-risky drain now; risky → hold entire burst.
3. Manifest freeze: verb, decodedArgs, invocationSource, lineage, risky.
4. Confirm gate (NEW): per row in order — comparator → fire / refuse / re-derive.
5. Post-fire: tombstones; poison does not self-truncate log.

### Comparator (conceptual)

```ts
type EffectConflictVerdict =
  | { kind: "ok" }
  | { kind: "altered"; detail: string; recovery: "refuse" | "rederive" | "rerun-program" }
  | { kind: "unknown" }; // must not claim ok
```

Default for OSS without channel: refuse or hold — never silent ok if product claims T3.

### Re-exec policies (first ship: A+B+C only)

| Policy | Behavior |
|---|---|
| A. Refuse | Door that row |
| B. Whole-program re-issue | Drop pending; re-run expr |
| C. Minimal re-fire of captured source | `execState(invocationSource)` |
| D. Re-derive args | Uneval / cone — after W3 green |
| E. Force-fire with ack | Explicit override only |

### Not the same as γ-replay

γ freezes the past. Conflict re-exec is about the **live** world.

---

## 4. Interactions

- **sink** role only triggers gather; void output bake-gated.
- Confirm fire: throwaway run with `effects` unset, shared cache in record mode.
- Read-guard ≠ conflict comparator (same-run deferral vs between-hold-and-fire world drift).
- Prefer one host Footprint vocabulary for both.

---

## 5. Honesty tiers

| Tier | Claim | Status |
|---|---|---|
| T0 Gather only | Defer + order | **0.9** |
| T1 Host fire | Re-fire captured | **0.9** (MCP) |
| T2 Human confirm | Risky waits | **0.9** where wired |
| T3 World-safe confirm | Refuse if rig moved | **unbuilt** |
| T4 Atomic commit | One CRDT unit | **unbuilt** |

---

## 6. Non-goals (first effects ship / 0.9)

No production comparator code in 0.9; no core plexus; no durable multi-run EffectLog CRDT; no uneval re-derive until flagship e2e; no post-return sinks; no dedupe gather; no marketing T3/T4 early.

---

## 7. Phases when we return

0. Document + claim audit (this draft)  
1. Footprint vocabulary + optional sink⊥cacheClass bake door  
2. Real `RigAlteredCheck` for studio/MCP host (T3)  
3. Atomic drain (T4)  
4. Re-derive (policy D) after uneval e2e  
5. Multi-family `arrival-effects` content keys (optional)

### Open questions for V

1. Default when no comparator: refuse-all risky vs current always-ok stub?  
2. Partial approve under T4: whole region or subset atomic?  
3. sink ⊥ cacheClass: bake error or education only?  
4. Core world-version clock at enqueue, or host-only identity?  
5. Force-fire: human-only or model-exposed?

---

## 8. Bottom line

0.9 has complete **gather** and **ordered-fire primitive**. Conflict re-exec is Stage N+1. Honest product surface today: **T0–T2**.
