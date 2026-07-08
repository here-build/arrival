---

# Arrival test audit — common / type-layer / benchmarks / assigned `src/__tests__` files

**Premise correction on hunt #2:** the legacy `SymbolDeclaration` arm is *not* "slated pre-prod death" as unqualified dead weight — `capability.ts:62-69` documents it as deliberately staged and load-bearing for `McpEnvCapability`'s downstream population (here.build/inhuman/sift MCP packs), gated on a named future migration (annotation-lifting → baked-symbol splicing). It is still transitional, so RETAGs below stand, but the death is migration-gated, not pre-prod-scheduled.

## Findings

`evaluator-benchmark.spec.ts > all three describe groups — [P15] verdict: REWRITE — the "LIPS (promise-based)" side imports `exec` from `eval/generator-exec.ts`, which drives the SAME generator evaluator as the "Generator" side's `eval/evaluator.ts` exec (the lips handle was retired in 0849de566b); the A/B labels are fiction and the "speedup" measures only the public-exec seam (bootstrap gate + Resolver + runCtx minting) vs a raw `run(evaluate(...))` call — relabel as a seam-overhead benchmark or delete the comparison group.`

`evaluator-benchmark.spec.ts > listLips/genAst harness — [P1] verdict: RETAG — the hand-built ASTs put raw unboxed JS numbers (`1`, `2`) as pair cars, terms the provenance interpreter cannot execute; retag to boxed AExact construction when the bare-value purge reaches harnesses.`

`capability.test-d.ts > "a bare function is assignable to SymbolDeclaration" — [P16/P1] verdict: RETAG — pins the legacy bare-fn arm's type-level existence green; it dies with the McpEnvCapability annotation-lifting migration, so mark it transitional (the `{ value }` and baked-AEntity proofs are permanent per the source doc and stay).`

`capability.test.ts > "EnvCapability" (all 4 lifecycle tests) — [P1] verdict: RETAG — the whole `net` fixture is authored in the legacy bare-method-reading-`this` form (`describe(msg) { this.configuration... }`) and the recorder wires via `defineRosetta(name, cfg.fn)`; the resource-lifecycle invariants are durable but must be re-authored onto baked `symbol.*` forms when the legacy arm dies.`

`scheme-env.test.ts > schemePacks wire steps — [P1] verdict: RETAG — `wire: (e) => e.defineRosetta("op", { fn: () => 0 })` exercises the legacy `RosettaSpec {fn}` door; the C3-ordering invariants survive, the authoring form travels with the legacy-arm migration.`

`input-rest-runtime.test.ts > INTEGRATION beforeAll — [P1] verdict: RETAG — `env.set("headtail", headtail.run)` binds a bare JS function into env value space (a value-layer-only term); post callables-as-values this should bind through EnvCapability wiring or a first-class holder.`

`kwargs-runtime.test.ts > INTEGRATION beforeAll — [P1] verdict: RETAG — same bare-fn `env.set("kw-greet", greet.run)` harness wiring as input-rest-runtime; retag together.`

`scheme-zod.test.ts > z.procedure (all 4 decode/encode tests) — [P6] verdict: RETAG — both directions produce region-free callables (decode: a JS fn invoking `applyCallback` with no ctx/owner/abort path; encode: an ANativeProcedure closing over a host fn) callable after any invocation scope dies; when region discipline lands these must rebaseline to scoped re-entry with call-after-return throwing.`

`scheme-zod.test.ts > z.vector encode-canonical + element-codec roundtrip — [P16/P3] verdict: REWRITE — asserts via direct `__vector__`/`.car` representation reads plus `as any` ctor casts where the public `arrival/toJS` protocol observation exists; swap to protocol reads (minor — the round-trip behavior itself is what survives the codec→protocol wiring migration).`

`schema-to-ts.test.ts > vector prints "unknown[] | unknown[]" — [P15] verdict: FLIP-TO-FAILS — the test's own comment calls it a "RESIDUAL v2 ARTIFACT" with a "tracked follow-up"; pinning the duplicated union green is exactly the forbidden "documents today's behavior" category and will fight whoever lands the union-member dedup — assert `"unknown[]"` under `it.fails`.`

`lower.test.ts > "do / case → parse-safety only" — [P16] verdict: REWRITE — pins an exact emission string (`s.case(x, _.$1$(2))`) whose shape the test itself disclaims as "incidental"; assert parse-safety (compiles without throwing), not the accidental shape.`

`lower.test.ts > "letrec / letrec* → same flat emission as let (advisory fidelity)" — [P0/P15] verdict: RULING-NEEDED — a genuinely recursive letrec (`(letrec ((f (lambda (n) (f n)))) ...)`) lowers to `s.let` with `f` FREE in the value position → TS2304 on a valid scheme program, a static-interpreter false positive that contradicts the drops-only/superset-safe philosophy query.test.ts pins as the governing law; either the divergence gets an `it.fails`/todo ledger naming the false-bite, or a ruling that advisory false positives are acceptable for non-slot diagnostics.`

