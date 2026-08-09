# TESTING — provenance by perturbation

Test architecture for an attestation system whose adversary is the program's own author: a
fabricated forensic verdict getting signed is the catastrophic failure. That inverts the
usual test economics — **the negative flows (forges refused, fail-closed paths exercised)
are the product**; the positive flows (genuine derivations attest) exist so fail-closed
doesn't degenerate into fail-everything. Both are first-class rows in every suite.

Paths below are package-relative. No suite in this campaign fires a live LLM — every probe
runs hermetic, over hand-authored fixture tables or recorded run caches.

---

## 1. The red-first law

**Every capability ships red first, and red means `it.fails` on a passing suite — never a
failing CI.** A capability row — what a change will make true — is written `it.fails(...)`
against the frozen contract, alongside a fail-closed stub: the stub lifts every
unimplemented path to `opaque("unimplemented/…")`, which is safe by construction (see the
`extract/arm-*.ts` pattern). The row only turns green once the capability is actually
implemented, at which point `.fails` comes off.

A fail-closed row — what must already be true, even under a stub — is written as a plain
`it`, green from day zero, and stays green forever; a stub that fail-closes correctly
passes it automatically.

This is a two-sided tripwire. A row that stays red past when it should land is a real
defect. A row that goes green EARLY — a stub passing a capability test it shouldn't — means
the stub silently stopped being a stub. That's why `it.fails` is mandatory for capability
rows and `it.skip`/`describe.skip` is forbidden: skip is silent in both directions, so
neither failure mode gets caught.

**Positive and negative flows are co-equal rows.** A suite without refusal rows is
incomplete the same way one without success rows is: every extract/verdict/render/verb
suite needs at least one genuine-derivation row that attests or lifts cleanly, plus the
forge rows from §2 that its surface can express.

---

## 2. The forge taxonomy

Every forge found (or derivable from the contracts), with a minimal example.

| # | forge | example |
|---|---|---|
| F1 | guard-swap | `(if (< (:v e) 1000) "SAFE" (number->string (:v e)))` |
| F2 | named-helper guard | `(define (f x) (if (> x 5) "SAFE" x)) (f (:score e))` |
| F3 | hidden-const fold | `(fold (λ (acc x) (if (eq? x "s") "FABRICATED" x)) "" (:xs e))` |
| F4 | literal-residue glue | `(string-append (:id e) "-FAKE")` |
| F5 | processed-literal judgment | `(if c (string-upcase "yes") "no")` against vocabulary `{yes,no}` |
| F6 | undeclared vocabulary | `(list-ref (list "fake-a" "fake-b") …)` in judgment role |
| F7 | cancelled flow (static false positive) | `(- (:v e) (:v e))` |
| F8 | forced-indeterminacy DOS | witness routes into `(define (loop) (loop))` |
| F9 | kwargs channel | a kwarg smuggles a const that attribution drops |
| F10 | cyclic-binding | recursion through bindings diverges or mislabels |
| F11 | binding-scope confusion | beta-reduction reads callee free names in caller scope |
| F12 | builtin shadowing | `(let ((+ (λ (a b) "FAKE"))) (+ (:a e) (:b e)))` |
| F13 | fn-as-value escape | a lambda appears in value position |
| F14 | ambient laundering | `(string-append "id-" (number->string (now)))` |
| F15 | apply laundering | `(apply string-append parts)` reads as one clean vertex |
| F16 | quote-as-structure | `'("fake" "analysis")` read as one const instead of a build of consts |
| F17 | begin-adjacency laundering | `(begin (infer …) "FAKE")` — the const gets grounded by mere adjacency |
| F18 | tamper-on-load | a flipped byte in a stored crossing payload |
| F19 | fake-positive leakage | a surface emits a positive verdict before its guard path is live |
| F20 | budget/overflow partiality | a budget trip emits a truncated circuit that under-approximates the const-set |
| F21 | mispairing | the static verdict of one leaf paired with the probe verdict of another |
| F22 | route-as-combine collapse | `(fold max …)`, or any non-associative-commutative body, collapsed to one fused node |
| F23 | free-builtin-as-evidence | a free reference to an environment builtin in value position read as input evidence |
| F24 | mark-destroying transform | `(string-upcase (:id e))` — the mark gets uppercased, so containment misses it |

F24 is a documented refusal, not a bug: the correct, fail-closed response is to seal
`not-attestable` rather than weaken containment to chase availability.

---

## 3. Invariant suites

### Corpus dual-use integrity

One fixture corpus grounds both the extractor and every consumer that needs concrete
circuits: there is one row source, `FIXTURE_CORPUS`
(`src/__tests__/extract/fixture-corpus.ts`); consumers import it, nobody copies rows.

- `src/__tests__/extract/extract-corpus.test.ts` (the J1 gate) matches
  `extractProgram(row.source)` against `row.expected` for every row — the same artifact
  grounds producer and consumer. Per the red-first law (§1), a row runs `it.fails` until
  its `landed` flag flips, then plain `it` forever; every row currently in the corpus is
  landed.
- `src/__tests__/extract/arm-control.test.ts` and
  `src/__tests__/extract/recursion-fan.test.ts` re-run selected corpus rows directly
  against the same pattern matcher (`mismatch`, from `fixture-corpus.ts`), so a regression
  there is the same signal as a J1 regression.
- `src/__tests__/extract/circuit-sharing.test.ts`, `src/__tests__/extract/collapse-kind.test.ts`,
  `src/__tests__/model/compose-template.test.ts`, and `src/__tests__/model/collapse-view.test.ts`
  import `FIXTURE_CORPUS` as concrete circuits for their own consumer-side assertions.
