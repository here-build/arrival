# @inhuman.tools/arrival-provenance

A thin re-export shim over [Arrival](../arrival/README.md)'s `/provenance` subpath: the trace-capture substrate and the full analysis stack (forest, statechart, region tree, flow graph, reverse-chain slicer, grounding seal) live in core. It reads finished traces and **never drives the evaluator**. The only non-passthrough export is `EvalTrace`: this package's is the mobx-reactive `ObservableEvalTrace`, kept here so studio/UI consumers get byte-identical reactive semantics without core taking on a mobx dependency.

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
