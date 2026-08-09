# The arrival CLI/REPL/interactive-run design

Read before touching `run-view`, `run-outline`, `form-detail`, or `run-export`. Per-module
behavior lives in those files' headers; this note keeps only the cross-module reasoning and
the rejected alternatives.

## The thesis: one structure, three times, N lenses

Source, execution, and value are the **same homoiconic structure at three times**:

| time | structure | heptapod parse |
|---|---|---|
| before | wireframe — the whole program, all forms | teleological (seen at once) |
| during | record stream / EvalTrace — the frontier advancing | causal (unfolding) |
| after | the produced value — itself code | the sentence complete |

Cross that with surface `{scheme, sugarcoat, json, rich}`. Every CLI/REPL/TUI feature is one
cell of a `{before, during, after} × {surface}` matrix — a pure projection of one
`(wireframe, EvalTrace)` pair folded over one event stream. Not four features; one structure,
N lenses. `foldReplEvent` is an Elm fold; `EvalTrace` carries invocation state.

## The subtlety bar (the scrub-widget rule)

Impressive but SUBTLE. Looks like ordinary output; the machinery underneath is deep; the more
you poke, the more you see. No banners, no gradient wordmarks, no box-drawing dashboards.
Everything headless-testable (pure fold + string view; no real TTY).

## Why the naive design fails: one template ≠ N invocations

The seductive-but-wrong idea: **"source IS the graph — tint the existing source text, don't
draw a diagram."** It conflates **one parser-node (template)** with **N dynamic invocations**.
Gorgeous for tree-shaped dataflow (the Observable/Pluto regime, where cells ≈ invocations); a
beautiful lie for Scheme, whose power is the opposite — HOFs, recursion, macros: one source
form, many invocations, exactly the case a debugger is for.

Probe ground truth (real traces, `execState({ tap })`):

| program | distinct templates | total invocations | the 1:N |
|---|---|---|---|
| `(map (λ(n)(* n n)) xs)` flat | 5 | 7 | `(* n n)` → 3 |
| `(map (λ(n)(* n n)) (iota 6))` | 4 | 9 | `(* n n)` → 6 |
| `(fib 10)` | 9 | **796** | `if` → 177, each `fib` call-site → 88 |
| nested HOF | 9 | 18 | inner `+` → 6, inner `map` → 3 |

Naive per-form tint on `fib` collapses **796 invocations into 9 glyphs** — discards 787
events. So the render sits on a nav model (`run-view.ts`) that aggregates each template's
invocation *set* and carries the `×N` multiplicity; tinting one glyph can never be the model.

## The three design decisions (reasoning; mechanics live in the module headers)

1. **Template-grain aggregation is the default lens** — each source form gets ONE state folded
   over its invocations (`aggregateState` in `run-view.ts`; precedence error > running > done,
   empty is unreached). Template state, not per-invocation, is what a source-ordered outline
   can show.
2. **The invocation count IS the depth-affordance.** `×N` is the scrub-widget "poke me": it
   says "a dynamic tree hides behind this form" without drawing it. `N=1` reads as plain;
   `N>1` earns the badge and a drill-down.
3. **Drill-down is the reward, and it must aggregate, not dump** — a 177-invocation form shown
   as 177 lines is a firehose. `form-detail.ts` returns a fixed-size summary (header +
   "called from" parent histogram + capped sample).

## Live cascade vs final frame

Every invocation in a *sync* run resolves in low-single-digit ms — the dim→running→done motion
is invisible, so a sync run's frame is just the **final** one (source + counts + drill-down).
Live motion is real only for **async** programs (`infer`, effects, awaits), where the frame
re-aggregates as invocations enter/exit. Both are the same pure `view(runView(trace))`; only
the repaint count differs — which is why the renderer is a pure fold, not an animation loop.

## Identity model (the second axis the render must respect)

`EvalTrace.records` keys by **template** (parser Pair, via `scopeId`); `NodeRecord.bindings`
is the **set of `Invocation`s** — the N instances, each with `.state` / `.value` / `.parent` /
`.children` / `.tailPosition`. The template↔invocation split the design depends on is the
runtime's own; the render's only job is not to flatten it. Location (`.line`/`.col`) comes off
the `Symbol.for("__location__")` on located Pairs — start position only, so the renderer tints
the head token, not the whole form (which also keeps it subtle).

## Rejected in-source alternatives

- **In-source tinting** re-hides the invocation-collapse problem: there is no end span, and an
  aggregate tint on the head token repeats the 1:N conflation above. Not built.
- **Async live-cascade animation** only animates for the async minority and is the hardest
  path to headless-test. Not built.
- The outline stays **flat** — source order is the index; nesting belongs inside drill-down.
- Value-pruning (`#pruneChildProvenance` drops scaffolding values) does not neuter drill-down:
  structure is the signal; a pruned value collapses to one "value elided" line, never a global
  full-fidelity mode (which would reopen the leak at fib scale).

## Not built yet

- **Trace-diff** (`diff(a, b) → changes[]`) — the strategic prize, and the reason `--export`
  exists (a versioned `RunExport` makes `diff` a two-file pure function). Its honest use — same
  program, different inputs — needs param-injection in `run` so two runs vary only their
  overridable inputs; diffing two *files* gives scopeId-instability noise instead.
- **Purity-gated eager-eval ghost** (REPL) — gated on the full safety contract:
  proven-pure-only, fuel + wall-clock + cancel-on-keystroke, same evaluator as the real run,
  closed expressions only, advisory grey `~` never authoritative, off the main thread.
- **Interactive keyboard layer** over outline/drill-down — the pure cores are done and tested;
  the keyboard wrapper is thin but hard to headless-test, so it is deliberately last.
- **Bidirectional sugarcoat lens** (input flip).

## Deferred / rejected outright

- **Perfetto/Chrome-trace export** — it flattens away the substrate; structural trace-diff
  replaces it.
- **Reactive param-scrub** (change an overridable → pure cone recomputes, effects gated) — the
  highest-leverage extension, isomorphic to arrival's cache-first view/pure/effect axis.
  Aspirational.
