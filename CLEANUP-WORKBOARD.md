# Arrival cleanup — orchestration workboard

**Status:** POST-GO-WAVE. The 2026-07-24 go-wave (M1–M6 + W8) **landed and was committed** — `packages/arrival/` worktree is clean as of 2026-07-28. Several streams this board tracked as "landed, awaiting commit" (README refresh, R7RS doors, ambient bare-fn cleanup, buildUneval e2e) shipped in commits `7ee0f9d88b` / `2fd9f03245` / `a5c1144bd1` and later; §0, §10, §12, §13 below still describe the pre-landing state and need re-reading against the tree before acting on them.
**Parked design (full write-up):** `packages/arrival/docs/design-history/resource-paths-cqs-DRAFT.md` (committed in `a5c1144bd1`; `effects-conflict-reexec-DRAFT.md` likewise).
**Package focus:** `packages/arrival` (siblings only where named).
**Last updated:** 2026-07-28 (status sweep after independent in-depth audit confirmed go-wave is committed; see §10).

This file is the durable handoff: postponed work, next stages, code-debt list, expanded semantic-delta plan, and the **implementation DAG** for parallel agents. Prefer updating this file over re-deriving from chat.

---

## 0. Framing corrections (locked)

> **2026-07-28 audit:** rows marked ✅ below were verified fixed in code (and, where a README claim was involved, in the README) by the 2026-07-24/25 go-wave commits. The "Wrong reading" column is retained as history. Unmarked rows are still live.

| Topic | Wrong reading | Correct reading | Status |
|---|---|---|---|
| Dual interpretation | “Two interpreters always run” | **Structural promise of a second reading**: provenance layer can be re-run / armed when needed (**lazy** on the provenance plane). Value plane is the default hot path. | live |
| Numeric tower | “bigint-backed rationals” | **Safe-integer ratios** (`AExact` num/denom as JS safe integers). Host `bigint` is **not** a Scheme number; membrane must **ban** raw bigint (door). Full tower integration is not promised. | ✅ README wording already correct (`README.md:129-130`); bigint membrane ban still tracked as W2 |
| `buildUneval` | Assumed working from README | Flagship; needs **in-depth validation** that the closed loop fully works. Retrospective half lives in `arrival-provenance`. | ✅ e2e suite now exists (`arrival-provenance/src/__tests__/build-uneval.e2e.test.ts`, 6 `it` blocks); more coverage may still be wanted but "zero tests" is no longer true |
| Bare `exec` + defines | Realm-cached shared root (README Security) | **Fixed:** `scope ?? LexicalScope.fresh()` per call. Accumulation is **opt-in**. README claim is STALE — remove. | ✅ README `Security Status` already states fresh-scope-per-call (`README.md:407-412`); code matches at `generator-exec.ts:348` |
| Ambient host fns | “None” | Bare-fn survivor path still exists in evaluator; **must clean up**. | ✅ **Runtime survivor gone** (W8): `ACallable.ts:295` throws on bare host fns, `AmbientRuntime.ts:212` refuses at bind, `hostFnToCallable` is the sanctioned lens. ⚠️ **Type residue remains:** `__fn__: Function` in `Macro.ts:52,62` / `Syntax.ts:58,73` (D3 type half). |
| Complex numbers | Maybe migrate to DoorProcedure | **Keep as-is:** unsupported at **grammar**; parser door already. Agents do not ride complexes. | live |
| `bigint->number` | Maybe bind as Scheme verb | **Host helper / codec only.** Scheme is not aware of bigint. | ✅ live; note the `bigintToNumber` host helper at `rosetta.ts:529` is itself **never called** (only cited in error strings) — delete candidate. |
| R7RS silent names | Staged dooring | **Door all now.** | ✅ W4b doors landed (`2fd9f03245`) |
| **`strict` / chibi** | Single chibi run under default loose | **Run chibi twice, different expected outcomes.** (1) **strict** = R7RS goldens (pass where faithful). (2) **loose** = product tolerances — a **fail-if / mode-split registry**: forms whose outcome *must differ* by mode (e.g. `(car '())` throws strict, soft loose) pin both sides so neither tolerance nor faithfulness regresses silently. Today harness is mostly default `strict:false` with permanent it.fails for nil-tolerant car/cdr — dual-run is the proper architecture. | live (M5) |
| **Vectors / lists / listalike** | Spine-adopt host arrays into pairs | **Vectors preferred** for host/tool data; **cons is Scheme-native**. Loose processes **vectors as lists where applicable**. **No listalike campaign** — do not default array→pair spine; rare native-only exceptions. | ✅ campaign cancelled (confirmed clean) |
| Effects / CQS resource paths | **PARKED** — full design written | See `docs/design-history/resource-paths-cqs-DRAFT.md`. **Do not implement until go-wave closed.** | live — go-wave closed, but design stays parked for post-0.9 (DRAFT files committed in `a5c1144bd1`) |
| MCP confirm-burst uneval | Wire now | **Postpone** until uneval e2e is proven. | live — e2e suite now exists; re-evaluate entry criteria |
| Manifold benchmark audit | — | **Postpone.** | live |
| Comment cleanup | More docs | **Less comments**, production-writing law; Stage-C journal kill after extract. | live (W13 in flight — wave 2 landed; residual: `W8` tag leak, journal preambles in `inference-env.ts`/`typecheck.ts`/`uneval.ts`) |
| Academic lineage | Brag / museum | **npm-for-ideas**: short pin, offload ontology. | live |
| Consciousness / IFS | — | **Must not appear** in arrival package (confirmed clean). | ✅ confirmed clean |

