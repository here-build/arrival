# TESTING — provenance by perturbation

Test architecture for the attestation campaign (synthesis doc §2c–§2g). The system under
test is a security artifact whose adversary is the program's AUTHOR: a fabricated forensic
verdict getting signed is the catastrophic failure. That inverts the usual test economics —
**the negative flows (forges refused, fail-closed paths exercised) are the product**; the
positive flows (genuine derivations attest) exist so fail-closed doesn't degenerate into
fail-everything. Both are first-class rows in every suite.

Paths below are package-relative unless repo-rooted. Taxonomy per
`.claude/rules/tests.md`: everything here is verdict-shaped (`__tests__/`) except the M1
memory gates (`__benchmarks__/`). No suite in this campaign fires a live LLM — the probe
runs hermetic over hand-authored `ProbeTable`s / recorded `MemoryRunCache` entries.

---

## 1. The red-first law

**Every task ships its suite RED first, and RED means `it.fails` on a green main — never a
failing CI.** The repo is trunk-based with concurrent agents; a red suite lands as:

- **Capability rows** — what the task will make true — written `it.fails(...)` against the
  frozen contract (G1 types, G2 key-spec, G3 verb signatures) plus a fail-closed stub
  (the `extract/arm-*.ts` pattern: stub lifts everything to `opaque("unimplemented/…")`,
  which is I1-sound). The impl agent makes the assertion pass; the flip owner removes
  `.fails`.
- **Fail-closed rows** — what must be true ALREADY, under stubs — written as plain `it`,
  green from day zero, and green forever (a stub that fail-closes correctly passes them).

This split is the *two-sided landing*: `it.fails` is a tripwire in both directions. A row
that stays red at its join is a real defect; a row that goes green EARLY fails the suite
loudly — a stub stopped being a stub without the flip owner knowing (see
`src/__tests__/extract/extract-corpus.test.ts`'s header, the canonical statement). This is
why `it.fails` is mandatory and `it.skip`/`describe.skip` is forbidden for capability rows:
skip is silent in both directions.

**Who flips:** the task's JOIN owner (J1 = the arm-merge owner; J2 = the conjunction
owner), in a dedicated commit touching only test files, row by row. Impl agents never flip
rows, and never edit the corpus or gate suites they are graded by (§6).

**Positive and negative flows are co-equal rows.** A task suite without refusal rows is
incomplete the same way one without success rows is. Concretely: every extract/verdict/
render/verb suite must contain at least (a) one genuine-derivation row that attests or
lifts cleanly, and (b) the forge rows from §2 that the task's surface can express.

---

## 2. The forge taxonomy

Every forge that has been found (or derived from the contracts) and where its permanent
guard row lives. "Corpus" = `src/__tests__/extract/fixture-corpus.ts` (`FIXTURE_CORPUS`);
"probe-adversarial" = `src/__tests__/probe-adversarial.test.ts` (rows 1–9 + 8b over the
predecessor wire/policy plane — stays green until wire/ dissolves, per losable-legacy).

