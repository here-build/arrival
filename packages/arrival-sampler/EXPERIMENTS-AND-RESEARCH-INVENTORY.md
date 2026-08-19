# arrival-sampler — Experiments & Research Inventory

**Status**: EXPERIMENTAL package (see README banner + PAPER.md). Mixed kernel + extensive research / custdev / benchmark / experimental surface — the mix is the package's nature.

> **Layout note (post-restructure).** This inventory predates the kernel/runners/tests split;
> read its paths through this mapping: `src/__tests__/` → `tests/kernel/`, `src/__research__/` →
> `tests/research/` (findings at `tests/research/findings/`), `src/__custdev__/` → `tests/custdev/`,
> `src/__experiments__/` → `tests/experiments/`, `src/__benchmarks__/` → `tests/benchmarks/`,
> `src/__harness__/` → `tests/harness/`, `src/openai-server/__tests__/` → `tests/runners/`,
> `src/decode/` → `src/runners/local/`, `src/openai-server/` → `src/runners/server/`,
> `src/lmstudio.ts` → `src/runners/gguf/lmstudio.ts`, `src/__fixtures__/` → `src/runners/fixtures/`.
> The package itself moved `second-foundation/arrival-sampler` → `foundations/arrival/arrival-sampler`.
> The category semantics below are unchanged.