---

## 1. Postponed / next stages (do not lose)

### Stage N+1 — after current 0.9 honesty tracks

| Item | Why postponed | Entry criteria | Rough shape |
|---|---|---|---|
| **Effects model + conflict re-exec** | Not product surface for 0.9 | Impl doc written (see §5); 0.9 shipped | Burst drain, conflict comparator, re-execution semantics |
| **MCP confirm-burst real uneval** | Depends on flagship e2e | `buildUneval` round-trip green | Replace `noRigAlteredCheck` stub |
| **Manifold / MCP-Atlas audit** | Separate product review | Bandwidth after interpreter honesty | Methodology + claim integrity |
| **Freedom-to-go Phase 2 (macros)** | Hard block; not first ship | Phase 0 inventory + Phase 1 semantic-delta decisions | pre-L1 hygiene, ellipsis, `_`, vector patterns |
| **Freedom-to-go Phase 3 (portable profile + lint)** | Needs inventory | Phase 0 artifact A live | `BASE_ROSTER_PORTABLE`, strict gates on `[]`/`{}`, free-name lint |
| **buildUneval Phase 3 (frozen-ingress re-run)** | Product decision: live vs frozen | Phase 1 pure round-trip green + S2 spike | Hermetic re-exec for port-bearing slices |
| **buildUneval Phase 4 (intra-form least slice)** | Top-level-form minimality enough first | Product demand after e2e | PDG-depth slice |
| **Comment quality full campaign** | After extract gate | Orphan invariants promoted to laws/docs | Stage-C journal kill; plexus density |
| **Dialect zoo expansion** | Anti-goal | Never as completeness cosplay | Top phantoms only if measured |
| **Mercury / type-lens / CodeMirror polish** | Satellite relative to core honesty | After hermetic + uneval trust | Human co-author + LSP dual role |
| **Multi-tenant “harden default scope”** | Code already fresh-per-call | — | Only enforce: don’t share one `scope` across tenants |

### Stage research-only (no impl commitment)

| Item | Output |
|---|---|
| Strict-mode divergence ledger (Class A) + Class B forks | Harvest `strictGate` sites; only protocol forks need rename disposition |
| Listalike residual map | **Cancelled** — vector-as-list under loose; no spine-adoption push |
| Chokepoint verification Waves A–D | Status: confirmed / residual / doc-lie / broken |
| Effects impl document | Design for post-0.9, not code |

---

## 2. Code debt register (for later today — write-only now)

Do not fix in prep agents; track for the dedicated debt pass.