| # | forge | example | guard lives / must live | status |
|---|---|---|---|---|
| F1 | guard-swap | `(if (< (:v e) 1000) "SAFE" (number->string (:v e)))` | corpus row 1; probe-adversarial row 8 | guarded |
| F2 | named-helper guard | `(define (f x) (if (> x 5) "SAFE" x)) (f (:score e))` | corpus row 2; probe-adversarial row 9 | guarded |
| F3 | hidden-const fold | `(fold (λ (acc x) (if (eq? x "s") "FABRICATED" x)) "" (:xs e))` | corpus row 3; collapse-kind suite (T3a) | guarded (red) |
| F4 | literal-residue glue | `(string-append (:id e) "-FAKE")` | probe-adversarial row 2 (wire); **corpus needs the StringProv row** — J1 growth | gap |
| F5 | processed-literal judgment | `(if c (string-upcase "yes") "no")` vs vocab `{yes,no}` | wire policy guard (`isBareLiteral`); **T4 circuit row: judgment alt must be a bare `ConstProv`, never `fused[const]`** | gap (T4) |
| F6 | undeclared vocabulary | `(list-ref (list "fake-a" "fake-b") …)` role:judgment | probe-adversarial row 4; T4 re-anchor | guarded |
| F7 | cancelled flow (static false positive) | `(- (:v e) (:v e))` | probe-adversarial row 5 — probe leg mandatory; J2 conjunction row | guarded |
| F8 | forced-indeterminacy DOS | witness routes into `(define (loop) (loop))` | probe-adversarial row 6; T5c re-run through the production runner | guarded → T5c |
| F9 | kwargs channel | kwarg smuggles a const the attribution drops | arm-B contract (fold into sources); **corpus row missing** — J1 growth | gap |
| F10 | cyclic-binding | recursion through bindings diverges or mislabels | arm contracts (`opaque("cyclic-binding")`); corpus growth row `(define (f x) (f x)) (f (:v e))` | gap |
| F11 | binding-scope confusion | beta-reduction reads callee free names in caller scope | arm-A `Bound.scope` contract; needs let-vs-let* row pair (§5 gap list G-A4) | gap |
| F12 | builtin shadowing | `(let ((+ (λ (a b) "FAKE"))) (+ (:a e) (:b e)))` | **scope must shadow registry in ARM-B callee resolution** — corpus growth row | gap (sharp) |
| F13 | fn-as-value escape | lambda in value position | arm-B: `opaque("fn-as-value")`; corpus growth row | gap |
| F14 | ambient laundering | `(string-append "id-" (number->string (now)))` | mint integrity `"ambient"` (arm-C) + T4 `ungrounded-ambient` row | gap (T4) |
| F15 | apply laundering | `(apply string-append parts)` reads as one clean vertex | §2c coverage: static callee ⇒ beta, else `opaque` — J1 growth row | gap |
| F16 | quote-as-structure | `'("fake" "analysis")` read as build of consts vs ONE const | arm-A Quote contract; corpus growth row | gap |
| F17 | begin-adjacency laundering | `(begin (infer …) "FAKE")` — mint grounds the const by adjacency | arm-A Begin contract (only LAST form flows); corpus growth row | gap |
| F18 | tamper-on-load | flipped byte in a stored crossing payload | `key-spec.ts::verifiedPayload` (green now); T5b cache suite (every-load verify) | guarded → T5b |
| F19 | fake-positive leakage | any surface emits `content-attested`/`selection-attested` before its leg is live | emitter census gate (§4.2) + T6a door-text row | red (T6a in flight) |
| F20 | budget/overflow partiality | budget trip emits a truncated circuit (under-approximates the const-set) | I1: overflow ⇒ `opaque`; totality fuzz (§4.1) + an explicit deep-tower row in the J1 growth set | gap |
| F21 | mispairing upgrade | static verdict of leaf A paired with probe verdict of leaf B | `seal.ts` header's documented trusted-base hole; **J2 row: per-leaf pairing is mechanical through the MCP path** (row-3 two-leaf program) | gap (J2) |
| F22 | route-as-combine collapse | `(fold max …)` or a non-AC body collapsed to one `fused` | T3a suite: combine ONLY for the enumerated void-free AC list | red (T3a) |
| F23 | free-builtin-as-evidence | free `Ref` to an env builtin in value position becomes `InputProv` | §2c mandatory rule: builtin ref ⇒ `opaque`, never input/vertex — **arm-A stub header omits it**; corpus growth row | gap (sharp) |
| F24 | mark-destroying transform (known refusal, availability not security) | `(string-upcase (:id e))` — mark uppercased, containment misses | documented-refusal row in T5c suite: seals `not-attestable`, and that is CORRECT (fail-closed); do not "fix" by weakening containment | to document |

