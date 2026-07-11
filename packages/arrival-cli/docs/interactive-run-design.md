# The arrival CLI/REPL/interactive-run design

*Working design doc. Captures the thesis, the triad rebuild, and the probe ground-truth
that killed the naive version. Read before touching `run-view` / the interactive-run
renderer.*

## The thesis: one structure, three times, N lenses

Source, execution, and value are the **same homoiconic structure at three times**:

| time | structure | heptapod parse |
|---|---|---|
| before | wireframe — the whole program, all forms | teleological (seen at once) |
| during | record stream / EvalTrace — the frontier advancing | causal (unfolding) |
| after | the produced value — itself code | the sentence complete |

Cross that with surface `{scheme, sugarcoat, json, rich}`. Every CLI/REPL/TUI feature is one
cell of a `{before, during, after} × {surface}` matrix — a pure projection of one
`(wireframe, EvalTrace)` pair folded over one event stream. Not four features; one
structure, N lenses. The runtime is already built this way (`foldReplEvent` is an Elm
fold; `EvalTrace` carries invocation state).

## The subtlety bar (the scrub-widget rule)

Impressive but SUBTLE. Looks like ordinary output; the machinery underneath is insane; the
more you poke, the more you see. No banners, no gradient wordmarks, no box-drawing
dashboards. Everything headless-testable (pure fold + string view; no real TTY).

## The rebuild: what the triad (grok-4.5 / composer / longcat, 3/3) demolished

The seductive-but-wrong idea was **"source IS the graph — tint the existing source text,
don't draw a diagram."** All three, independently, named the same fatal flaw:

> It conflates **one parser-node (template)** with **N dynamic invocations**. Gorgeous for
> tree-shaped dataflow (the Observable/Pluto regime, where cells ≈ invocations). A
> beautiful lie for Scheme, whose power is the opposite: HOFs, recursion, macros — one
> source form, many invocations — *exactly the cases a debugger is for*.

### The truth-serum probe (real traces, `execState({ tap })`)

| program | distinct templates | total invocations | the 1:N |
|---|---|---|---|
| `(map (λ(n)(* n n)) xs)` flat | 5 | 7 | `(* n n)` → 3 |
| `(map (λ(n)(* n n)) (iota 6))` | 4 | 9 | `(* n n)` → 6 |
| `(fib 10)` | 9 | **796** | `if` → 177, each `fib` call-site → 88 |
| nested HOF | 9 | 18 | inner `+` → 6, inner `map` → 3 |

Naive per-form tint on `fib` collapses **796 invocations into 9 glyphs** — discards 787
events. Confirmed, not speculated.

## The honest design (what we build)

1. **Template-grain aggregation is the default lens.** Each source form (`scopeId` =
   `head@line:col`, stable) gets ONE aggregated state over its invocations, by this NAMED
   rule (pure fold — the load-bearing decision):

   ```
   templateState(invocations):
     empty              → "unreached"   (dim — no invocation yet)
     any rejected       → "error"
     any running        → "running"     (the one glyph + subtle pulse)
     all resolved       → "done"
   ```

2. **The invocation count IS the depth-affordance.** `if ×177`, `fib ×88`, `* ×6`. The
   `×N` badge is the scrub-widget "poke me" — it says "this form has a dynamic tree behind
   it" without drawing it. Auto-promote: `N=1` reads as plain; `N>1` earns the badge and a
   drill-down.

