# Test Verdicts — the suite judged against PRINCIPLES.md (2026-07-08)

> **Historical record — fully executed.** The mechanical sweep landed (G1, `db850bab44`),
> the ruling queue below is resolved (`docs/test-suite-v2/RULINGS.md`, 2026-07-09), and the
> v1 suite was subsequently retired (G2, `5d4919ad8f`). Kept as the original judgment record;
> file/symbol references describe the pre-rework suite.

Six per-cluster audits, rubric = `docs/PRINCIPLES.md` (P0–P16), evidence = the actual test
files (agents ran suspect tests where the label and the marker disagreed). Full per-cluster
ledgers in [`verdicts/`](verdicts/). Verdict vocabulary is closed:

- **FLIP-TO-FAILS** — green lie: current-broken/principle-violating behavior asserted plain
  green; convert to `it.fails` against the intended behavior
- **DELETE** — museum rows, vacuous assertions, documentation-as-test
- **REWRITE** — right invariant, wrong expression (stale citations, mislabeled test, private
  reads where a public observation exists, exact-string pin of a disclaimed-incidental shape)
- **RETAG** — transitional: true today, INVERTS when a named migration lands; tag with the
  migration gate so the flip is scheduled, not forgotten
- **RULING-NEEDED** — V decides

## Totals

| Cluster | findings | FLIP | DELETE | REWRITE | RETAG | RULING | clean files |
|---|---|---|---|---|---|---|---|
| provenance | 8 | 4 | 2 | 1 | 0 | 1 | 16/20 |
| values | 18 | 1 | ~10 | 6 | 3 | 4 | 19/25 |
| membrane | 17 | 2 | 0 | 1 | 6 | ~8 | 5/13 |
| evaluator | 9 | 0 | 0 | 1 | 4 | 4 | 10/14 |
| env | 9 | 0 | 5 | 0 | 4 | 0 | 14/23 |
| common/type-layer | 13 | 1 | 0 | 3 | 8 | 1 | 20/26 |
| **total** | **~74** | **8** | **~17** | **12** | **25** | **~18** | **84/121** |

## The ruling queue — RESOLVED 2026-07-09
All rulings below (grown to R1–R9 during the sunrise build) are decided; the answers live in
`docs/test-suite-v2/RULINGS.md`. Kept here as the original question record.

## The original queue (18 RULING-NEEDED findings compress to 7 decisions)

**R1 — Exit convention (P4).** Mechanism LOCATED: `op-helpers.ts` comparison paths
short-circuit boxing on empty-provenance operands and return bare JS booleans, while
strings/numbers stay boxed through the same exec path. One ruling resolves: the js-interop
boxed-string/raw-boolean pair, `boolean=?`'s deliberate `z.unknown()`, the r7rs test-helpers'
`num()`/`truthy()` boxed-or-raw tolerance, and schedules the equality-representation-blind
retag flips. Ruling shape: pick ONE exit contract per P4 and fix op-helpers, or bless the
boolean shortcut as a named superset (P13 registry entry).

**R2 — Container-box provenance (P10).** Does `length`/`sort`/`map`/`filter` dropping the
CONTAINER box (elements keep theirs) violate P10, or is "collection-level grouping fact
dropped at count/convert, element lineage survives" the design? coercion-soundness's own
comments defer to V. Resolves 3 rulings + the G6 three-way-divergence REWRITE's target shape.
Note: Pair-sort drops the container box while Vector-sort preserves it — whatever the ruling,
P8 requires ONE answer across carriers.

**R3 — Guard vs conversion in P7 scope.** Is an external instanceof-ENUMERATION legitimate
for type guards (`isSchemeValue` completeness map), or should recognition also route through
a protocol marker? Same ruling covers the scheme-zod spine cycle guard and the AJSArray
`.source` bypass question.

**R4 — Detectability marker vs P9.** `AHalfBaked["arrival/toJS"]()` returns
`{__halfBaked__: "collection"}` — structurally the forbidden P9 marker shape, intentionally a
P5 trip-wire (an unforced carrier should never reach toJS). Which principle governs?

**R5 — Minimal-cone vs teleological sealing.** dataflow-thesis-probes' MEASURE snapshot pins
count-provenance entanglement green while its own comment says the two goals are OPPOSITE and
"the conflict is V's call". The green test IS the undecided question.