## Answers to the specific hunts

- **P15 benchmark lie (hunt 1): CONFIRMED** — see the first finding; verified at import level, not just labels.
- **P1 transitional (hunt 2):** 5 RETAGs above (capability.test.ts, capability.test-d.ts bare-fn arm, scheme-env.test.ts, input-rest/kwargs harness wiring) — with the premise correction noted.
- **P4/P7 scheme-zod (hunt 3):** the hand-written per-carrier transform bodies live in the *source* (`vector` reading `__vector__`/`.source` per branch, the number family reading `.num/.denom/.real`) and are the zod-protocol wiring migration's target — but the *tests* pin round-trip behavior that survives that migration unchanged, so only the one REWRITE above (representation reads/`as any` in assertions). Notably `z.dict() bare matches ADict['arrival/toJS']() unmodified` is a protocol-coherence law — the model to migrate the rest toward.
- **P16 capability.test-d (hunt 4):** bare-fn proof RETAG'd; no vacuous or doc-as-test blocks found in it (three real assignability proofs, one guarding an actual historical name collision).
- **P6 z.procedure (hunt 5):** RETAG'd — all four tests pin ctx-free callables; the codec's own doc admits the ban only on *return-direction* bare fns, leaving decode-direction escape unscoped until region discipline lands.
- **P3 any-typed lowering (hunt 6): Clean-with-note** — `lower.ts:125-127` emits `: any` params as declared "advisory polarity" avoiding TS7006; this is honest, not a lie: a scheme lambda's params genuinely accept any value, `unknown` would false-bite every param use inside the body (violating the drops-only governing invariant), and the integration test proves arity still bites via TS2554 against real parameter positions. The type isn't under-describing runtime — it exactly describes it. Future tightening (inference from body usage) is a capability gap, not a P3 violation.

## Clean

- **capability-rosetta-symbol.test.ts** — exemplary P10/P11 coverage: mint-at-edge, forward-without-ctx, `pure:true` never-mints (the seal-laundering guard), deep-stamp; the two `this`-binding tests are deliberately tagged impl-pinning.
- **capability-prelude-only-symbol.test.ts, prelude-overlay.test.ts, env-pack-prelude-scope.test.ts** — behavior-level, phase-gate contract proven at three altitudes incl. the closure-cannot-bridge law; the no-overlay fallback is documented design, not silent tolerance.
- **env-pack.test.ts** — C3 spec-parity vs Python MRO is a model coherence law (P15's preferred form); timeout env-var tagged impl-pinning.
- **collect-prelude.test.ts, resources.test.ts, scheme-zod.test-d.ts** (anti-vacuity `NOT any[]` guard explicitly present) — clean.
- **scheme-zod.test.ts** remainder — number-family door tests are contract refinement (the codec's legitimate job per P7's parenthetical); z.symbol GC regression is a sanctioned harness self-check; z.cons one-cell boundary pin is honest.
- **capabilities-assembled.test.ts** — staged additive sentinel with the ejection-step ledger named in comments; impl-pinning tagged; acceptable P14 staging.
- **fresh-env.test.ts** — harness self-check (P16-sanctioned category); its invariance-across-husk-migration design is the right shape.
- **carriers.test-d.ts, reachability.test-d.ts** — legitimate public-contract bite-guards with real negative `@ts-expect-error` cases (not vacuous); CouldBeList nuke-guard proofs align with the drops-only law.
- **name-escape.test.ts** — the round-trip law + valid-image + fixed-point suite is a promised-bifunctor test done right (P9/P13); reserved-word vs contextual-keyword split is spec-derived.
- **prelude.test.ts, diagnose.test.ts, query.test.ts** — coherence-law style throughout; query.test.ts's directly-asserted "never drop valid/uncertain" invariant is the strongest single test in the cluster.
- **schema-to-ts.test.ts / schema-to-ts-collections.test.ts** remainder — behavior-level printer verdicts; `type`-override precedence deliberately impl-pinning-tagged; fixed-heads structural fallthrough honestly reasoned.
- **lower.test.ts** remainder — exact-string emission tests are the emitter's real contract (integration tests consume the shapes); quote/quasiquote recursion suite kills a real false-positive class.

## Counts

| verdict | count |
|---|---|
| FLIP-TO-FAILS | 1 |
| DELETE | 0 |
| REWRITE | 3 |
| RETAG | 8 |
| RULING-NEEDED | 1 |
| Clean (files fully or substantially clean) | 20 of 26 files |

Skipped per assignment: `oracle-contract.spec.ts`, `contract-precision-fixes.test.ts` (owned by other agents).