Rows marked *gap* are the **J1/J2 corpus growth ledger**: each becomes a `FIXTURE_CORPUS`
row (extract-side) and/or a T4/J2 row (verdict-side), landed `it.fails` NOW by the
test-author lane, flipped at their join. The corpus is append-only for agents: rows are
added by the architect/test-author lane, never edited by impl agents.

---

## 3. Suite inventory

### Exists (this package unless noted)

| suite | what it holds | category |
|---|---|---|
| `src/__tests__/probe-adversarial.test.ts` | rows 1–9 + 8b: wire ∧ probe ∧ seal over the predecessor plane. The J-baseline; stays green until `wire/` dissolves | `__tests__` |
| `src/__tests__/probe-harness.test.ts` | probe session mechanics (substitution seam, table order) | `__tests__` |
| `src/__tests__/wire-descriptor.test.ts` | predecessor static plane | `__tests__` |
| `src/__tests__/extract/fixture-corpus.ts` | the dual-use corpus: `ProvPattern` language, `mismatch()`, 5 seed rows | shared artifact |
| `src/__tests__/extract/extract-corpus.test.ts` | the J1 gate, `it.fails` per row | `__tests__` |
| `src/fuzz/` | fast-check machinery: `arbitrarySchemeValue` (values), `narrows-fuzz` (program synthesis) | library |
| `inhuman/foundations/arrival-effects/src/__tests__/data-effects.test.ts` | effect-log behavior | `__tests__` |
| `inhuman/saas/mcp-worker/src/__tests__/smoke.test.ts` (+ `stubs/`) | worker harness precedent for J2/T5c placement | `__tests__` |

### In-flight tasks add (batch 1)

- **Arms A/B/C (T2)** — no new suite files; they make `extract-corpus.test.ts` rows
  flippable and must keep the totality fuzz (§4.1) green. Their briefs' gaps are
  retrofitted as corpus growth rows at verification (§2 + final gap list).