**R6 — curly-infix (P14).** `ParserOptions.curlyInfix` exists; `ExecOptions` never forwards
it; no production entry can reach SRFI-105. Wire the flag through, or retag the ~40-invariant
suite as reader-internal and trim.

**R7 — letrec lowering false positive (P0/P15).** A genuinely recursive `letrec` lowers to
flat `s.let` with the binding FREE in value position → TS2304 on a VALID scheme program — a
static-interpreter false bite contradicting the drops-only law query.test.ts pins as
governing. `it.fails` ledger naming the false-bite, or an explicit ruling that advisory
false positives are acceptable outside slot diagnostics.

## The mechanical sweep (no ruling required)

**FLIP-TO-FAILS (8):** golden-prov-arithmetic cdr-spine + append drops; golden-prov-fan A13
leak; deferred-value-egress live-AHalfBaked escape; coercion-soundness DR4 vector-map
box-strip (re-box mints EMPTY-provenance boxes — loss is permanent, not deferred); js-interop
exact-JSON throw + list-JSON throw; schema-to-ts "unknown[] | unknown[]" residual artifact.

**DELETE (~17):** lineage-assumptions' A13/A18b duplicate green pins (×2); clone-identity
META war-story ledger; symbol.test-d OLD-shape rows (×6); env test-d museum rows (×15 across
5 files — converge to numeric.test-d/polyglot.test-d's NEW-side-only shape); keyword-syntax's
3 vacuous blocks.

**REWRITE (12):** clone-identity's stale architecture citations (fantasy-land-lips.ts and
sandbox-env.ts no longer exist; bridge.ts list-copy moved; membrane sites fixed — verified
against source) ×6; benchmark A/B relabel (both sides import the same generator exec —
verified at import level; it measures the public-exec seam, not two evaluators);
generator-exec's mislabeled "promises from JS functions" (contains neither); G6 vector golden
(after R2); z.vector assertions via `__vector__`/`as any` where protocol reads exist;
lower.ts case-emission exact-string pin of a disclaimed shape; sandbox-escape's weak doors
(assert the TAUGHT message per P5, not just "it threw fast"; kill the either-outcome cyclic
equal? assertion).

**RETAG (25):** every transitional finding gets a standard marker comment naming its
migration gate:
- `[INVERTS: bare-value-purge / P4]` — equality-representation blind family,
  tagless-final-equals landmine pin, lists-contract boxed-false unions, r7rs num()/truthy()
  helpers
- `[INVERTS: reverse-membrane / P1]` — evaluator.spec bare-fn env tests ×2, membrane-symmetry
  LAMBDA passthrough, rosetta-environment defineRosetta blocks ×4, capability.test.ts legacy
  fixture, capability.test-d bare-fn arm, scheme-env RosettaSpec wire, input-rest/kwargs
  `env.set(fn)` harnesses, benchmark raw-number ASTs
- `[INVERTS: region-discipline / P6]` — z.procedure's 4 callback tests
- `[STALE-LABEL]` — r7rs-unicode + r7rs-identity "known bugs it.fails" describe titles over
  plain passing `it()`s (bugs long fixed — relabel like r7rs-numbers' "FIXED at …");
  rosetta-environment's full-bodied `it.skip` → `it.todo`; sandbox-escape's eval-fallback
  narrative; srfi.test allSrfi bare count gets its drift-alarm rationale
- `[STAGING: rosetta-pure-marker]` — needs a G-gate-style ledger (P14's model) instead of an
  inline-assembled consumer

**Redundancy (P15 coherence-law preference):** evaluator.spec's hand-AST special-forms block
duplicates generator-exec.spec's string-source block almost 1:1 under chibi's authority —
keep evaluator-only cases (empty begin, if-without-else, nested-if, closures, rest-params),
drop the duplicates. module-composition.spec: DELETE if capability.test.ts +
capabilities-assembled cover resolver ordering at the public altitude (check), else retag as
a deliberate internal unit suite.

**Premise correction recorded:** the legacy SymbolDeclaration arm is migration-gated
(capability.ts:62-69 names the gate), not "pre-prod death" as unqualified — RETAGs stand,
the schedule wording was mine, corrected here.

**Positive controls** (the models the sweep converges toward): chibi harness, tail-call
suite, oracle-contract, golden-prov-infer/special-forms, capability-rosetta-symbol,
env-pack C3-vs-Python-MRO, name-escape round-trip law, query.test.ts's never-drop
invariant, numeric.test-d/polyglot.test-d's NEW-side-only shape, srfi-95's honest `it.fails`.