This document inventories the **series of experiments** alongside the working/production code. It follows the test categorization discipline (see `.claude/rules/tests.md` and the package's `vitest.*.config.ts` files).

The package ships a **substrate-free constrained-decoding kernel** (structural + Σ gates) plus LLM wiring (node-llama-cpp + OpenAI-compatible server) and harness integration points. Everything else is research, probes, benchmarks, or harness scaffolding.

## Stable / Working Code (ships under exports)

- **Kernel (primitive 1)**: `src/index.ts`, `mask-compiler.ts`, `select-constrained-step.ts`, `structural-gates.ts`, `profile-gates.ts`, `rules.ts`, `scheme-atoms.ts`, `sampling.ts`, `force-emit.ts`, `rng.ts`, `oracle-types.ts`, `typed-scanner-async.ts`, `step-explain.ts`.
  - Core: `isCandidateLive`, `selectConstrainedStep`, `compileMask`.
  - Fully deterministic, model-free tests in `src/__tests__/`.
  - Guarantees: structural well-formedness + Σ (bound symbol) liveness.

- **Decode / LLM wiring (primitive 2, node-only)**: `src/decode/`, `src/openai-server/`, `lmstudio.ts`, `runner/generate.ts`.
  - `makeRealDecode`, `createOpenAIServer`, model manager (on-demand, idle/LRU), render strategies (scheme/json/python-ast/tool-calls), fc-envelope, fence-preamble, think-phase, etc.
  - Exports under `./server`, `./decode`, `./lmstudio`.

- **Supporting**: `chat-template.ts`, `force-emit.ts` (re-exported), rosters.

**Core invariant**: The kernel (`selectConstrainedStep` + gates) is shared by all paths. `compileMask` is the reference.

## Research (`src/__research__/` + `vitest.research.config.ts`)

Opt-in via `pnpm research`. Produces knowledge artifacts (metrics, findings, plots).

### Active / Key Studies
- **misprediction-metrics.ts + .test.ts**: Per-token argmax vs. mask vetoes. Modes: mock (CI), smoke, real (GGUF). Surfaces: apple variants + sift.
  - Findings: `findings/baseline-pre-G3/`, `quant-ranking-findings.md`, `naming-scheme-effect.md`, `R-acceptance-G3.md`.
  - Captures pre/post structural changes (G3 = post-form-close padding gate).
- **apple-namespaced.ts**: Tests naming schemes (dei/die/eq/bang/env) on apple-intents to study branching / cognitive load / materialization order.
- **palettes.ts + .test.ts**: Action palettes API over schemes (7 schemes). Model-free checks + measuredCorrectness.
- **arity-analyzer.ts**: Arity analysis (related to call shapes).
- **gage-rr.ts + .test.ts**: Gage R&R (repeatability & reproducibility) metrics.
- **sift-surface.ts**: Sift-specific surface experiments.
- **ab-stats.ts**: A/B stats tooling.

### Python / Data
- `build-smollm2-quant-matrix.py`: Quantization matrix experiments.

### Outputs
- `findings/` directory stores summaries and baselines.
- Often write to `__research-output__/` or similar (generated artifacts).

**Status**: Most are "store and reference" — results fed back into kernel improvements (gates, naming, quant handling).

## Custdev (`src/__custdev__/` + `vitest.custdev.config.ts`)

"Customer development" / interactive probes. Opt-in (`pnpm custdev` or `test:llm-*` with `LLM_ROSTER`).

- `probe.test.ts`: Reusable debug probe for "what does model want at this decode point?". Config via env (LLM_ROSTER, PROBE_PREFILL, etc.). Outputs to `__fc-output__`.
- `fc-envelope-run.test.ts`, `fc-fence-probe.test.ts`, `fc-roster-smoke.test.ts`: Function-calling envelope / fence / roster smoke tests against real models.
- `materialize.test.ts`: Materialization probes.
- `abstain-prefill-probe.ts`: Abstain / prefill behavior.

**Purpose**: Quick experiments against real LLMs (glm, etc.) before promoting to research or kernel.

## Experiments

Proof-of-concept spikes. Must loud-skip (per rules) if dependencies/artifacts absent.

**Status**: Empty. The sole entry, `tsgo-fusion.test.ts` (sampler running over the wasm-built-TypeScript `tsgo` lens), was removed with the `arrival-lsp-tsgo` package. The category directory + `vitest.experiments.config.ts` are gone until a new spike lands.

## Benchmarks (`src/__benchmarks__/` + `vitest.benchmarks.config.ts`)

Performance / scale / parity measurements. Opt-in.

- `decode-tiers.test.ts`
- `loop-parity.test.ts`
- `measurement-trust.test.ts`
- `pickconstrained-structure-gate.test.ts`
- `runner-benchmark.test.ts`

These measure the kernel + decode loop (not model quality).

## Harness & Tooling (`src/__harness__/`)

Shared for research/custdev/benchmarks:
- `generators.ts`, `gguf-models.ts`, `report.ts`, `score.ts`.

## Fixtures
- `src/__fixtures__/apple-intents/`: Simulated device + tasks + registry for apple-intent experiments (used by custdev + research).

## OpenAI Server Research (inside `src/openai-server/__research__/`)
- Prelude × result-rendering matrix experiments (system prompt strategies + render strategies).
- `experiment.ts`, `prompt-strategies.ts`, `prelude-gallery.test.ts`.
- See its README for axes (roster × suite × prelude × rendering).

## External Harness Scripts (`scripts/`)
These are **not** part of the TS package but are the "series of experiments" integration surface:

- **bfcl_official/** + **bfcl_reference/**: BFCL (Berkeley Function Calling Leaderboard) integration. Official harness wrappers + lightweight reference runner. Results in `scripts/bfcl_official/result/`, scoring, etc.
- **tau-bench/** + **tau2-bench/**: Tau-bench (tool-use agent benchmarks) with arrival ports. Heavy data, historical trajectories, port plans. Results scattered in subdirs.
- `bfcl_*.py` scripts, grid runners, etc.

These are where "real numbers" come from (constrained sampler vs. native baselines).

See `scripts/README.md` and per-dir READMEs.

## Documentation & Findings Store
- `docs/package-specific/arrival-sampler/`: Architecture and experiment docs:
  - `sampler-decode-architecture.md`
  - `constrained-decode-label-bias.md`, `constrained-decode-uncertainty-branching.md`
  - `failure-mode-naming-analysis.md`
  - `intent-chain-eval-landscape.md`, `intent-chain-eval-firstrun.md`
  - `sampler-over-tsgo-wasm.md`
  - `sampler-roadmap-dag.md`
  - `type-reachability-gate.md`, `unified-lookahead-branching-decoder.md`
- Research findings live in `src/__research__/findings/`.

## Inventory Principles (how we store)
- **Stable kernel** lives at package root + documented exports. Zero LLM / I/O.
- **Everything exploratory** goes into `__research__`, `__custdev__`, `__experiments__`, `__benchmarks__` (or `openai-server/__research__`).
- Research must be opt-in (separate vitest configs). Default `test` never runs LLM code.
- Findings are stored as Markdown + data (JSON/CSV) in `findings/` or generated output dirs.
- External harnesses (BFCL/tau) live in `scripts/` with their own READMEs and result dirs.
- When an experiment graduates (e.g. a gate becomes core), move logic to stable src/ and keep the study as historical reference in research.
- `__experiments__` spikes should `describe.skipIf(...)` + warn when artifacts are absent.

## Current Snapshot (as of inventory)
- **Mature**: Core kernel + decode loop + OpenAI server (used by inhuman + studio).
- **Active research lines**: Naming effects, misprediction surfaces (apple/sift), quant impact, prelude/rendering matrices, intent chaining.
- **Probes**: Heavy use of custdev for model-specific debugging (glm, etc.).
- **Benchmarks**: Focused on decode efficiency, parity, gate trust.
- **Legacy / archived**: Some pre-G3 baselines, old spike parsers (referenced in history), retired browser explain path.
- Open questions tracked in the `docs/package-specific/arrival-sampler/` roadmap and landscape docs.

For any specific experiment, see its source header + linked findings doc.

To run:
- `pnpm test` — kernel only.
- `pnpm research` — studies.
- `pnpm custdev` / `pnpm test:llm-*` — live model probes.
- `pnpm benchmarks` / `pnpm experiments` — as named.

This inventory should be updated when a new line of work is added or an old one is archived/graduated.