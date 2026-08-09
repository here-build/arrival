# @inhuman.tools/arrival-provenance

Trace analysis for [Arrival](../arrival/README.md), owned natively here. The full analysis stack — forest, statechart, region tree, flow graph, reverse-chain slicer (`buildUneval`), grounding seal — lives in this package. Core (`@inhuman.tools/arrival`'s `/provenance`) keeps only the **capture spine** (`EvalTrace`, stamping at the membrane); this package re-exports capture for a single import surface and **never drives the evaluator**. The one non-passthrough export is `EvalTrace`: this package's is the mobx-reactive `ObservableEvalTrace`, kept here so studio/UI consumers get byte-identical reactive semantics without core taking on a mobx dependency.

## Install

```bash
pnpm add @inhuman.tools/arrival-provenance
```

## Usage

```ts
import { traceToForest } from "@inhuman.tools/arrival-provenance";

const forest = traceToForest(trace);   // `trace`: a finished EvalTrace
```

The heavier analysis stack lives at the `./analysis` subpath:

```ts
import { traceToStatechart, buildSlice, buildUneval } from "@inhuman.tools/arrival-provenance/analysis";

const statechart = traceToStatechart(trace);
```

The surface, in three subpaths:

- **`.`** — capture + region-model primitives: `EvalTrace`, `Invocation` (each carries its own computed `.provenance`; dataflow minted at boundaries), `traceToForest`, `traceToRegions` (the studio blueprint) with an incremental `TraceRegionFold`. Plus `trace-snapshot` / `trace-artifact` serialization.
- **`./analysis`** — turn a finished trace into render-models: a statechart, a flow graph, forest-collapse (`collapseMDL`), and the reverse-chain slicer (`buildSlice` / `buildUneval`).
- **`./verdict`** — `groundingVerdict`, the whole-result grounding seal: a lineage-completeness oracle over a finished traced run (not a truth oracle — it signs a provably-traced fabrication from a lying tool just as readily as a fact).

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
