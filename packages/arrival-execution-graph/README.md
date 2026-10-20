# @here.build/arrival-execution-graph

What an arrival-scheme program **will do** over a set of named symbols, and what it **has done /
is doing** — one React component, one graph vocabulary.

| Mode            | Answers                                                                                                                                                    | Built from        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **`potential`** | Every call site of a designated symbol, inside the control structures that decide how often and in what order it runs, wired by the dataflow between them. | The program text. |
| **`actual`**    | The same graph instantiated from a live trace: a track per element, an iteration per loop turn, a value and a state on every step.                         | The run's trace.  |

## Install

```sh
pnpm add @here.build/arrival-execution-graph @here.build/arrival react react-dom
```

## Use

```tsx
import { execState, LexicalScope } from "@here.build/arrival";
import { createExecutionCapture, ExecutionGraph, loadVocabulary } from "@here.build/arrival-execution-graph";
import "@here.build/arrival-execution-graph/styles.css";

const symbols = ["ask", "fetch"];
const vocabulary = await loadVocabulary(capabilities); // the capabilities the program runs with

// One fresh capture per run, passed as the run's `tap`.
const trace = createExecutionCapture(symbols);
const abort = new AbortController();
const run = execState(program, {
  scope: LexicalScope.fresh("run"),
  capabilities,
  config: {},
  tap: trace,
  signal: abort.signal,
});

<ExecutionGraph
  program={program}
  symbols={symbols}
  vocabulary={vocabulary}
  mode="actual"
  trace={trace}
  outcome={outcome} // "running" | "resolved" | "rejected" | "cancelled", from `run`
  signal={abort.signal}
/>;
```

Before a run (or with `mode="potential"`) the graph shows the plan alone.

`renderNode` replaces a step box's **contents**; the box chrome, state tags, ports and edges stay
the graph's. It receives `{ symbol, input, output, state, mode, instance }`. `DefaultStepContent`
is the default.

Layout runs ELK (`elkjs/lib/elk.bundled.js`) on the main thread, loaded on first layout. To move it
off the main thread, pass `engine={createWorkerEngine(workerUrl)}` with the URL your bundler serves
for `elkjs/lib/elk-worker.min.js` (Vite: `import workerUrl from "elkjs/lib/elk-worker.min.js?url"`).

The graph scrolls natively and zooms from 20% to 400% (Ctrl/Meta+wheel or a pinch around the
cursor, or the corner control: −, the percentage to reset, +, fit). Zoom is view-only: nothing
relayouts.

## Contract

- **One program text, one parse.** `program` is exactly the text the traced run executes: plan and
  trace meet by source span.
- **One fresh capture per run.** `ExecutionCapture` keeps the operand and result values a plain
  `EvalTrace` prunes. For a long-lived trace that holds earlier runs, pass `since` — the first
  invocation id of the run to show.
- **`outcome` is the run promise's state.** The trace alone cannot tell that a run ended, so steps
  still running when the run rejects or is cancelled read `cancelled` only once `outcome` says so.
  Pass the run's `signal`: an abort rejection carrying its `reason` reads as cancelled.

## Theming

`styles.css` is the whole look. States are attributes (`data-state` on steps, frames and edges;
`data-kind` on edges), and the palette is custom properties on `.eg-graph`, with light and dark
defaults following `prefers-color-scheme`. The defaults sit in `:where()`, so any selector wins:

```css
.my-app .eg-graph,
.my-app .eg-message {
  --eg-accent: var(--brand);
}
```

| Property                                                                | Role                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `--eg-fg`, `--eg-muted`                                                 | Primary and supporting text; edges.                                                   |
| `--eg-bg`, `--eg-border`                                                | Canvas and step fill; box borders.                                                    |
| `--eg-dot`, `--eg-dot-strength`                                         | The canvas dot grid's colour (defaults to `--eg-fg`) and a multiplier on its opacity. |
| `--eg-accent`                                                           | Running.                                                                              |
| `--eg-danger`                                                           | Rejected, `✕ message`, errors.                                                        |
| `--eg-warning`                                                          | Cancelled, diagnostics badge, dataflow banner.                                        |
| `--eg-recur`                                                            | Recursion edges (defaults to `--eg-accent`).                                          |
| `--eg-font`, `--eg-font-mono`, `--eg-font-size`, `--eg-font-size-small` | Type.                                                                                 |
| `--eg-pad-y`, `--eg-pad-x`, `--eg-gap`, `--eg-radius`                   | Box spacing and corners.                                                              |

## Known limits

- **Dataflow can be partial.** When a link cannot be joined to the plan, the graph raises a
  banner ("partial — N links could not be traced") and shows the steps without it; a missing
  edge does not mean independence. Known cases: a `do` result clause reading a loop variable
  (the result is drawn once, after the loop, and the loop has no port for a variable's final
  value), a fan callback computed from step results (`(map (if c f g) xs)`), and a call
  `apply`ing a designated symbol. `unavailable` (no edges at all) is shown only if arrival's
  wireframe throws.
- **`callback ×?` hosts.** A host function that takes a lambda without a declared callback role
  draws it as a `×?` frame: it may run any number of times, and its steps take the host's state.
- **Macros the plan does not expand** (`->`, `->>`, `~>`, `~>>`, `cut`, unknown macros): their
  steps are hosted. A call the expansion makes lands on its step once it runs (several calls of
  one symbol are matched in threading order); until then, and for any frame inside the macro use,
  the macro invocation's state stands in. A call inside a frame the expansion itself rebuilt
  (`(->> xs (map f))`: the `map` has no located invocation to tell its tracks apart) shows as
  `unplanned`.
- **Functions defined by an earlier run are invisible.** arrival captures the tap when a closure
  is defined, so their bodies report into that run's trace.

## License

MIT — see `LICENSE.md`.
