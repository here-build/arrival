# Test Invariant Atlas — @here.build/arrival (2026-07-08)

Six-cluster sweep of every test file (151 files, ~23.4k lines): what invariants the suite
enforces, named — no code, no rationale. Cross-referenced against a production-only
reachability run (knip, all 14 package subpath exports as entries, `__tests__`/`__benchmarks__`
excluded) and an external-consumer grep across the whole monorepo.

Cluster maps (full invariant lists, one line per invariant):

| Cluster | File | Invariants | impl-pinning |
|---|---|---|---|
| Provenance / lineage | [provenance.md](provenance.md) | 258 | 12 |
| Evaluator / language core | [evaluator.md](evaluator.md) | ~346 | ~47 |
| Values / algebra | [values.md](values.md) | ~230 | ~62 |
| Membrane / interop / sandbox | [membrane.md](membrane.md) | ~205 | 27 |
| Env / stdlib contracts | [env.md](env.md) | 193 | 64 |
| Common / capability / type-layer | [common-type-layer.md](common-type-layer.md) | ~342 | 9 |
| **Total** | | **~1,670** | **~220** |

`[impl-pinning]` = the invariant pins implementation internals (private field, exact error
string, helper identity) rather than observable behavior. `[todo]`/`[fails]` = the repo's
bug-ledger convention (spec'd-unbuilt / documented-gap).

## Reading the ratios

- **Healthiest**: provenance (12/258) and common/type-layer (9/342) — almost pure behavior
  oracles. The golden-prov suites + ~40 `[todo]` G2-gate assertions are the static-lineage
  spec written as executable tests.
- **By design**: env's 64 pins are mostly deliberate drift alarms ("the numeric pack exports
  exactly 81 symbols") and chibi's harness registries — pinning the RUNNER is correct for a
  harness.
- **War-story pins**: clone-identity.test.ts pins 14 exact `=== nil` sites; valuable as a
  regression ledger, brittle as anything else.

## Dead-code report (knip × invariant map × external grep)

Baseline: **2 unreachable files, ~70 unused exports, 9 unused types** from production entries.
Full mechanical list: `knip` with the config used lives in the session scratchpad; re-run:
`npx knip --config knip.json --include exports,types,files` with entries = the 14 package.json
export targets, project = `src/**` minus test dirs.

### Bucket 1 — DEAD (unreachable from production, no live external consumer, no behavioral
invariant anchoring it). Safe to delete; verified against foundations/, second-foundation/,
here.build/, inhuman/:

- `src/bindings.ts` — whole file, zero importers
- `src/utils/balanced.ts` — whole file after the Formatter deletion trimmed its last reader
  importer; its own header admits it duplicates `Parser._state` bracket tracking
- `bridge.ts` `exceptionsCapability`
- `env/r7rs/index.ts` re-export layer (`syntax`/`binding`/`exceptions`/`lists`/`control`/`host`)
  — packs are consumed directly via BASE_PACKS
- `errors.ts` `formatLocation`, `RaisedException`
- `eval/call-function.ts` `resolve_promises` export (verify in-module use first),
  `eval/guards.ts` `has_own_symbol`/`is_iterator`/`is_native` re-exports,
  `eval/Resolver.ts` `env_get`, `eval/syntax-rules.ts` `macro_expand`
- `reader/curly-infix.ts` `resolveNfx`; `reader/parse.ts` `_parse`;
  `reader/Parser.ts` `getMaxNestingDepth`/`setMaxNestingDepth`;
  `reader/specials.ts` `SPLICE`/`__list__`; `reader/token-guards.ts` `is_symbol_string`
- `rosetta.ts` `looksLikeEvalContext` (one external COMMENT mention in
  arrival-scheme-env-loader — update the comment when deleting)
- `values/lineage-shadow.ts` `shadowSkipReason`
- `values/numbers.ts` `COMPLEX_DOOR_MESSAGE`, `isComplex`, `isInteger`; `isSchemeNumeric`
  drops `export` only (internal caller `isNumeric`)
