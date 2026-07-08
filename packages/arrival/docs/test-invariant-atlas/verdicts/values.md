## Findings

`coercion-soundness.test.ts > G6 golden(eager-parity) — "Pair · length drops the container box"` — [P10] RULING-NEEDED — container-box drop is blessed via "outside a count's cone" reasoning, matching P10's explicitly forbidden "container was fresh so lineage is empty" rationale; the file's own comment already flags this as a contested ruling awaiting V.

`coercion-soundness.test.ts > "Pair · sort drops the container box" vs "sort(vector) returns a sorted VECTOR (container preserved)"` — [P8/P10] RULING-NEEDED — same term (`sort`) diverges by carrier: Pair-sort drops the container box (spine rebuilt), Vector-sort preserves it (fresh vector, same shape) — exactly the per-carrier divergence P8 forbids, compounded by P10's "rebuilds and therefore drops" pattern.

`coercion-soundness.test.ts > G6 golden(eager-parity) — "Pair · map / filter drop the container box"` — [P10] RULING-NEEDED — same rebuild-and-drop pattern P10 names as its own canonical violation (append/cdr); recurs here for map/filter, pinned green as "characterization, not fixed."

`coercion-soundness.test.ts > "SchemeVector · map crosses out to the AUTO-WRAPPING AJSArray" [RESOLVED: DR4]` — [P8] FLIP-TO-FAILS — THE canonical violation PRINCIPLES.md names outright: vector-map strips element boxes (`elemProvs → [[],[]]`) while vector-filter (same file, stratum 1) and pair-map preserve them; labeled "RESOLVED" but the re-box-on-access mints fresh *empty*-provenance boxes, not the originals — the provenance loss is real and permanent, not deferred.

`clone-identity.test.ts > "membrane.ts — === nil identity-equality sites"` — [P16] REWRITE — both cited bugs (membrane.ts:71 `isSchemeValue`, :326 `toJS`) are already fixed in current source (`instanceof ANil` / full protocol dispatch, verified by reading membrane.ts); tests still pass but the "known bug site" framing is stale.

`clone-identity.test.ts > "bridge.ts — === nil identity-equality sites"` (list-copy) — [P16] REWRITE — cites bridge.ts:985/989, but bridge.ts is now 137 lines with no list-copy at all; the logic moved to `env/r7rs/lists.ts` and is already fixed via `instanceof ANil` at both the entry guard and recursion base (verified). Dead citations describing a deleted architecture.

`clone-identity.test.ts > "fantasy-land-lips.ts — === nil identity-equality sites"` (mapPair/filterPair/reducePair) — [P16] REWRITE — `fantasy-land-lips.ts` no longer exists; map/filter/reduce live directly on `APair` (values/primitives/APair.ts), uniformly `instanceof ANil`-terminated per its own line-514 comment — bugs already fixed, file citations dead.

`clone-identity.test.ts > "fantasy-land-lips.ts:108 — traversePair" it.fails` — [P16] REWRITE — comment admits "the pre-existing assertion reflected the broken-termination shape rather than the algorithm's correct invariant" — a self-admittedly wrong assertion kept `.fails` instead of being rewritten to the correct invariant.

`clone-identity.test.ts > "sandbox-env.ts — === nil identity-equality sites"` (`@`/`@?`) — [P16] REWRITE — `sandbox-env.ts` doesn't exist; the logic is `membrane.ts`'s `readMember`/`hasMember`, already `instanceof ANil`-guarded (verified) — dead citations.

`clone-identity.test.ts > "META — provenance clones break identity-equality systematically"` — [P16] DELETE — pure war-story ledger (`expect(sites.length).toBe(14)` tests nothing observable); explicitly the pattern P16 forbids ("documentation-as-test... war-story ledgers belong in docs"), and it's stale on top — several of its 14 sites are already fixed or point at deleted files.

