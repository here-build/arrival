# The `=== nil` identity-equality sweep

Moved out of `src/__tests__/clone-identity.test.ts`'s "META — provenance clones
break identity-equality systematically" block (2026-07-08 test-invariant-atlas
sweep, `docs/test-suite-v2/REMOVAL-MANIFEST.md` §A/clone-identity.test.ts row):
a war-story ledger belongs in docs, not as a test assertion that tests
nothing observable (`expect(sites.length).toBe(14)`).

## The bug

`Nil` extends `AValue`, and `AValue.withProvenance(p)` returns a FRESH
instance (`new Nil(p)`) rather than mutating the singleton. Every codepath
that touches a `Nil` value through the provenance machinery — most notably
`restrictControlFlowProvenance` in `src/eval/evaluator.ts` (a control-flow arm
resolving to nil while the predicate carries provenance) — can mint a `Nil`
instance that is OBSERVABLY identical to `nil` (same class, `toJs() ===
null`, `toString() === "()"`) but FAILS `=== nil` because it is a different
heap object. Any site that guarded on `=== nil` instead of `instanceof Nil`
would silently misroute a Nil clone.

## The fix

`is_nil` (now `src/values/value-guards.ts:46`) was fixed to `instanceof
ANil`. The systematic fix was to migrate every `=== nil` guard the same way.

## The 14 sites (as last audited, pre-fix)

- `ramda-functions.ts` (polymorphicMap/filter/reduce, 5 sites) — deleted
  outright when Ramda was removed from the sandbox; those wrappers were
  already overridden by sandbox-env's hardened map/filter/reduce, so the
  sites left with the code.
- `membrane.ts:71` — `isSchemeValue` — FIXED, now `instanceof AValue`
  dispatch (`src/membrane.ts:139`).
- `membrane.ts:326` — `toJS` — FIXED, full protocol dispatch via
  `value["arrival/toJS"]()` (`src/membrane.ts:240`), no nil special-case at
  all.
- `rosetta.ts:70` — `schemeToJs` entry — still unfixed as of 2026-07-08
  (`src/__tests__/clone-identity.test.ts`'s `rosetta.ts` describe block keeps
  this as a live `it.fails`).
- `rosetta.ts:130` — `schemeToJs` Pair-spine tail — FIXED (verified green).
- `bridge.ts:985` — `list-copy` entry — FIXED. `bridge.ts` no longer has
  `list-copy` at all (the file is down to 137 lines); the logic lives in
  `src/env/r7rs/lists.ts`, entry guard now `instanceof ANil`
  (`src/env/r7rs/lists.ts:450`).
- `bridge.ts:989` — `list-copy` recursion base — FIXED, same file, recursion
  base guard `instanceof ANil` (`src/env/r7rs/lists.ts:455`).
- `bridge.ts:1351` — single (unaudited further; file no longer exists at that
  size).
- `fantasy-land-lips.ts:89` — `mapPair` base — FIXED. `fantasy-land-lips.ts`
  no longer exists; map lives directly on `APair` (`src/values/primitives/
  APair.ts`, `arrival/tagless-final/map`), terminated by `while (node
  instanceof APair)` — a Nil clone (not an APair) ends the walk correctly.
- `fantasy-land-lips.ts:94` — `filterPair` base — FIXED, same file/pattern
  (`arrival/tagless-final/filter`).
- `fantasy-land-lips.ts:102` — `reducePair` base — FIXED, same file/pattern
  (`arrival/tagless-final/reduce`).
- `fantasy-land-lips.ts:108` — `traversePair` base — FIXED (terminates via
  `instanceof APair` in the `traversePair` helper). The *test* asserting this
  site (`fantasy-land-lips.ts:108 — traversePair` `it.fails`) had drifted: its
  assertion (`ofCalls.length === 1`) reflected the pre-fix broken-termination
  shape, not the algorithm's actual correct invariant (`of` called once for
  the `nil` base case, once per leaf wrap — 2 calls for a 1-element list).
  Rewritten to the correct invariant and promoted to plain `it()`.
- `sandbox-env.ts:123` — `'@'` accessor — FIXED. `sandbox-env.ts` doesn't
  exist; the accessor is `membrane.ts`'s `readMember`
  (`src/membrane.ts:269`), guarded by `rawKey instanceof ANil`.
- `sandbox-env.ts:163` — `'@?'` accessor — FIXED, same file, `hasMember`
  (`src/membrane.ts:312`).

## Current state (2026-07-08)

Of the ~14 sites, only `rosetta.ts:70` (`schemeToJs` on a bare nil clone
outside a Pair) remains an open gap, tracked live as `it.fails` in
`clone-identity.test.ts`'s `rosetta.ts` describe block. Every other site is
fixed and verified against current source; the corresponding tests in
`clone-identity.test.ts` are regression guards (`it()`), not bug reports.
