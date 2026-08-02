# Manifold type hints — as built (2026-07)

Outcome: post-error TS type hints for manifold tool calls live in `src/type-hints/`, wired through
`runner.ts` and `doors.ts`; mode config lives in arrival-manifold (`MANIFOLD_TYPE_HINTS` override).
Mechanism: the scheme→TS lowering + harvested prelude + TS checker the sampler decode gate uses,
run **once per received program** on error; whitelisted diagnostics (9 codes) become
scheme-vocabulary advice. Polarity: whitelist never blacklist, statement coincidence, ≤1 hint per
errored statement, carrier vocabulary never leaks — a skipped hint is invisible, a wrong hint is poison.

Shipped map:
- `types.ts` — frozen contracts, `HINT_WHITELIST`, modes, telemetry shape.
- `select.ts` / `render.ts` / `context-ring.ts` — pure ring: selection rules; back-translation with
  carrier-leak guard; ~8k-char FIFO context ring of prior successful defines.
- `deliver.ts` — orchestration: 300 ms race, generation counter for staleness, telemetry per
  outcome, hints as trailing content blocks; generic-hint floor for payload-less codes.
- `spine-lens.ts` — adapter over arrival's type-layer (`lower()` per-statement span map,
  `createDiagnoseLens` structured payloads).
- `json-schema-to-ts.ts` — unplanned, largest delta: harvests each tool's raw JSON Schema into a
  closed object literal. The planned zod `SymbolDef` harvest types everything `unknown` (all decodes
  via `z.dynamic`), so it was bypassed; `createSpineLens` takes the runner's frozen `BoundTool`
  registry, and the env-riding WeakMap recovery was deleted.

Born in arrival-manifold; moved here in the language-monorepo ejection (ring-3 integration tests stayed behind).

Cut or corrected vs the proposal:
- Whitelist rewritten by corpus audit: TS fires 2322/2561/2551 for wrong-typed, typo'd-kwarg, and
  typo'd-property mistakes — the original list made the headline kwargs dividend unreachable.
  Rejected: 2552/2593 (did-you-mean is poison while the stdlib is undeclared), 2769 (flattened
  overload prose misleads). 2349 stays only because recursive quote-datum emission killed its FP class.
- Sub-statement sourcemaps: feasible but YAGNI — two node-reorderers in `lower.ts` break monotonic
  maps; no consumer reads sub-statement precision. Shipped: per-statement map +
  `programStartOffset` boundary. Revisit trigger: a caret/squiggle consumer.
- Inline hint attachment with echo suppression: unimplementable (statement blocks compose
  synchronously before the lens resolves); hints are trailing blocks, the echo co-occurs.
- Tool returns are typed `unknown` (`outputSchema` accepted, unused) — typing returns would mint
  false property-access diagnostics on tools returning text/parsed JSON.
- Deferred: follow-rate outcomes (`HintOutcome` contract exists, nothing computes it), warn-on-
  success mode, stdlib prelude declarations. Default mode remains `telemetry`.

Distilled 2026-08-02 from 5 working docs; see git history.