`tagless-final-equals.test.ts > "LANDMINE pin — eq?/eqv? scalar boundary must NOT widen"` (the `ABool.equals(true) === true` assertion) — [P4] RETAG — asserts the Setoid "IS representation-blind" as a durable fact; this is exactly the scheduled-to-invert case P4 names (blindness inverts to a strict-door throw post bare-value-purge).

`equality-representation.test.ts > "string: boxed ≡ unboxed, symmetric, content-discriminating"` — [P4] RETAG — representation-blind string equality is precisely P4's scheduled inversion (revealed-by "strings crossing out boxed while booleans cross raw"); will flip to a strict-door throw post bare-value-purge.

`equality-representation.test.ts > "boolean: boxed ≡ unboxed, content-discriminating"` — [P4] RETAG — same scheduled inversion, the other half of P4's cited "two invariants pinning opposite exit contracts."

`equality-representation.test.ts > "number: boxed ≡ boxed, exact ≠ inexact"` (comment block) — [P4] RULING-NEEDED — test's own comment flags the plain-JS-number-vs-boxed asymmetry as "a deferred design question (V)" — needs an explicit ruling to align with, or knowingly diverge from, the string/boolean precedent above.

`symbol.test-d.ts > "OLD shape" rows` (for-each/string-map/string-for-each/filter/find/typecheck/curry — 6 tests across 5 describe blocks) — [P16] DELETE — these decode a synthetic, no-longer-used historical contract shape; they exercise no production code path and exist only to narrate the audit's before/after — textbook documentation-as-test.

`keyword-syntax.test.ts > "should test if bare :keyword works"` — [P16] DELETE — vacuous both-outcomes-pass: the try-branch is `expect(true).toBe(true)` regardless of the actual result.

`keyword-syntax.test.ts > "should test if quoted ':keyword works"` — [P16] DELETE — fully vacuous; try-branch asserts nothing meaningful, catch-branch asserts nothing at all.

`keyword-syntax.test.ts > "should test what Claude's actual query needs"` — [P16] DELETE — zero assertions in either branch (console.log only); cannot ever fail regardless of behavior.

## Clean

pair-cycle.test.ts, pair-structure-algebra.test.ts, half-baked.test.ts, symbol.test.ts, symbol.test-d.ts (all rows except the 6 OLD-shape ones above), scheme-string-structure-algebra.test.ts, scheme-vector-algebra.test.ts, scheme-vector-serialization.test.ts, scheme-bool-algebra.test.ts, scheme-bytevector-algebra.test.ts, scheme-string-algebra.test.ts, scheme-symbol-algebra.test.ts, string-contains.test.ts, comparison-divergence.test.ts, boolean-landmine-regression.test.ts (verified NOT a scheduled-inversion case despite surface resemblance — its own doc says these "stay green" after the future boxing flip), vector-cycle-equal.test.ts, vector-map-promise-leak.test.ts, srfi-13-strings.test.ts, srfi-28-format.test.ts, dict.test.ts, clone-identity.test.ts's "nil-clone witness sanity" and "rosetta.ts" describes (verified accurate against current source).

## Counts

- Files with findings: 6 (coercion-soundness, clone-identity, tagless-final-equals, equality-representation, symbol.test-d, keyword-syntax)
- Findings: 18 total — 4 RULING-NEEDED, 6 REWRITE, 1 DELETE (clone-identity META) + 6 DELETE (symbol.test-d OLD-shape rows, counted as one finding line) + 3 DELETE (keyword-syntax vacuous blocks), 1 FLIP-TO-FAILS, 3 RETAG.
- Clean files: 19 of 25.
- Notable meta-finding: `clone-identity.test.ts`'s entire premise (a 14-site `=== nil` ledger) is majority stale — verified against current source that membrane.ts, bridge.ts→lists.ts, fantasy-land-lips.ts→APair.ts, and sandbox-env.ts→membrane.ts sites are already fixed; two cited source files (`fantasy-land-lips.ts`, `sandbox-env.ts`) no longer exist at all.
