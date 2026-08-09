# June–July 2026 rework campaigns — condensed record

Distilled 2026-08-02 from ~20 working docs (audits, DAGs, plans) formerly in
`docs/package-specific/arrival-scheme/`; see git history for the originals.

The package (then `arrival-scheme`, a LIPS fork; now `@inhuman.tools/arrival`) went from
"fork mid-migration — two evaluators, two `equal?`, two sandbox paths, two number-parsers"
(63-agent audit, 2026-06-09) to a principle-first package in seven overlapping waves:

1. **lips.ts removal** (06-09 → 07-03). The audits' decisive fact: `lips.ts` had zero
   static edges to/from `evaluator.ts` — deletion was tenant eviction, not re-architecture.
   Executed via test-flip-first (T0: 273 dormant tests enabled), special-form drain onto the
   generator evaluator, macro-engine extraction. `lips.ts` no longer exists.
2. **Algebras-in-entities + boxing** (06-10/11). Fantasy Land instances moved into the
   AValue classes: dispatch went O(operations × types) → O(types × algebras). Boxing track
   minted `SchemeVector`/`SchemeBytevector` as AValue subclasses (provenance + law-tested
   algebras). Fixed the live `(equal? 1 1.0) → #t` bug via the `fantasy-land/equals` hook.
3. **Purity pass** (06-11, `c9da77f26`). Purity-by-fiat: ALL dynamics (call/cc,
   dynamic-wind, parameterize, delay/force) and ALL mutators removed — even the
   provenance-*safe* ones — each replaced by an errors-as-doors throw declared in a single
   bootstrap manifesto. Provenance soundness requires pure dataflow.
4. **Env dissolution** (post-06-15). The `BOOTSTRAP_SCHEME` monolith and `initBridge()`
   deleted; base assembled lazily from per-SRFI/R7RS `EnvCapability` packs
   (`env/base-packs.ts` → `assembleEnv`). SAFE_BUILTINS allowlist retired with it.
5. **Chibi harness cutover** (G2, 07-09, `5d4919ad8f`). v2 conformance harness
   (`conformance/chibi-r7rs-v2.spec.ts`) replaced the regex-splitting v1; ≥1000 manifest
   forms, 651 passes / 0 fails baseline, registry-coherence meta-tests.
6. **Test-suite v2 consolidation** (G2, 07-09). REMOVAL-MANIFEST discipline: nothing
   deleted until its surviving home was named (laws/ conformance/ membrane/ provenance/
   doors/ ledger/). Sunrise became the default `test` gate.
7. **Provenance Q-track** (Q1–Q21, 07-09/10). PROVENANCE.md implemented to completion,
   superseding REWORK-DAG Phase 2; interface-first DO harness (`ProvenanceStore`/
   `PayloadStore` fakes; workerd suite blocking only for forced-eviction). Remaining named
   gaps (walking driver, dict per-field stamps, D1 FIFO stand-in) are ledger/RULINGS rows.

## Durable rulings (locked; do not re-litigate)

- **Numbers get no Ord** — R7RS numeric `<` is not a Setoid-consistent total order
  (exact/inexact crossing, NaN). Numeric `<` stays the numeric path.
- **Pair gets no Setoid** — `structuralEqual` IS its structural Setoid; compound types use
  the recursor, scalars carry their own instance. NaN lives in `SchemeInexact` via
  `Object.is` (NaN ≡ NaN reflexive).
- **Never build a sync evaluator runner** — the always-async `run` is intentional: the
  cooperative tick enables AbortSignal/budgetMs/host responsiveness.
- **String/vector Semigroup-append closed-as-blocked** — a thesis limit, not pending work.
- **Purity invariant** — zero dynamics, zero mutation, frozen entities; doors, not absences.

## Killed / reverted

- **`noImplicitAny` lock REVERTED** (`87d0ae56e`, undoing `9f7a8aaf6`): TS 6.0.2 infers
  implicit-any more aggressively, surfacing ~260 pre-existing implicit-anys in LIPS-origin
  files and breaking the everyday build gate. `tsconfig.json` inherits the shared
  `noImplicitAny: false` (still `strict: true`) — rationale comment lives in the tsconfig.
  The only audit action of the campaign that was undone.
- **Speculative evaluation (promise-functor / AHalfBaked)** — proposal (2026-06-05) died
  with its carrier: AHalfBaked got VERDICT KILL (`halfbaked-existence-review.md`), the
  producer wiring was deleted pre-G2 (`90272a0b99`), and speculate-on/off became the same
  code path by construction.

## Post-migration ledger outcome

`POST-MIGRATION.md`'s parked downstream rows all resolved except one latent item — see
`2026-07-migration-open-rows.md`.
