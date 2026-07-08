## Audit: `foundations/arrival/arrival/src/env/__tests__/`, `env/r7rs/__tests__/`, `env/srfi/__tests__/`

All 23 files read against `docs/PRINCIPLES.md` (P0–P16) and cross-checked against `docs/test-invariant-atlas/env.md`.

### Findings

`env/r7rs/__tests__/binding.test-d.ts > "values" > "OLD shape (z.array(z.custom<unknown>())) decoded flat unknown[] / unknown"` — [P16] DELETE — pins a retired synthetic schema as documentation-as-test; the DecodedArgs mechanism is already proven in `symbol.test-d.ts`, keep only the NEW-shape + negative-compile rows. **EXECUTED** (2026-07-08 mechanical sweep — deleted; NEW-side row survives).

`env/r7rs/__tests__/bytevectors.test-d.ts > "wholly-variadic homogeneous element domains" > both "OLD bytevector[-append] shape ... decoded FLAT unknown[]" rows` — [P16] DELETE — same museum-row pattern; NEW-shape rows + the negative-compile block already carry the load-bearing proof. **EXECUTED** (2026-07-08 mechanical sweep — both deleted; NEW-side rows survive).

`env/r7rs/__tests__/lists.test-d.ts > 6 separate "OLD shape ... decoded [unknown...]" rows (cons, map, make-list, list-tail/list-ref, memq-family, member/assoc)` — [P16] DELETE — none guards a reachable regression (the retired schema isn't wired to any production pack); keep NEW-side + negative-compile rows only. **EXECUTED** (2026-07-08 mechanical sweep — all 6 op-groups' OLD-shape assertions removed (cons/map/make-list as standalone tests; list-tail-list-ref/make-list-output as the OLD half of a combined test, trimmed); NEW-side rows survive in every case. `list->array`/`flatten`'s own OLD+NEW combined rows were left untouched — not named among these 6 in the ledger).

`env/r7rs/__tests__/strings.test-d.ts > "array-element tightening" + "list-shaped slots" > 2 "OLD shape ... decoded ..." rows` — [P16] DELETE — same pattern. **EXECUTED** (2026-07-08 mechanical sweep — both deleted).

`env/r7rs/__tests__/vectors.test-d.ts > "element/return precision" > 4 "OLD z.array/z.custom<unknown>() decoded ..." rows (vector, vector-append, vector-ref x2)` — [P16] DELETE — same pattern. **EXECUTED** (2026-07-08 mechanical sweep — all 4 deleted).

`env/__tests__/srfi.test.ts > "@here.build/arrival/srfi" > "allSrfi exposes the whole set" (toHaveLength(13))` — [P16] RETAG — bare unexplained count, unlike every sibling pack-count pin in this scope (11/22/23/32/81 all carry a "the scope this fix/review must cover" rationale comment); add the same one-line drift-alarm rationale. **EXECUTED** (2026-07-08 mechanical sweep — test renamed to carry the same "the scope this fix must cover" rationale as its 5 siblings).

`env/r7rs/__tests__/lists-contract-precision.test.ts > "STATIC-only fixes" > "memv/assq/assv/member/assoc: output is z.union([z.value, z.booleanFalse])"` — [P4] RETAG — asserts green that a raw JS `false` still slips through the permissive `z.value` arm; this is exactly the boxed-vs-raw membrane tolerance P4 names (same shape as `boolean=?`'s `z.unknown()` in `src/__tests__/contract-precision-fixes.test.ts`, just outside this scope) — cite P4, note it inverts to a strict door once the bare-value purge lands. **EXECUTED** (2026-07-08 mechanical sweep — `[INVERTS: bare-value-purge/P4]` marker added; test itself is currently RED as of this sweep due to unrelated concurrent production changes to `env/r7rs/lists.ts`/scheme-zod — see gate report, not caused by this comment-only edit).

`env/r7rs/__tests__/lists-contract-precision.test.ts > "STATIC-only fixes" > "member/assoc: ... compare predicate's return type is now unknown not boolean (matches the file's is_false-guarded actual usage...)"` — [P4] RETAG — documents the compare callback's return staying boxed-ABool-or-raw-boolean tolerant by design; same transitional-tolerance class P4 flags, will invert once boxed/raw duplication is purged. **EXECUTED** (2026-07-08 mechanical sweep — `[INVERTS: bare-value-purge/P4]` marker added).

`env/r7rs/__tests__/lists-contract-precision.test.ts > "behavior spot-checks: is_pair-shadow swap ... byte-identical" (list-tail/list-ref/list-copy)` — [P16] RETAG-or-DELETE — pins a private narrowing-helper's equivalence to `instanceof`; neither of P16's two blessed exceptions (drift alarm / harness self-check) applies, and the untouched interpreter-level suites it cites (`cyclic-list-ops.test.ts` etc.) already cover the behavior. **SKIPPED** — not named in the 2026-07-08 mechanical-sweep task's explicit bullet list (an ambiguous RETAG-or-DELETE verdict, not a clean mechanical action); left untouched.

## Clean

`core-contract-precision.test.ts`, `overridable.test.ts`, `polyglot-contract-precision.test.ts`, `polyglot.test-d.ts` (honest-accounting header, no OLD-row pattern), `polyglot.test.ts`, `binding-contract-precision.test.ts`, `bytevectors-contract-precision.test.ts`, `chars-contract-precision.test.ts` (22-count labeled), `numeric-contract-precision.test.ts` (81-count labeled), `numeric.test-d.ts` (already moved past the OLD-row pattern — NEW + regression-guard only), `strings-contract-precision.test.ts` (32-count labeled), `vectors-contract-precision.test.ts`, `srfi-1-contract-precision.test.ts`, `srfi-13-contract-precision.test.ts`, `srfi-95-contract-precision.test.ts`, `srfi-95.test.ts` (sort-comparator gap correctly `it.fails`, not green), `srfi.test.ts` (all other tests) — no P1/P5/P6/P7/P14 violations found; no shadow-feature builtins reachable-only-in-test.

## Counts

- 23 files judged, 9 findings, 14 files fully clean.
- By verdict: 5 DELETE (test-d.ts museum rows), 2 RETAG (P4 transitional tolerance), 2 RETAG/RETAG-or-DELETE (P16 impl-pinning).
- `numeric.test-d.ts` and `polyglot.test-d.ts` stand out as the correct end-state for the `*.test-d.ts` convention (NEW-side only) — the other 5 test-d files should converge to that shape.
