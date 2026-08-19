# Oracle experiments — prelude × result-rendering, over roster × suite

A research harness for the open empirical questions behind the constrained-decoding oracle: **which prelude shape, and which result-rendering format, make a given model decode best?** Run via `pnpm research` (opt-in; the default `test` gate never fires these — a real run drives the GPU).

## The axes

| Axis | Role | Where it lives |
|---|---|---|
| **roster** | swept | `decoders: { model, decode }[]` — one decode per model |
| **suite** | swept | `dataset: ExperimentEntry[]` — BFCL items, each carrying a `category` to slice by |
| **prelude / system-prompt** | swept | `strategies: PromptStrategy[]` — `Σ → systemPrompt` (`prompt-strategies.ts`) |
| **result rendering** | given per run | how the call(s) are serialized — `strategies: RenderStrategy[]` — `ParsedCall[] → string` (`render-strategies.ts`, seeded `scheme` / `json` / `python-ast` / `tool-calls`). The SAME seam the endpoint's `render` knob uses. Run once per rendering, diff the artifacts. |

`runExperiment` (`experiment.ts`) sweeps `roster × prelude × suite` for one given rendering and aggregates per `(model, strategy)`.

## Two layers that were getting conflated under "format"

- **Generation (input) = Scheme — fixed, fundamental.** The model emits a Scheme *program*, not a flat call. This is the **extra axis we add *on top of* plain js/py/java function-calling**: chaining, pipes, binding-reuse, provenance, lower hallucination, more control all live here. It is never an experiment treatment — it's the thesis. (For a BFCL `simple` entry the program is one call; the value shows up on `parallel`/`multiple`, where composition matters.)
- **Result rendering (output) = flexible, TBD.** How the program's *result* is serialized for the grader / a downstream consumer. We genuinely don't know which renders best, so it's the swept output axis. We can sweep renderings on the *same suite + same checker* because BFCL decodes every channel to one canonical `[{name: params}]` and shares one `ast_checker` — so a rendering only needs a lowering to that canonical form.

So the experiment is **fixed Scheme generation × {prelude, result-rendering}**, not "Scheme vs json as generation surfaces." "Does the model reuse symbols REPL-style?" is a *behavioral metric on the (fixed) Scheme generation*, not a format choice.

## Why the engine is a pure matrix driver

`decode` and `evaluate` are **injected**, so the engine knows nothing about GPUs, BFCL, or Scheme:

- `decode({systemPrompt, userPrompt, tools}) → program` — canned in tests; the oracle endpoint / `makeRealDecode` bound to a model in a real run (**this is the roster axis**).
- `evaluate(output, entry) → { pass, signals }` — `pass` from the BFCL `ast_checker`; `signals` are behavioral measures (below), keyed by name, averaged blind by the engine.

## Metrics — test the Scheme thesis on its own terms

Accuracy alone can't tell you *why* a format helps. Each `evaluate` should also emit signals such as:

- **binding-reuse / chain-depth** — does the model `(define x (f …))` then reuse `x`, or nest/pipe calls? Flat `[func(kwarg=val)]` **structurally cannot** express this; if Scheme elicits it and scores higher on `parallel`/`multiple`, that's direct evidence for the substrate.
- **hallucination** — calls/args outside Σ. The oracle should mask these to ~0; the *pre-mask argmax* tells you how hard a format/prelude fights the model.
- **format-adherence** — how much tolerance-stripping (``` ``` ```` fences, REPL-prompt cruft, stray newlines) the raw output needed. Cheap proxy for "how natural is this surface to the model."

## Adding to the harness

- **A prelude** → add a `PromptStrategy` to `PROMPT_STRATEGIES` (`prompt-strategies.ts`). A pure `Σ → systemPrompt`.
- **A result rendering** → add a `RenderStrategy` to `RENDER_STRATEGIES` (`render-strategies.ts`). A pure `ParsedCall[] (+ param-order ctx) → string`. Four seeds: `scheme` / `json` / `python-ast` (the BFCL surface) / `tool-calls`. This is the SAME seam the endpoint's `render` knob uses, so a rendering measured here is exactly what the server emits.

> NOTE: rendering is over the parsed CALLS (`scheme-parse.ts`, a port of intent-eval's bfcl parser), NOT arrival values — arrival's value `toString` is **display-mode** (`SchemeString.toString` ignores write-mode, dropping the string-vs-symbol distinction), so re-serializing from `ParsedArg.kind` is both faithful and the shape both consumers already share.

## Real-wiring next step (the activation)

Today's `__research-output__/` artifacts are model-free (a prelude **gallery** + a demo CSV) to prove the pipeline. To run for real:

1. `decoders` ← the oracle endpoint (one `decode` per roster model; `makeRealDecode` bound to the model, or an HTTP call to a running `serve`).
2. `dataset` ← real BFCL entries (`simple` + `parallel` + `multiple` first — `parallel`/`multiple` are where chaining and binding-reuse actually show up; `simple` alone can't separate the formats).
3. `evaluate` ← the BFCL `ast_checker` (decode → canonical → check) + the behavioral analyzers. **Cross-worktree note:** the BFCL suite + checker live on `main` (`scripts/bfcl_official`), not on `t-layer-sm`; wiring the real evaluator follows the same `main`-pivot gating as the rest of the reshape.

See `docs/working-proposals/arrival-sampler-server-runner-reshape.md` for the surrounding north star.
