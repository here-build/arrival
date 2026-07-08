# Test Suite v2 — Removal Manifest

*Everything the consolidation removes, with the invariant value each item carried and where
that value SURVIVES in the new suite. Rule: nothing is deleted until its surviving home is
named — a removal without a survivor row is a coverage regression, not a cleanup.*

Legend: → `laws/` `conformance/` `membrane/` `provenance/` `doors/` `ledger/` are the v2
suites (see DESIGN.md). "gone" = the invariant was a lie/vacuous/duplicate; nothing survives
because nothing true was enforced.

## A. Whole files removed

| File | What it carried | Survivor |
|---|---|---|
| `keyword-syntax.test.ts` | 3 real accessor cases inside exploratory noise | accessor cases → `laws/accessor.law.test.ts` table; vacuous blocks → gone |
| `module-composition.spec.ts` | resolver-ordering contract via private `_lookupWithResolvers` | public-altitude row in `laws/env-resolution.law.test.ts` (capability-assembled path); if unreachable publicly, ONE retagged internal unit stays |
| `clone-identity.test.ts` | nil-clone regression war story; 14-site `=== nil` ledger (majority stale, 2 cited files deleted) | nil-clone-tolerance becomes ONE law row: `laws/identity.law.test.ts` — "every spine/guard treats a provenance Nil clone as nil" × carriers; the war story → `docs/archaeology/nil-clone-sweep.md` |
| `evaluator-benchmark.spec.ts` | fictional LIPS-vs-generator A/B; real content = exec-seam overhead | `__benchmarks__/exec-seam.bench.ts` honest single benchmark, no A/B |
| `chibi-r7rs.spec.ts` (v1 harness) | THE value-layer conformance law + registries + anti-vacuity | chibi harness v2 (`conformance/`) — removal gated on v2 reaching registry parity + the >500-pass floor |
| `rosetta-environment.test.ts` | legacy defineRosetta exercises + conversion round-trips | conversions → `membrane/crossing.law.test.ts` tables; defineRosetta rows → `ledger/` `[INVERTS: reverse-membrane]` until the legacy arm dies, then gone |
| `equality-representation.test.ts` | representation-blind equality (transitional tolerance) | ONE table in `laws/equality.law.test.ts` with per-row `[INVERTS: bare-value-purge]` tags; post-purge the rows flip to strict-door throws |
| `dataflow-thesis-probes.test.ts` | falsification probes for undecided design (R5) | `ledger/` as it.todo gated on the R5 ruling — a probe of an undecided question is a staged spec, not a green test |
| `half-baked.test.ts` | AHalfBaked carrier mechanics in isolation (interval narrowing, early decide, force/refine fold) | gone: AHalfBaked itself dissolved (halfbaked-existence-review.md, VERDICT KILL — zero production reachability, superseded by R2/C3 struct-fact wires); the motivating program moved to execution-plan-wireframe.md §8 as a struct-fact-wire acceptance criterion |
| `speculative-eval.test.ts` | Tier-2 speculation end-to-end oracle (equivalence + early-collapse-vs-hang) | gone: the equivalence floor became vacuous once the producer wiring died — speculate-on and speculate-off are now the SAME code path by construction, not by proof |
| `deferred-value-egress.test.ts` | force-on-egress hazard characterization (a live AHalfBaked crossing exec's boundary) | gone: same VERDICT KILL as above — no carrier can exist, so there is nothing left to force at egress |

## B. Blocks/rows removed from surviving files

| Site | What it carried | Survivor |
|---|---|---|
| golden-prov-arithmetic "documented asymmetries" (cdr spine, append) — green pins | the DROP behavior (a lie) | `it.fails` rows in `provenance/conservation.law.test.ts` asserting the CORRECT propagation (P10); flip green when the conservation repair lands |
| golden-prov-fan A13 green pin + lineage-assumptions A13/A18b duplicates ×2 | the over-attribution leak ×3 | ONE `it.fails` row in `provenance/conservation.law.test.ts` (count-cone minimality), G2 gate cited |
| coercion-soundness DR4 vector-map cross-out golden | the box-strip (permanent empty-provenance loss) | `it.fails` row in `laws/term-carrier.law.test.ts`: map preserves boxes × EVERY carrier |
| coercion-soundness container-box drop rows (length/sort/map/filter) | contested P10 container question | R2-gated: ledger rows until ruled, then law rows either way |
| deferred-value-egress live-escape green "CHARACTERIZATION" | the leak | `it.fails` in `membrane/egress.law.test.ts` (force-on-egress), existing todos absorbed |
| js-interop exact-JSON + list-JSON green throws | BigInt JSON gap ×2 | `it.fails` rows in `membrane/crossing.law.test.ts` |
| js-interop raw-boolean exit row | half of the P4 contradiction | R1-gated: the exit-contract TABLE in `membrane/crossing.law.test.ts` asserts ONE convention for all types |
| symbol.test-d OLD-shape rows ×6; env test-d museum rows ×15 (lists 6, vectors 4, strings 2, bytevectors 2, binding 1) | narration of pre-fix shapes | gone (NEW-side rows survive in place; `numeric.test-d`/`polyglot.test-d` are the converged shape) |
| clone-identity META ledger (`sites.length === 14`) | documentation | `docs/archaeology/` |
| schema-to-ts `"unknown[] \| unknown[]"` green residual | union-dedup gap | `it.fails` asserting `"unknown[]"` |
| sandbox-escape weak doors (make-string/make-vector caught-only, nested-parse message, either-outcome cyclic equal?) | DoS caps exist | rewritten rows in `doors/resource-caps.law.test.ts` asserting the TAUGHT message (P5), one committed behavior for cyclic equal? |
| evaluator.spec hand-AST special-forms duplicates of generator-exec rows | nothing beyond duplication | gone; evaluator-only cases (empty begin, if-without-else, nested-if, closures, rest-params) move into generator-exec string-source tables |
| generator-exec "promises from JS functions" (mislabeled) | cross-form lambda persistence | renamed row in the same file |
| r7rs-unicode/-identity "known bugs (it.fails…)" describe titles | nothing — bugs fixed, labels stale | retitled "FIXED at …" in place (files survive) |
| r7rs num()/truthy() boxed-or-raw helpers | masked the exit-convention inconsistency | gone after R1: helpers replaced by the single exit contract |
| membrane.spec symbol quoted-name green pin (todo-in-comment) | the opaque-symbol gap | `it.fails`/`it.todo` per the opaque-symbol design |
| rosetta-pure-marker inline-assembled Classifier consumer | pure/pipe classification semantics | `provenance/` law rows + a P14 staging ledger naming the production wiring gate |
| lists-contract "is_pair-shadow swap byte-identical" spot-checks | helper-equivalence impl-pin | gone (cyclic-list-ops + chibi cover the behavior) |
| curly-infix flag-on suite (~40) | SRFI-105 semantics behind an unwired flag | R6 RULED: n-expressions force-eliminated — the reader's curly-infix MODE is deleted; `{a * b}` gets an explicit BAN door (educational, points at dict-literal grammar + sugarcoat); suite shrinks to ban-door + dict-grammar rows in `doors/`; neoteric syntax lives in arrival-sugarcoat only |
| crossing.law "egress of deferred carriers" block (3 `it.fails`) | the force-on-egress contract for a live AHalfBaked crossing exec's boundary | gone: AHalfBaked dissolved (halfbaked-existence-review.md, VERDICT KILL) — the gap became UNREACHABLE, not fixed (no carrier can exist, so there is nothing left to force); ledger GAPS row "live AHalfBaked escapes exec under speculate" retired to a comment |

## C. Retagged in place (not removed — expiry-tagged)

All 25 RETAG rows from VERDICTS.md get standard markers and stay until their gate:
`[INVERTS: bare-value-purge/P4]`, `[INVERTS: reverse-membrane/P1]`,
`[INVERTS: region-discipline/P6]`, `[STALE-LABEL]` fixes, `[STAGING]` ledgers.
The v2 `ledger/` suite owns the gate index: one table mapping every tag → the migration that
flips it → the law row that replaces it.

## D. Explicitly kept as-is (positive controls)

tail-call, oracle-contract, golden-prov-infer/special-forms, capability-rosetta-symbol,
env-pack (C3 vs Python MRO), name-escape, query.test.ts, prelude/diagnose, let-bracket +
cond-case-do door suites, syntax-rules trio, parser.test, sandbox-boundary, both
polyglot-rich-errors suites, all contract-precision suites, the algebra law-harness files,
purity-doors, provenance-algebra.property, tap.spec, collapse-provenance,
provenance-deep-stamp, attestation, abort, escaped-symbols, srfi-13/28,
comparison-divergence, boolean-landmine (verified non-inverting), lineage suite (staged via
G-gates), scheme-zod suites minus the flagged rows.
