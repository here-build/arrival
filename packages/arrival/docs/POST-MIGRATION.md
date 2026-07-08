# Post-migration ledger — downstream breakage parked during the core rework

*Rule (V, 2026-07-09): downstream packages are already partially broken from prior API
reworks. Anything deeply wrong discovered in a downstream package or its tests during the
[`REWORK-DAG.md`](REWORK-DAG.md) execution gets a row HERE and work continues — it never
blocks a core commit. This phase runs after node Z.*

Row format: package · what's broken · which rework node exposed it · suspected depth
(import-fix / test-rot / design-mismatch).

| Package | Breakage | Exposed by | Depth |
|---|---|---|---|
| `arrival-provenance` | ~~becomes a re-export shim at C0~~ DONE 2026-07-08: analysis layer moved into `arrival/src/provenance/`, package is now a pure re-export shim (`.` + `/analysis`, both routed through `@here.build/arrival/provenance`). All direct consumers (second-foundation/{arrival-run,arrival-form-lens,arrival-effects,arrival-program-analysis,arrival-chain,arrival-reflect}, inhuman/{saas/mcp,saas/api,public-packages/inhuman}) typecheck 0 through the shim — verified, not just planned. | C0 (landed) | — |
| `inhuman/sift-submission/runner`, `inhuman/sift-submission/mcp` | `AValue.toJs` missing (renamed/moved?), `strict-row.ts` `AJSObject.get`/`withProvenance`/`RunContext` shape mismatches, `SiftSymbolDef.withContext` unknown prop, `scheme-zod`'s `.unknown` missing | discovered incidentally while gate-checking C0's downstream consumers; unrelated to provenance — looks like in-flight AValue/RunContext/scheme-zod rework from another track (A2/A4 boolean-mint or D-track type layer) | design-mismatch |
| `inhuman/saas/studio` | `@here.build/arrival-type-lens-tsgo` module not found (`tsgo-lens.worker.ts`) | discovered incidentally while gate-checking C0's downstream consumers; unrelated to provenance | import-fix (missing build/link) |
| `inhuman/examples/ai-winter-thawed` | no `tsconfig.json` in the package — `tsc --noEmit` can't run standalone, no direct verdict possible | discovered incidentally while gate-checking C0's downstream consumers (declares `@here.build/arrival-provenance` as a dep, uses only `.`/`/analysis` names the shim preserves) | test-rot (missing tsconfig) |
| `arrival` core itself | `src/env/r7rs/numeric.ts` 2 tsc errors (`mintVerdict` missing export from `op-helpers.js`; a vector predicate signature mismatch) | pre-existing, uncommitted, concurrent agent work in `src/values/op-helpers.ts` (Track A — boolean-mint/R8), not touched by C0; confirmed via `git status` showing only `op-helpers.ts` modified outside this session, everything else in `values/` clean | design-mismatch (in-flight) |
| `arrival` core itself | 41 sunset-suite (`vitest.config.ts`) test failures across `attestation`, `coercion-soundness`, `contract-precision-fixes`, `js-interop`, `srfi`, `env/overridable`, `env/r7rs/{bytevectors,lists}-contract-precision`, `type-layer/{lower,prelude,query,schema-to-ts}` | same `op-helpers.ts` in-flight breakage cascading; none touch provenance/trace/region files — confirmed zero new failures from the C0 move (`src/provenance/__tests__` = 29/29 green, sunrise `src/__tests__/provenance` = 10 pass/1 xfail/1 todo, both unchanged) | design-mismatch (in-flight) |
| `arrival` core itself | 8 sunrise (`vitest.sunrise.config.ts`) failures in `src/__tests__/laws/term-carrier.law.test.ts` (`carrier APair/AVector/AString/ABytevector` element-unioning + deep-collapsed provenance) — these are `it.fails` gaps that started PASSING (`Error: Expect test to fail`), i.e. a flip, not a regression | same `op-helpers.ts` in-flight conservation-repair work (Track H2/A) landing mid-session; not touched by C0. The full sunrise gate command (`laws`/`membrane`/`provenance`/`doors`/`ledger`) is otherwise clean: 7 of 9 files passed, 1 skipped, only `term-carrier.law.test.ts` failed | design-mismatch (in-flight, likely a real fix — needs the `it.fails` wrapper flipped to `it` by whoever owns op-helpers.ts) |
| *(append as discovered)* | | | |
