# The test suite — the decoder's correctness argument

**One guarantee:** *a candidate token is admitted iff appending it keeps the program a valid, bound,
well-shaped tool-call.* The suite proves this bottom-up. Read top to bottom, the files below are that
argument in order — each is one load-bearing sentence.

> Audited 2026-06-24: **zero redundancy.** Every suspected-duplicate pair turned out to guard a
> distinct failure mode (see *Why nothing is redundant*). The suite was never a pile of random checks —
> it was a lean proof told out of alphabetical order. This file is the order.

## How to read it

Each test has a **layer** (which part of the system) and a **proof-type** (how it proves):

| proof-type | the failure it catches |
|---|---|
| `contract` | the gate admits the **wrong set** — pure logic on hand-built input |
| `e2e` | the logic is right but **doesn't reach the path** (a wiring / stamp / lens break) |
| `parity` | two execution paths **silently diverge** (a perf path ≠ the reference) |
| `pin` | a **specific observed corruption** returns (or a fix over-corrects) |
| `kernel` | the **composed predicate**, driven adversarially |

**Where they run.** Default `__tests__/` is model-free and gates CI. Model-backed proofs are opt-in and
live in `__benchmarks__/ · __research__/ · __custdev__/ · __browser__/`; proof-of-concept spikes (NOT a
gate, loud-skip when their artifact is absent) live in `__experiments__/` (the output-kind taxonomy is
`.claude/rules/tests.md`). The layer below is the *orthogonal* axis — what each test protects.

## The stack

### Layer 0 — Atoms · the primitives every gate builds on
- `scheme-atoms` `contract` — trailingAtom / isLiteralValue / isLiveSymbolPrefix / leadingAtom / setDifference (incl. the partial-number rule that keeps a tokenizer-split `-11` a number).

### Layer 1 — Gates · each admits EXACTLY its set
The constraint math. Each gate has a logic `contract` and an `e2e` proof it fires through the real path.
- **Σ (bound-symbol):** `sigma` `contract` · `scalar-string-exemption` `e2e` (Option C — an unbound bare word is legal only at a string slot) · `negative-number-literal` `pin` (a split `-` survives Σ as a number-in-progress).
- **Structural (grammar / type):** `tool-call-grammar` `contract` (quote-forcing + phantom-`(list …)` veto) · `structure-contract` `contract` (array-vs-scalar list-structure logic) · `structure-gate-e2e` `e2e` (fires through the lazy mask; also pins the typed scanner stays session-less, so the gate can't silently disable on the perf path) · `element-gate-e2e` `e2e` (CUT A — force-quote free-form elements, narrow enum members). *These gates are pinned **model-free via a mock `AsyncTypeLens`**. (A `tsgo-fusion` POC once ran them over a real wasm-TS lens; it was removed with the `arrival-lsp-tsgo` package.)*
- **Invocation-shape (profiles):** `kwargs-profile` `contract` · `positional-keyed-profile` `contract`.
- **Gate interaction:** `scalar-enum-integration` `pin` — the live LFM2 corruption (`route_type→#f`, `time_frame→(list …)`, …). RED encodes the bug; GREEN guards against a naive fix over-correcting (the reachability arm keeps `(car …)`/`(first …)` admitted).

### Layer 2 — Composer · the gates run in the right order
- `feasible-kernel` `kernel` — `isCandidateLive` composes every gate (repeat / operator-slot / keyword-advance / structure / Σ / phantom-list / closeable), adversarially, in isolation.
- `constraint` `contract` — the eager `compileMask` aggregation against the **real** oracle (structural + Σ-live + graceful degrade when no env is bound).

### Layer 3 — Path equivalence · every perf path ≡ the reference
The architecture chose redundant paths for speed; these are the equivalence tax.
- `lazy` `parity` — lazy top-K ⊆ eager `compileMask`, identical greedy argmax, O(K) not O(vocab), non-hang fallback.
- `session-parity` `parity` — session-resume ≡ stateless re-scan (classifier verdicts + processor kept-set).
- `session-perf` `parity` — the session path is actually O(candidate), as a call-count assertion (not wall-clock).
- `select-constrained-step` `e2e` — the single shared decision both decoders call; *requires* slotState threading into the structure gate.
- `step-explain` `parity` — the metrics bucketer ≡ the mask (explain can't lie about what was masked).

### Layer 4 — Strategies · search the admitted set correctly
- `rollback-strategy` `contract` — backtrack search correct, K=0 ≡ greedy (model-free, via `ScriptedDecodeBackend`).
- `rank-candidates` `contract` — the pure autocomplete ranker.
- `force-emit-singleton` `contract` — a forced-singleton slot emits the exact tokens (the spike-gate).

### Layer 5 — Metrics · report what actually happened
- `misprediction-postform` `pin` — G3: post-first-top-level-form padding is excluded from the headline denominators, not dropped.
- (`step-explain`, Layer 3, is the no-drift anchor that makes the metrics trustworthy.)

### Layer 6 — Measurement trust · the *eval itself* doesn't lie
- `ab-stats` `contract` — A/A must be inconclusive (no manufactured winners).
- `gage-rr` `contract` — the variance decomposition.
- `sampling` `contract` — tempSample + pass^k.
- `namespaced-correctness` `contract` — the cross-scheme correctness scorer is sound.
- `measurement-trust` `e2e` — Stage-0 metric qualification, model-backed (`__benchmarks__`).

### Layer 7 — Real models · it works end-to-end (opt-in, model-backed)
- `loop-parity` `parity` — the decode loop ≡ the reference (`__benchmarks__`).
- `pickconstrained-structure-gate` `e2e` — the structure gate threads the **real** llama greedy core (`__benchmarks__`).
- `runner-benchmark` — throughput, llama.cpp vs onnx (`__benchmarks__`).
- `misprediction-metrics` · `quant-ranking-study` — the misprediction + quant×model studies (`__research__`).
- `materialize` (`__custdev__`) + `materialize.browser` (`__browser__`) — the materialize eval, node + real browser.

### Layer 8 — Anti-rot · contract / infra / docs don't silently drift
- `contract-parity` `contract` — the arrival↔sampler interpreter contract (the 2 root imports + the 5-field oracle-state mirror).
- `chat-template` `contract` — per-family prompt rendering (`renderPrompt`).
- `docs-freshness` — the package docs don't reference removed things.
- `vitest-config-integrity` — the vitest configs are well-formed, so no test silently skips.
- `palettes` `contract` — the action-palettes POC surface (`__research__`).

## Why nothing is redundant

The audit scrutinised the obvious suspects and found each guards a different failure:

- **`structure-contract` vs `structure-gate-e2e`** — logic-bug vs wiring-bug. The contract tests the gate function on hand-built state; the e2e tests it firing through `narrowByTypeAsync` → lazy processor → real oracle, and pins the no-session invariant the contract can't see.
- **`scalar-enum-integration`** is *not* subsumed by the structure contract — its GREEN reachability cases would fail a naive structure-gate-only fix, so it guards the *interaction* of structure + Σ-exemption + reachability + the transition stamp.
- **`feasible-kernel` / `constraint` / `lazy`** — gate-logic vs eager-mask-aggregation vs lazy-top-K. Three different things break them.
- **`select-constrained-step` / `session-parity` / `lazy`** — the shared-decision unit contract, the e2e session≡rescan parity, and the (historical) lazy top-K correctness (now unified).

Folding any of these re-opens a hole. The suite is already minimal — the only thing missing was this map.