| ID | Debt | Location hints | Severity |
|---|---|---|---|
| D1 | ~~`ctxOf` is no-op after `AValue.ctx` removal~~ **RESOLVED 2026-07-28** — `ctxOf` deleted; 9 call sites + scheme-zod container codecs pass `CONSTANT_CTX` explicitly (inert — `heapMeter === undefined`). The `to_array` dead meter branch was deleted. **Restoring metering is a separate deliberate phase** (threads the crossing's `RunContext` into the charge sites); the skipped laws `scheme-zod-container-heap.law.test.ts` pin the target behavior. | `values/primitives/AValue.ts` (deleted) | ~~Med~~ done |
| D2 | `__arrivalRunResolver` ambient back-channel | `eval/evaluator.ts`, require/membrane readers | High — concurrent/hermetic smell (resolver stays for `require`; the `currentRunEnv` reader was deleted 2026-07-28 as zero-consumer) |
| D3 | Bare JS function apply survivor | `evaluator.ts` Reflect.apply path | ~~High~~ **runtime RESOLVED (W8)** — `applyCallback` throws on bare host fns; **type residue RESOLVED 2026-07-28** — `Macro`/`Syntax` `__fn__: Function` → precise `MacroTransformer` type |
| D4 | ~~`freezeRosettaReturns` may be dead (always freeze)~~ **RESOLVED 2026-07-28** — field + plumbing deleted from `RunContext`/`assemble-run`/`generator-exec`; `freezeSource()` always freezes; README + `docs/membrane.md` updated. | `AJSObject`/`AJSArray`, ~~RunContext~~ | ~~Med~~ done |
| D5 | `modeKeyOf` always `"mem"` | `membrane/rosetta.ts` | Low — intentional scaffolding (single classification site + `_modeKeyExhaustive` guard); documented at `rosetta.ts:48-55`. Kept. |
| D6 | Nil dual identity residual (`=== nil` sites) | `identity.law.test.ts`, grep | Med if production residual |
| D7 | Listalike / spine adoption expansion | `listalike-*.law.test.ts` | **Deprioritized** — only fix real hangs; no adoption push |
| D8 | Contour/crossing brand education gaps | `_bake.ts`, scheme-zod, host authoring | Med DX |
| D9 | Dangling `docs/plans/*` cites in comments | generator-exec, capability, interop-access | Hygiene |
| D10 | `CompiledResolutionChain` / comments still say `defaultLexicalRoot` | eval | Doc-smell |
| D11 | Effect-log conflict re-execution unbuilt | `run/effect-log.ts` | Deferred to effects stage |
| D12 | Uneval retrospective has no e2e tests | `arrival-provenance/analysis/uneval.ts` | Flagship — validation stream |
| D13 | Complex as native always-throw vs DoorProcedure split | numeric + parser | Locked: grammar door only |
| D14 | Host bigint membrane passthrough | rosetta / boxing / membrane | Fix stream: ban |
| D15 | Op registration / role stamp holes | harvest + provenance roles | Chokepoint C1 |
| D16 | Dual-plane arming confusion (tap vs eager oracle vs silent) | provenance-hooks, op-helpers | Documentation + verification |
| D17 | Shared-scope multi-tenant only if host shares `scope` | docs honesty | Doc fix only |

---

## 3. Active workstreams (summary)

| ID | Stream | Prep | Impl |
|---|---|---|---|
| W1 | Doc/code drift (README security, bigint wording, uneval import, provenance ownership) | Inventory done | Patch docs only |
| W2 | Membrane bigint ban (+ unique-symbol confirm) | Path map done | `NoLensError("bigint")` |
| W3 | buildUneval validation (in-depth) | Closed-loop inventory spike | e2e suite + fix failures |
| W4 | R7RS silent → door all now | Name list harvest | Pack doors only |
| W5 | Doors MVP hygiene (bytevector-fill!, purity table, dual-path idiom) | Inventory done | Small pack + law edits |
| W6 | Divergences: **dual chibi** (strict golden + loose fail-if subset) + Class B forks | strictGate map → mode-split registry candidates; harness dual-run design | Implement dual chibi harness + fail-if registry; Class B later |
| W7 | Listalike | **Deprioritized** — vector-as-list under loose; no spine-adoption push | Only bugfix hangs/silent-wrong if any; no expansion |
| W8 | Ambient bare-fn cleanup | Map call sites | Remove or quarantine survivor |
| W9 | Chokepoint re-audit Waves A–D | Verification only | Fixes only if P0 found |
| W10 | Effects impl document (not code) | Read effect-log + mode law | Markdown design only |
| W11 | Contour/crossing education | Inventory error messages / types | Doc snippets for authors (minimal) |
| W12 | Freedom-to-go Phase 0 inventory | Harvest extensions | Artifact A only |
| W13 | Comment density rework (production-writing) | Guidelines: `docs/design-history/comment-density-STRATEGY.md`. Fleet waves 1–2 (no auto-scrub): **~28–40%+ comment-line cut on production `src/`** (remeasure). Residual: generated carriers text, tests. | **IN FLIGHT — wave 2 landed** |
| W14 | Code-debt pass | This register | Later today with human |

---

## 4. Divergences from R7RS/SRFI — two classes (maintainer clarification)

### 4.0 Key insight (locked)

**Default mode is intentionally tolerant** (zimmerframe / polyglot): models do `(car vector)` expecting first element; R7RS would throw; we handle it unless **`strict` is on**.

### Dual chibi-alike runs (locked architecture)

Same **corpus + harness shape** (chibi form split, sequential env, registries), **two passes**, **two goldens**:

| Pass | Mode | Golden | Role |
|---|---|---|---|
| **A — strict** | `strict: true` | **Chibi / R7RS** — ride the chibi expected outcomes | Spec faithfulness |
| **B — loose** | `strict: false` (default) | **Current Arrival loose behavior** (“golden loose”) | Product / zimmerframe — pin what we ship |

#### Mode-split forms (e.g. `(car '())`, `(cdr '())`)

| Mode | Expected | How tested |
|---|---|---|
| **strict** | throws (R7RS) | Pass A — **ride chibi** (`test-error` / equivalent) |
| **loose** | returns **nil** (today) | Pass B — **explicit assertion** under chibi-alike setup, golden = current loose |

Same pattern for **every** intentional tolerance: strict side from chibi; loose side pins **present behavior** so tolerance cannot regress silently (throw again = red).

#### Fail-if / anti-vacuity

- Pass A: if a chibi-pass form starts failing, or a chibi-error form starts succeeding wrongly → red (faithfulness).
- Pass B: if a **golden-loose** form changes outcome (e.g. loose `car` of `()` throws again) → red (tolerance regression).
- Forms that are **wrong even as product** (bugs, not tolerances) are not golden-loose — fix or `it.fails` with reason.

#### Misalignment inventory (required companion)

Golden-loose is **descriptive**, not a claim of spec identity. Alongside dual runs, maintain an explicit ledger:

> **Loose vs R7RS/chibi misalignments** — for each mode-split (and any loose-only divergence): form, loose outcome, strict/chibi outcome, `strictGate` site if any, intentional? yes/no.

That ledger *is* “what we support in addition to the spec.” Code gates + this table; no essay docs required beyond the registry.

#### What dual-run is not

- Not re-running full chibi expecting **pass** under loose (many R7RS error cases are soft under loose by design).
- Not inventing a second non-chibi strict unit suite.
- Loose-only idioms **outside** the chibi corpus (vector-as-list, polyglot) still need separate product tests — same golden-loose spirit, not always a chibi form.

#### Today’s debt

`registries-srfi1.ts`: harness never passes `strict: true`; car/cdr-empty are permanent `EXPECTED_FAILURES` under default loose. Dual-run **replaces** “fail forever under wrong mode” with Pass A (chibi throw) + Pass B (assert nil).

**`strictGate` grep** → candidates for the misalignment inventory + fail-if / golden-loose rows.

Mechanism:

```ts
// errors.ts — PortabilityError + strictGate
// loose/strict (R7RS-portability) divergence
```

### 4.1 Class A — **Tolerances** (loose product; strict = chibi)

| Examples | Loose golden (pin current) | Strict (ride chibi) |
|---|---|---|
| `car`/`cdr` of `()` | returns **nil** (explicit test) | throws (chibi `test-error`) |
| `car`/`cdr` / list-ish on vectors | polymorphic first-element (if current) | R7RS / PortabilityError |
| Numeric compare with nil | soft (if current) | reject non-number |
| Reader recoveries | as shipped | R7RS-only |

**Work item:**

1. **Dual chibi-alike harness** — Pass A strict=chibi goldens; Pass B loose=**current behavior goldens**.
2. **Misalignment inventory** — every intentional loose≠spec row (start from `strictGate` + known car/cdr-empty).
3. Mode-split: for each inventory row, Pass A rides chibi; Pass B asserts golden loose (e.g. nil).
4. Loose-only idioms not in chibi — same golden-loose product tests.
5. Migrate permanent EXPECTED_FAILURE under wrong mode into dual expectations.
6. Do not rename `car` / force pair spines.

**Success for Class A:**  
Pass A green vs chibi; Pass B pins golden loose with anti-vacuity; misalignment inventory lists every intentional spec gap.

### 4.2 Class B — **Protocol forks** (same name, wrong contract in *both* modes)

Behavior that is **not** a loose/strict split: the binding implements a **different function** under a standard name. Strict does not restore the standard.

| Examples | Why Class B |
|---|---|
| `unfold` Arrival pair-step vs SRFI-1 `(p f g seed)` | Arity/protocol differ regardless of strict |
| `vector-fold` 2-arg kons vs SRFI-43 index-first | Same |
| `reduce` seed-from-knil vs SRFI-1 seed-from-car | Same (if both modes share one impl) |
| Multi-value forms as pair products (`span`, `floor/`) | Product policy; not a strict toggle |

**These still need disposition** (ALIGN / RENAME / DOOR / DOCUMENT-PERMANENT for multi-return product family) — but they are a **small critical set**, not the same problem as “models car vectors.”

**Work item:** keep the prep harvest for Class B only; human disposition on critical rows. Do not conflate with Class A inventory.

### 4.3 Class C — **Silent absence / doors**

Missing standard names (W4 door-all-now) and purity doors — not deltas; separate stream.

### 4.4 Class D — **Extras** (non-standard names)

`first?`, `range`, `any?`, `@`, `dict`, polyglot verbs — extension inventory (freedom-to-go Artifact A), not semantic-delta.

### 4.5 Freedom-to-go / testing interaction

| Profile | What it means |
|---|---|
| Default agent run | **loose** + polyglot — zimmerframe |
| R7RS golden | **Chibi Pass A under strict** |
| Tolerance anti-vacuity | **Chibi Pass B loose** + fail-if subset |
| Loose-only idioms | Product tests outside chibi |
| Neg-space | Chibi rows as `it.fails` / EXCLUDED with reason |
| Class B forks | extension lint + disposition — **chibi/strict cannot fix `unfold` protocol** |

### 4.6 Prep procedure (Class A)

1. Background: grep `strictGate|runCtx.strict` → map of loose extras (completeness / missing gates).
2. Primary: inventory **loose-mode tests** that exist vs gaps (agent idioms).
3. Cross-check chibi registry: intentional divergences are `it.fails`/EXCLUDED, not accidental red/green.
4. Do **not** build a second full strict unit suite that re-implements chibi.

### 4.7 Prep procedure (Class B — residual)

Only names where **strict/chibi cannot restore** the standard protocol (`unfold`, `vector-fold*`, …). Small disposition set.

### 4.8 Listalike — deprioritized (V ruling)

**Do not invest in listalike / spine-adoption as a product path.**

- Loose mode already treats **vectors as lists where applicable** (tagless / polymorphic ops).
- Host/tool arrays stay **vectors**; no default “array → pair list” conversion.
- Turning arrays into lists is **rare**: mainly when a **native** Scheme path must produce a true pair spine differently; not the Rosetta/tool default.
- W7 (listalike residual / re-chart campaign) is **cancelled or minimal** — only fix real hangs/silent-wrong bugs if any remain under vector-as-list loose semantics; do not expand `listAlike` adoption surface.

Vector-preferred ingress + loose list-ops-on-vector = the design. Cons remains Scheme-native for true lists.

---

## 5. Effects model — deferred impl document outline

**Not 0.9.** When written (W10), cover:

1. Current: `EffectLog` enqueue on sink under non-replay; `burst` ordered drain; no conflict re-exec.
2. Mode law interaction with cache classes.
3. Region scope vs burst (no post-return sink).
4. Proposed conflict comparator + re-execution semantics.
5. Failure modes / honesty tiers if re-exec diverges.
6. Explicit non-goals for first effects ship.

---

## 6. Implementation dependency DAG

### Legend

- **→** must finish before  
- **∥** may run in parallel  
- **[prep]** audit/inventory only  
- **[impl]** code/docs change  
- **[review]** human decision gate  

### Nodes

```
                    ┌─────────────────────────────────────┐
                    │  W1 [impl] Doc drift (README lies)   │
                    │  no code deps                       │
                    └─────────────────────────────────────┘

                    ┌─────────────────────────────────────┐
                    │  W2 [impl] Bigint membrane ban      │
                    │  independent of W1 (coord messages) │
                    └─────────────────────────────────────┘

  W9A [prep] Chokepoint Wave A (assembly/session/ambient)
  W9B [prep] Chokepoint Wave B (membrane/nil/listalike/brands)
  W9C [prep] Chokepoint Wave C (roles/cache/replay/arming)
         │
         └→ W9D [prep] Synthesis status table
                │
                └→ (optional fix tickets; not pre-scheduled)

  W3a [prep] buildUneval closed-loop inventory (S1)
  W3b [prep] hermetic composition spike (S2)     ∥ W3a
         │
         └→ W3c [impl] docs honesty (import/options)  ∥ can start after W3a starts
         └→ W3d [impl] e2e round-trip suite + fixes   ← after W3a findings
         └→ W3e [impl] verdict re-exec               ← after W3d pure green
         └→ W3f [later] frozen-ingress path          ← after W3b + product pick live vs frozen

  W4a [prep] R7RS silent name harvest
  W4b [impl] door-all-now packs                      ← after W4a (or same agent if list short)
  W5  [impl] Doors MVP (bytevector-fill!, purity table, idiom dual-path)  ∥ W4b

  W6A [prep] Harvest strictGate / runCtx.strict sites → Class A ledger
  W6A-impl [impl] Fill missing gates + dual loose/strict laws; fix unfaithful strict branches
  W6B [prep] Class B protocol forks only (unfold, vector-fold*, …)
  W6B-review [review] V disposition on Class B only
  W6B-impl [impl] ALIGN/RENAME/DOOR per disposition   ← after W6B-review

  W7  [cancelled] listalike expansion — only opportunistic hang fixes

  W8a [prep] Bare-fn call-site map
  W8b [impl] remove/quarantine ambient host fns      ← after W8a; careful with registry survivors

  W10 [prep/doc] Effects impl document only          ∥ anything; no code

  W11 [prep] Contour/crossing education inventory    ∥ 
  W11b [impl] minimal author-facing notes            ← after W11; do not bloat

  W12 [prep/impl] Freedom-to-go Phase 0 inventory    ∥ W6a (overlap: share harvest scripts)
         │
         └→ Phase 1–3 postponed (see §1)

  W13 Comment scrub                                  ← after W12 extract + W9 if needed; STAGE LATER

  W14 Code-debt pass (this register §2)              ← human-led later today; after or ∥ small streams
```

### Parallelism matrix (what can start together)

| Wave | Parallel nodes | Isolation reason |
|---|---|---|
| **P-now** | W1, W2, W3a, W3b, W4a, W5, W6A, W7a, W8a, W9A, W9B, W9C, W10, W11, W12 | Prep or tiny independent impl |
| **P-after-prep** | W3d (needs W3a), W4b (needs W4a), W6A-impl (loose tests / gates), W6B-impl (needs review), W8b | No W7 campaign |
| **P-serial-soft** | W3e after W3d; W9D after A–C | Synthesis |
| **P-later** | W3f, W13, effects impl, MCP uneval, manifold, macros Phase 2 | Stage N+1 |

### Hard constraints

1. **Class A:** default is loose; audit that **strict is R7RS-faithful** and every intentional tolerance is `strictGate`d (code is the ledger).  
2. **Class B:** do not implement renames until V disposition; do not mix with Class A.  
3. **Do not** implement effects code in 0.9.  
4. **Complex:** grammar door only. **bigint→number:** host codec only.  
5. **Orchestrator does not implement** — spawn agents; merge findings into this board.  
6. Prefer **prep agent then impl agent** per stream when domain is large.

---

## 7. Doors rulings (locked)

| Question | Ruling |
|---|---|
| Complex | Keep grammar-level break; simple parser door; no pack migration |
| R7RS silent (`eval`, `load`, env, include, cond-expand, define-library, import, syntax-error, case-lambda, …) | **Door all now** |
| `bigint->number` | Host helper / `z.bigint` codec only; Scheme unaware of bigint |
| `bytevector-fill!` etc. | Still complete as doors (MVP W5) |

---

## 8. buildUneval validation focus (W3)

**Goal:** Confirm it **fully works**, not that code exists.

Minimum closed loop:

```
execState + tap → buildUneval({ scope, result, trace, source, forms })
  → head.program re-exec → value matches
  → unrelated defines pruned
  → points cover selector provenance
```

Known: zero tests import `buildUneval` today; README import/options wrong; port-bearing re-run may re-invoke live sources (honesty decision).

---

## 9. Freedom-to-go (MUST) — compressed

Product: migrate off Arrival to another R7RS+same-SRFI by implementing **only extension symbols**.

Phases: 0 inventory → 1 silence/doors + semantic-delta → 3 portable tooling → 2 macros → 4 CI lock.  
Phase 0–1 start now (prep); Phase 2+ postponed.

---

## 10. Orchestration log

| When | Action |
|---|---|
| 2026-07-24 | Experiment worktree dropped (comment-blind audit). |
| 2026-07-24 | This board created. Implementation DAG + postponed + debt + semantic-delta expansion. |
| 2026-07-24 | **Prep wave complete** (9 explore agents, read-only). Findings summarized in §12. No impl yet. |
| 2026-07-24 | **GO.** Decisions: O1 golden-loose car/cdr first; O4 live det + research showcase; O5 no bare-fn legacy; Class B hold; effects draft file uncommitted. Spawned parallel impl: M1 M2 M3 M4 M5 M6 W8. |
| 2026-07-24 | **Wave landed.** All 7 streams complete; cross-fix: W8 bare-fn broke member/assoc defaultCompare → fixed to structuralEqual default path. Verified: chibi-srfi1 Pass A, golden-loose car/cdr, crossing.law, build-uneval.e2e green. |
| 2026-07-24 | Resource-path CQS design fully written (`resource-paths-cqs-DRAFT.md`) + effects conflict draft. **PARKED.** Return to go-wave: review, full test, atomic commits. |
| 2026-07-28 | **Independent in-depth audit.** Go-wave verified **committed** (worktree clean); prior "landed, not committed" status was stale. 5-agent horde + main-agent verification surfaced: (a) stale workboard rows (§0/§12/§13 above — now annotated ✅); (b) dead plumbing — `ctxOf` no-op (D1), `freezeRosettaReturns` unread (D4), `modeKeyOf` constant (D5), `currentRunEnv` zero-consumer, `bigintToNumber` never-called; (c) README subpath-export list names 4 non-existent paths (`/symbol`, `/loader`, `/overridable`, `/schema`); (d) type residue of W8 (`__fn__: Function` in Macro/Syntax); (e) one real bug: `deriveSortCompare` bypasses `call_function` (SRFI-95 comparator, masked by `it.fails`). See P0–P4 fix plan in chat; changes unstaged in the working tree (user auditing before commit). |

---

## 12. Prep wave findings (2026-07-24) — ready for review / next spawn

### W1 Doc drift — patch pack ready
Exact replacements drafted for: README Security (fresh scope), numeric (safe-int), buildUneval import/options, monorepo + arrival-provenance ownership. **Ready for impl agent (docs only).**

### W2 Bigint ban
Wave B confirmed: still **passthrough**. Unique-symbol already doored. Impl brief remains prior membrane plan (`NoLensError("bigint")`).

### W3a buildUneval
- **Zero tests** import `buildUneval`. Flagship unvalidated.
- API: `@inhuman.tools/arrival-provenance/analysis`, options `{ scope, result, trace, source, forms }` (`source` unused in body).
- Prospective wire-γ well tested; retrospective closed loop is the hole.
- e2e matrix P1–P5 proposed (pure prune + README dual-source + re-exec). **Ready for W3d impl after optional W3c docs.**

### W4a R7RS silent
**13 names** to door-all-now: `case-lambda`; `load`; `eval` + 4 environment forms; `include`/`include-ci`/`cond-expand`/`define-library`/`import`/`syntax-error`. Prefer new pack `r7rs/eval` for eval family. Retarget `sandbox-unification` (today requires unbound eval/load). Complex out of scope. **Ready for W4b.**

### W5 Doors MVP
Still: `bytevector-fill!`, purity table multi-return absorb, idiom dual-path — not re-audited this wave; prior plan stands.

### W6 Divergences — **reframed (V clarifications ×2)**

**Class A:** loose = product → **test loose**. Strict = **chibi goldens** (not parallel unit suite). `strictGate` grep = map of extras. Neg-space = chibi `it.fails`/EXCLUDED.

**Class B (small):** protocol forks chibi cannot fix (`unfold`, `vector-fold*`, …).

### W7 Listalike — **cancelled as campaign**
Vectors-as-lists under loose; no array→list adoption push; rare native exceptions only.

### W8a Bare-fn
- **Intentional:** hostFn lens → ARosettaProcedure.
- **Legacy D3:** env-resident bare fn + Reflect.apply (evaluator, applyCallback); producer ≈ replay `bindRosetta` + tests.
- Hybrid cleanup: migrate bindRosetta → ACallable → door bare apply → delete arms. **Do not kill D2 in same PR.**

### W9A Hermetic
| # | Status |
|---|---|
| C3 single path | confirmed |
| RunContext isolation | confirmed |
| Session fresh default | **code confirmed; README Security doc-lie** |
| `__arrivalRunResolver` | residual (D2) |
| modeKeyOf `"mem"` | confirmed intentional |

### W9B Membrane
| # | Status |
|---|---|
| Total boundary | confirmed; Promise dual door (fromJS pass / jsToScheme door) residual |
| Exception rewrap | confirmed value path |
| freezeRosettaReturns | **RESOLVED 2026-07-28** — flag + plumbing deleted; freeze unconditional |
| Nil dual | production confirmed; ledger stale |
| Contour/crossing | confirmed; education residual |
| Listalike | campaign cancelled — vector-as-list under loose |
| Bigint | passthrough → W2 |
| README bare fn → #void | **doc-lie** (now lens) |

### W10 Effects document
Full design drafted in agent reply: T0–T2 = 0.9 honest; T3/T4 post-0.9; conflict re-exec host territory; phases 0–5; open questions for V (default refuse vs stub-ok, partial approve, sink⊥cacheClass). **Paste into board §5 or separate design note when accepted — no code.**

### Suggested next orchestration (still no self-impl)

1. **W6 dual-chibi design/impl:** Pass A strict=chibi; Pass B loose=golden-current; misalignment inventory; car/cdr-empty: strict throw + loose assert nil (see §4.0).  
2. **W6B:** Class B protocol forks only, later.  
3. **W7:** cancelled campaign.  
4. **Parallel impl (after greenlight):** W1 docs, W2 bigint, W4b doors, W3d uneval e2e.  
5. **Hold:** Class B renames, W8b bare-fn, W13 comments; effects never in 0.9.

---

## 13. Gap analysis — what else must still happen

Honest scan of the plan after all reframes. **Must / should / later / open decision.**

### Must (0.9 honesty — still not done)

| # | Gap | Why | Stream |
|---|---|---|---|
| M1 | **README / monorepo doc lies** (shared root, bigint-backed, uneval import, provenance ownership, bare-fn→#void) | Actively misleads hosts | W1 |
| M2 | **Bigint membrane ban** | Framing + security/honesty | W2 |
| M3 | **buildUneval closed-loop validation** | Flagship untested | W3 |
| M4 | **R7RS silent → door (13 names)** + sandbox-unification retarget | implement-or-door policy | W4 |
| M5 | **Dual chibi-alike harness** — strict rides chibi; loose = golden-current + explicit pins (e.g. car/cdr → nil) + **misalignment inventory** | Spec goldens + tolerance anti-vacuity; replaces wrong-mode permanent fails | W6 |
| M6 | **Doors MVP leftovers** (`bytevector-fill!`, purity table multi-return, idiom dual-path) | Subtraction product completeness | W5 |

### Should (same era, not blockers for every ship)

| # | Gap | Stream |
|---|---|---|
| S1 | ~~Bare-fn ambient cleanup (D3)~~ **DONE 2026-07-28** (runtime W8 + type `MacroTransformer`) | W8 |
| S2 | ~~Freeze flag dead API / README (D4)~~ **DONE 2026-07-28** — field deleted, docs fixed | ~~W1~~ done |
| S3 | `__arrivalRunResolver` debt (D2) — resolver stays for `require`; `currentRunEnv` reader deleted 2026-07-28 (zero-consumer) | W14 / later |
| S4 | Freedom-to-go Phase 0 extension inventory | W12 |
| S5 | Loose product tests for non-chibi idioms (vector-as-list, polyglot) — not covered by dual chibi alone | W6 adjacent |
| S6 | Contour/crossing author notes (minimal) | W11 |

### Later (board already postpones)

| # | Item |
|---|---|
| L1 | Effects / conflict re-exec (impl after doc) |
| L2 | MCP confirm-burst real uneval |
| L3 | Manifold audit |
| L4 | Macro engine (freedom Phase 2) |
| L5 | Portable profile / lint (Phase 3) |
| L6 | Uneval frozen-ingress / intra-form |
| L7 | Comment Stage-C scrub |
| L8 | Class B renames (unfold / vector-fold*) when product wants SRFI name purity |

### Open decisions still required (you)

| # | Decision | Blocks |
|---|---|---|
| O1 | **Golden-loose v1** — car/cdr-empty first, then grow | **LOCKED: yes** |
| O2 | Class B dispositions | **HOLD — do not solve yet** |
| O3 | Effects T3 default | post-0.9; draft at `docs/design-history/effects-conflict-reexec-DRAFT.md` (uncommitted read) |
| O4 | Uneval “works” | **LOCKED: live deterministic + research agent models demo showcase first**, then e2e |
| O5 | Bare-fn / legacy | **LOCKED: no legacy left** — LIPS residue and prior looser bare-fn paths cleaned in W8 (not deferred) |

### Explicitly **not** missing (closed / cancelled)

- Listalike expansion campaign  
- Second full strict unit golden suite  
- Multi-tenant default scope hardening (code already fresh)  
- Consciousness in package  
- Complex DoorProcedure migration  

### Process gap

| # | Gap |
|---|---|
| P1 | **No impl agents greenlit yet** — prep done; M1–M6 waiting on “go” |
| P2 | Dual-chibi is **new work not in original seven plans** — needs its own harness design agent before impl |
| P3 | W9C (registration/cache/replay) never ran — optional if M-streams land first |
| P4 | Effects design lives in agent output, not yet committed as durable `docs/` artifact |

### Recommended “make happen” order (compressed)

```
M1 docs  ∥  M2 bigint  ∥  M4 doors  ∥  M5 dual-chibi design
                │
         M3 uneval e2e  ∥  M6 doors MVP
                │
         S5 loose non-chibi idioms (as gaps appear)
                │
         S1 bare-fn (if 0.9) else debt day
                │
         L* postponed
```

**You are not missing a secret twelfth architecture** — missing is **shipping M1–M6** and **dual-chibi as a first-class harness**, plus decisions O1–O5 when those streams hit the gate.

---

## 11. Agent brief templates (for spawn)

### Prep brief skeleton

```
Package: packages/arrival (+ sibling if named)
Mode: READ-ONLY prep. No code changes. No git commits.
Deliverable: findings table + file:line evidence + recommended next impl agent brief.
Update: summarize for CLEANUP-WORKBOARD.md §10.
```

### Impl brief skeleton

```
Package: packages/arrival
Mode: implement only the named stream. Explicit pathspec commits if asked.
Laws: production-writing (less prose); doors teaching messages; no new dialect surface.
Do not: touch postponed streams; do not “fix adjacent.”
```