3. **Drill-down is the reward.** Select a form → its N invocations (the real dynamic tree
   via `traceToForest` / `Invocation.parent`/`children`), each with its value (when
   retained — `#pruneChildProvenance` drops pure scaffolding values, so drill-down surfaces
   what's kept, honestly).

4. **Live cascade vs final frame (from the probe).** Every invocation in a *sync* run
   resolves in low-single-digit ms — the dim→running→done motion is invisible. Live motion
   is real only for **async** programs (`infer`, effects, awaits). So:
   - sync run → the value is the **final frame** (source + counts + drill-down).
   - async run → the frame re-aggregates + repaints as invocations enter/exit.
   Both are the same pure `view(runView(trace))`; only the number of repaints differs.

## Identity model (already present, was mis-projected)

`EvalTrace.records: Map<Pair, NodeRecord>` keys by **template** (parser Pair).
`NodeRecord.bindings: Set<Invocation>` is the **N instances**. Each `Invocation` has
`.state` / `.value` / `.parent` / `.children` / `.tailPosition`. The "second axis" the
triad demanded was never missing — the render just has to respect it. `scopeId(pair)` is
the stable template key; `.line`/`.col` come off the `Symbol.for("__location__")` on
located Pairs (start position only — no end span; the first renderer tints the head token,
not the whole form, which also keeps it subtle).

## Build order (triad-hardened)

- **B — display boundary.** DONE (`output-mode.ts` / `sexpr-color.ts`). `--json` opt-in,
  subtle TTY color, pipe stays byte-identical.
- **run-view nav model.** Pure `trace → TemplateNode[]` (aggregation + count), tested
  against the real traces above. The semantic handle — built before any tint.
- **interactive-run renderer.** `view(runView) → lines[]` over the painter; source-ordered
  template outline with state glyph + `×N`. Pure/headless first; keyboard drill-down last.
- **Later:** purity-gated eager-eval ghost (needs the full safety contract — fuel +
  wall-clock + cancel-on-keystroke + same-evaluator + advisory-only); bidirectional
  sugarcoat lens (input flip); structural trace-diff (the real depth feature the triad
  rated above perfetto export — run₁ vs run₂, ghost-predicted vs actual).

## Status (as shipped, 2026-07-12)

Four commits, all on the honest identity model, all headless-tested (109 tests in
arrival-cli):

- `--json` / subtle TTY color — the display boundary (`output-mode.ts`, `sexpr-color.ts`).
- `--outline` — source-ordered form outline, glyph-color = state, `×N` = the depth
  affordance (`run-view.ts`, `run-outline.ts`).
- `--form <scope>` — drill into one form's invocation set. AGGREGATES (header + "called
  from" parent histogram + capped samples), never dumps; pruned values collapse to one
  depth-ladder line (`form-detail.ts`).
- `--export` — versioned JSON run-introspection contract, the agent/MCP surface
  (`run-export.ts`).

### Second triad round (3/3, on the shipped outline)

- Drill-down ranked #1 next move — with the constraint it must **aggregate, not dump** (a
  177-invocation form is a firehose otherwise). Done.
- **C (async live-cascade) and D (in-source tinting) are traps** — D re-hides the 787
  events the outline fixed (no end span, aggregate-tint-on-head is the old 1:N lie); C is
  demo-tax that only animates for the async minority and is the worst headless-test story.
  Both rejected.
- Outline stays **flat** (source-order = the index); nesting belongs inside drill-down.
- Value-pruning does **not** neuter drill-down — structure is the signal; show
  "value elided", never a global full-fidelity mode.
- `--export` is the enabler longcat rated highest: makes a future `--diff` a two-file pure
  function and any web/MCP viewer a contract consumer.

### Next (not built)

- **Trace-diff** (`diff(a, b) → changes[]`) — the strategic prize, but its honest use
  (same program, different inputs) is blocked on **param-injection in arrival-cli's `run`**
  (the overridable→flag machinery lives in inhuman's `overridable-argv.ts`; sharing it
  needs a foundation-package extraction). Diffing two FILES gives scopeId-instability noise
  — don't. Build `diff` pure over two `RunExport`s once param-scrub exists.
- **Purity-gated eager-eval ghost** (REPL) — highest wow (round 1), but needs the full
  safety contract before it's safe: proven-pure-only, fuel + wall-clock + cancel-on-
  keystroke, same evaluator as the real run, closed expressions only, advisory grey `~`
  never authoritative, off the main thread.
- **Interactive keyboard layer** over `--form`/`--outline` — the pure cores are done and
  tested; the keyboard wrapper is thin but hard to headless-test, so it's deliberately last.
- **REPL subtlety pass** — the wave-1 greeting still has a gradient wordmark; V's
  "no gradients/banners" suggests toning it down, but it's V's existing aesthetic — left
  for V's call rather than changed unilaterally.

## Deferred / rejected

- **Perfetto/Chrome-trace export** — 3/3 rated it commodity (flattens away the substrate).
  Replaced in the roadmap by structural trace-diff.
- **Reactive param-scrub** (change an overridable → pure cone recomputes, effects gated) —
  the highest-leverage thing per grok-4.5/composer, isomorphic to arrival's cache-first
  view/pure/effect axis. Aspirational; not this wave.