- `values/op-helpers.ts` `getAllocationLimit`/`setAllocationLimit`
- `values/primitives.ts` — ~15 regex exports (`p_o`, `p_e`, `not_p`, `non_def`, `let_re`,
  `string_re`, `gen_rational_re`, `gen_complex_re`, `gen_integer_re`, `make_complex_match_re`,
  `complex_float_stre`, `complex_list_re`, `glob`, `keywords_re`, `syntax_rules`,
  `def_lambda_re`) — drop `export` where used in-module; the eBNF phase-2 rewrite deletes the
  file wholesale
- `values/primitives/ASymbol.ts` `AKeywordSymbol` class
- `values/value-guards.ts` `is_native`, `is_native_procedure`, `is_rosetta_procedure`,
  `is_procedure`, `has_own_symbol`
- `utils/parsing.ts` — `parseBigInt`/`ucs2decode`/`num_pre_parse`/`parse_character`/
  `parse_big_int`/`string_to_float`/`parse_string`/`parse_symbol`: functions live (in-module
  callers), the `export` keyword is the legacy — drop exports
- `utils/typecheck.ts` `typecheck` export (verify in-module use)
- 9 unused exported types: `Face` (_bake), `WellKnownStatus`×2 + `WellKnownSymbolEntry`
  (polyglot-rich-errors), `RunOptions` (evaluator), `CtxWithInvocation` (rosetta),
  `DiagnoseUnit` (diagnose), `SlotElementType` (query), `HeapMeter` (RunContext)

**NOT dead despite knip flag** (external consumers or entry-adjacent):
`membrane.ts` `markAsSandboxBoundary` (arrival-chain re-exports); the membrane.ts
`accessMember`/`accessHas`/`accessSet`/`NOT_FOUND`/`markInteropBoundary`/`InteropAccessError`/
`INTEROP_BOUNDARY` re-exports — flagged only because in-package consumers import
interop-access directly; decide: keep membrane as the public face or repoint the package
index and drop the re-export layer.

### Bucket 2 — PRE-WIRED (unreachable today, documented as designed-and-waiting; keep)

- The lineage classifier module (`classify`/`fullCone`/`countCone`/`fieldCone`/
  `classifierFromEnv`) — test-only until the `--ir-lineage` slice lands; G1–G7 gates in
  lineage-assumptions.test.ts are its spec
- `rosettaPureOf` classification consumers (rosetta-pure-marker.test.ts builds the consumer
  inline; production wiring deferred)
- deferred-value-egress force-on-egress (4 `[todo]` invariants = the spec)

### Bucket 3 — test hygiene (life-support and vacuous tests)

- `keyword-syntax.test.ts` — flagged independently by THREE cluster agents: half the blocks
  are console.log + `expect(true).toBe(true)`. Fold the ~3 real accessor cases into
  escaped-symbols.test.ts, delete the rest
- `module-composition.spec.ts` — built entirely on private `_lookupWithResolvers`; the
  resolver-ordering contract it pins IS load-bearing (capability resolvers), so keep, but it
  should migrate to the public surface when one exists
- `__benchmarks__/evaluator-benchmark.spec.ts` — "LIPS (promise-based)" label is false (both
  sides run the same generator evaluator); relabel or delete the A/B framing
- 7 `*.test-d.ts` env files prove hand-mirrored SYNTHETIC contracts (the DecodedArgs
  mechanism), not real pack exports — legit as mechanism proofs; the runtime half lives in
  the sibling `*-contract-precision.test.ts` files
- `fresh-env.test.ts` guards the test helper itself — cheap, keep

### Known gaps the atlas surfaces (not dead code — open work)

- SRFI-95 `sort` ignores an explicit `less?` comparator (`[fails]`, srfi.test.ts)
- syntax-rules vector patterns `#(a ...)` unimplemented (3 `[fails]`)
- js-interop: inexact JSON.stringify, char coercion, symbol schemeToJs unwrap (3 `[fails]`)
- null↔nil round-trip asymmetry (membrane-symmetry, 1 `[fails]`)
- parameterize/make-parameter — whole describe skipped
- traversePair nil-clone `of` termination (`[fails]`, clone-identity)