- **T4 (verdict channel)** — `src/__tests__/extract/circuit-verdict.test.ts`,
  fixture-first over hand-built circuits in `src/__tests__/extract/circuit-fixtures.ts`
  (every hand-built circuit gated by `matches()` against its corpus row — §4.3). Rows: the
  five seeds' verdicts; F5 bare-vs-processed; F14 ungrounded-ambient; guard-const excluded
  from residue; opaque-on-content-path ⇒ `not-attestable` (no residue) vs const-on-path ⇒
  fabrication (with residue); fan-lowered-with-const refused; choice with ALL-evidence alts
  is content-eligible (the over-strictness check — mirrors `isCleanContent`'s Case rule).
- **T6a (verbs + doors)** — `inhuman/foundations/arrival-reflect/src/__tests__/`
  (beside `reflect-capability.test.ts`): verbs registered; `(grounded? h)`/`(attest h)`
  return DOORS carrying the trace-based `groundingVerdict` marked ADVISORY; door text
  asserts advisory-never-verdict; per-leaf addressing in the frozen signature (F21
  depends on it); `ResultHandle.attested()` memoize/door discipline.

### Remaining tasks add

| task | suite (new file) | category |
|---|---|---|
| T3a | `src/__tests__/extract/collapse-kind.test.ts` (+ module `src/extract/collapse.ts` stub returning `"lowered"`) | `__tests__` |
| T5a | `inhuman/foundations/arrival-effects/src/__tests__/hashed-effect-key.test.ts` | `__tests__` |
| T5b | `inhuman/foundations/arrival-effects/src/__tests__/crossing-cache.test.ts` | `__tests__` |
| T5c | `inhuman/saas/mcp-worker/src/__tests__/run-probe.test.ts` | `__tests__` |
| T7a | `src/__tests__/model/to-wireframe.test.ts` (projection; ELK screenshot rows belong to the studio package's `__visual__`, not here) | `__tests__` |
| T8a/T8b | `inhuman/saas/mcp-worker/src/__benchmarks__/do-ceiling.test.ts` + `vitest.benchmarks.config.ts` + `benchmarks` script (peer of `test`, mirroring `here.build/saas/common/mercury-interpreter/vitest.benchmarks.config.ts`) | `__benchmarks__` |
| J1 | no new file — the flip protocol over `extract-corpus.test.ts` + growth rows (§4.4) | `__tests__` |
| J2 | `inhuman/saas/mcp-worker/src/__tests__/attest-conjunction.test.ts` | `__tests__` |

Nothing in this campaign belongs to `__research__`, `__custdev__`, or `__experiments__`.
If someone proposes an LLM-in-the-loop validation of verb ergonomics later, that is a
`__custdev__` suite in arrival-reflect — out of scope here.

---

## 4. Cross-cutting invariant suites

Invariant suites are **always-green from day zero** (they hold under stubs) and run in the
default gate. They are never `it.fails` and never flipped.

### 4.1 I1 totality fuzz — `src/__tests__/extract/extract-totality.fuzz.test.ts`

New generator `src/fuzz/coreform-arbitrary.ts` beside the existing fuzz machinery:
compose `arbitrarySchemeValue` (literal payloads) with a form-shape arbitrary emitting
SOURCE TEXT over the full surface — atoms, quotes, all four let kinds, nested defines,
lambdas applied and un-applied, recursion (self and mutual), `if/and/or/when/cond`,
`map/filter/fold` with lambda and named bodies, kwargs, dicts, string ops, `infer`/`now`
crossings, free refs, doors (unparseable heads), depth ≥ the extract budget. Properties,
via `extractProgram(classify(desugar(parseSexprs(src))).forms, defaultRegistry)`:

1. **Never throws** (parse/classify failures are excluded upstream by construction or
   caught and skipped — extract itself must not throw on any classified program).
2. **Returns the union** — every node of the result recursively has `kind` ∈ the 10
   `StaticProv` members; **no `Super` leaks** into a finished circuit.
3. **Pure** — extract twice, structurally equal.
4. **Terminates** — the vitest timeout is the proxy; recursion-heavy samples are the point
   (the cycle guard is what's under test).

fast-check with explicit `numRuns` (start 500); on failure print the shrunk source and the
seed (repro discipline per `narrows-fuzz.test.ts` precedent, which also establishes that
seeded fuzz lives in `__tests__`).

### 4.2 The emitter census (no-fake-positives) — `src/__tests__/attestation-emitter-census.test.ts`

Mechanical enforcement of the staging law ("no code path may emit
`content-attested`/`selection-attested` until its leg is live" — and after J2, "except
through the seal"). The test walks the three consumer surfaces from the repo root:

- `inhuman/foundations/arrival-mercury/src`
- `inhuman/foundations/arrival-reflect/src`
- `inhuman/saas/mcp-worker/src`

globs `**/*.ts` excluding `__tests__`/`__benchmarks__`, and asserts every occurrence of a
POSITIVE-verdict construction (`kind: "content-attested"` / `kind: "selection-attested"`,
matched as object-literal construction, not mere type mention) appears only in the
allowlist: **`arrival-mercury/src/seal.ts`** — the one constructor. Type declarations
(`seal.ts`'s union) and door TEXT that *names* the verdicts are fine only when the file is
allowlisted or the string is inside a `not-attestable` reason/door payload; the test's
allowlist is explicit and editing it is the review moment. A missing directory fails the
test (loud on relocation, never silently narrower). Precedent for scan-style gates in this
package: `preamble-door-scan.test.ts`, `rule-lint.test.ts`.

### 4.3 Corpus dual-use integrity — fixture drift impossibility

The mechanism (already true for J1, extended to every fixture-first consumer):

- There is ONE row source: `FIXTURE_CORPUS`. Consumers import it; nobody copies rows.
- Extract-side (J1): `extract(row.source)` is matched against `row.expected` — the same
  artifact grounds producer and consumer.
- Fixture-first consumers (T4, T7a) need CONCRETE circuits, which patterns (wildcarded,
  site-blind) cannot mint. Hand-built circuits live in
  `src/__tests__/extract/circuit-fixtures.ts`, and **every hand-built circuit is gated in
  its own suite by `expect(mismatch(handBuilt, FIXTURE_CORPUS[i].expected)).toBeNull()`
  before use**. Corpus row changes then break the hand-built twin loudly.
- At J1, fixture-first joins real: the hand-built inputs are replaced by
  `extractProgram(row.source)` in the same suites (the W2 "fixture→real joins"), and
  `circuit-fixtures.ts` shrinks to whatever J1 has not yet covered.
- Impl agents never edit `fixture-corpus.ts`, `extract-corpus.test.ts`, the census, or the
  fuzz suite. Additions come through the test-author lane.

### 4.4 The J1 flip protocol

Flip owner: the single arm-merge owner (§2g: "ONE owner merging"). Preconditions per row:

1. All three arms merged on main; `tsc --build` green (build authoritative, not `--noEmit`).
2. The row passes with `.fails` removed, locally, via the standard parallel `pnpm test`.
3. Totality fuzz (§4.1), emitter census (§4.2), and `probe-adversarial.test.ts` all green
   at the merge commit — J1 does not touch `wire/`; the predecessor plane keeps working
   until T4 re-points the seal and losable-legacy dissolution happens explicitly.
4. The flip commit contains ONLY `.fails` removals (explicit pathspec), cites J1.
5. The J1 growth rows (§2 ledger: F4, F9, F10, F12, F13, F15, F16, F17, F20, F23, plus the
   both-branches-clean positive) are IN the corpus by flip time — `it.fails` where the arm
   contract covers them, so J1 flips them too or leaves them red with a named defect.

If a corpus row goes green while `.fails` is still on (suite fails loud): the arm agent
STOPS and pings the flip owner — a stub went live early. Never self-flip.

### 4.5 The J2 conjunction gate — `inhuman/saas/mcp-worker/src/__tests__/attest-conjunction.test.ts`

THE security gate; nothing attests before it. The full adversarial corpus THROUGH the MCP
path: build a `ResultHandle` per row via `discovery-run.ts`'s own entry points (recorded
`MemoryRunCache`, hermetic infer stubs per `smoke.test.ts`/`stubs/` precedent), dispatch
`(attest h)` / `(grounded? h)` through the reflect registry (the real wire path, not a
direct `seal()` call), and assert the SEALED verdict:

- forges F1, F2, F3 (+ probe-adversarial rows 4–6 translations): every leaf
  `not-attestable`;
- genuine rows (corpus 4–5, probe-adversarial 8b): `content-attested`;
- judgment row (probe-adversarial row 1 with declared vocabulary): `selection-attested`;
- **F21 mispairing**: the two-leaf program `(cons (:name e) "FABRICATED_ANALYSIS")` —
  car `content-attested`, cdr `not-attestable`, per-leaf, through the verb's own pairing
  (the public path must offer no API that could cross-pair);
- F7 cancelled flow: static candidate + probe `ungrounded` ⇒ `not-attestable` (the
  conjunction's other veto direction);
- F8 DOS: witness-forced non-termination ⇒ `indeterminate` probe leg ⇒ `not-attestable`,
  attributed;
- door-degradation: with the probe leg artificially absent, `(attest h)` returns the
  advisory door, never a verdict (staging law holds even post-J2 for missing legs).

Red pre-J2: the whole file is `it.fails` capability rows against the T6a-frozen verb
signatures (the doors make every row's assertion fail exactly as intended until T6c).
Flip owner: the J2/T6c owner. Impl agents may not edit this file (§6).

---

## 5. M1 memory gates — `inhuman/saas/mcp-worker/src/__benchmarks__/do-ceiling.test.ts`

Category `__benchmarks__` (opt-in CI): config `vitest.benchmarks.config.ts` whitelisting
`src/__benchmarks__/**/*.test.ts`, script `"benchmarks"` as a peer of `test` (mirror
`here.build/saas/common/mercury-interpreter/`). Never a default-CI gate; the M1 rows are
ceiling ASSERTIONS, so they read as pass/fail when run.

The harness (T8a, buildable before any seal code exists):

- **DO-shaped ceiling** = spawn `node --max-old-space-size=128` on a driver script (the
  scratchpad-built driver imports the surface under measure); the row asserts exit 0 and
  reports peak `v8.getHeapStatistics().used_heap_size` sampled around the run. The
  interpreter's own heap-charge (`ARRIVAL_HEAP_MAX`, see
  `inhuman/foundations/llm-plane-arrival-chain/src/__tests__/chain-env-heap-budget.test.ts`)
  meters CHARGE UNITS, not bytes — use it as the eval budget knob, not the ceiling proof.
- **Harness negative control (T8a's red-first shape)**: a deliberately over-budget driver
  (allocate >128MB) MUST make the row fail. A ceiling harness that cannot fail is vacuous;
  this row is green day one and stays.
- **Calibration-equation row**: measure isolate baseline + wiring on an empty run; assert
  `configuredEvalBudget ≤ 128MB − measuredBaseline − oneCrossingBuffer`. This is the "do
  not hardcode 100M inside a 128MB box" consequence made executable — it FAILS if the
  deployed default (currently the 100M-class heap charge) plus measured overhead exceeds
  the box.

The seal rows (T8b, land after J2, `it.fails` until then):

- **small = full surface**: a small program (≤5 crossings) runs causal + `(attest h)` +
  teleological under the ceiling.
- **medium = seal-only**: a program whose teleological trace exceeds the trace budget
  (teleological() doors) but whose seal path fits — assert `(attest h)` succeeds, the
  teleological door fires, peak stays under ceiling. This pins the verb-family split along
  the memory boundary (M1.2: the door is correct behavior, not a limitation).
- **probe residency**: peak during a probe re-run ≈ ONE evaluation working set — assert
  the perturbed crossing's real payload is never loaded (cache spy) and Σ-crossings never
  resident (M1.3).

---

## 6. Test/impl separation

The corpus already IS the separated test for extract: `fixture-corpus.ts` +
`extract-corpus.test.ts` were authored by the architect lane, the arms make them green,
and neither edits the other's files. Extend that shape only where it buys independence
that matters:

| task | verdict | why |
|---|---|---|
| T3a collapse-kind | **SPLIT** | forgery-critical (combine-when-shouldn't signs a fabrication, F22); contract is crisp (§2c two-regimes + the enumerated AC list) — a red suite writes itself from the doc, and an impl agent grading its own collapse decisions is the exact fox/henhouse the law forbids |
| T5a key hashing | no split | mechanical migration under an already-frozen G2 spec with known-answer vectors; the replay-equality gate is unambiguous; one agent + verification review |
| T5b crossing cache | **SPLIT** | the tamper gate is the DFIR promise (F18); refusal rows (flipped byte, hot-tier corruption, forged address) must be authored by someone not invested in the cache's happy path |
| T5c runProbe | **SPLIT** | the gate is "the probe-adversarial suite through the RUNNER, not the harness" — independence is the point; a test-author ports rows 1–9 to the runner API, the impl agent must reproduce the harness's verdicts without reusing harness code |
| T7a projection | no split | the money table (§2f) is the spec and the rows are mechanical; the security-relevant rows (const never prettified, opaque never upgraded) are few — retrofit at verification instead |
| T8a harness | no split | the harness carries its own negative control (must-trip row); splitting a measurement harness is ceremony |
| J1 | the protocol IS the split | arms implement, the merge owner flips a suite neither wrote |
| J2 | **SPLIT, frozen** | THE security gate: `attest-conjunction.test.ts` is authored by the test-author lane and is read-only for every impl agent; changes go through the architect |

Global law regardless of split: **impl agents never edit** `fixture-corpus.ts`,
`extract-corpus.test.ts`, `attestation-emitter-census.test.ts`,
`extract-totality.fuzz.test.ts`, or `attest-conjunction.test.ts`. A contract problem in a
row is raised, not patched around.
