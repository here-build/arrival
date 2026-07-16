# Gate-3 goldens — rebase log

## goldenEpoch 2 — E1a lands: names dissolve into census + allocate + materialize (2026-07-16)

**Zero gate-3 goldens changed — verified, not assumed.** `git diff --stat` against this
directory and a fresh `gate3-goldens.test.ts`/`gate3-rubric.test.ts` run both confirm
`multi-list-map`, `async-map-promise-all`, `apply-plus`, `apply-map-transpose`,
`short-circuit-or`, `first-class-car-hof`, `legibility-destructure` are byte-identical to
goldenEpoch 2's own baseline. Recorded here anyway (mirroring goldenEpoch 1's own "no
existing golden changed" entry) because this landing is exactly the kind of engine change
gate 3 exists to catch drift from — the engine plan's E1a phase
(`docs/working-proposals/arrival-mercury-engine-plan.md` §2 E1a): a global binding census
(`src/naming/census.ts`) feeds one `@here.build/lexical-namer` allocation
(`src/naming/allocate.ts`), and `walker/walk.ts` now commits the result
(`src/naming/materialize.ts`) before it ever returns — `fresh()`-at-emit's own ad hoc
`${name}_${n}` collision loop is gone, and the legibility pass's destructure/singularize
legs (`legibility/destructure.ts`, `legibility/singularize.ts`) are deleted, their analysis
ported verbatim into the census as a READ instead of a decide-and-rewrite pass.

**Two `fixtures/emitted/*.ts` fixtures DID change — pure renames, same discipline as
goldenEpoch 2 (R5c)'s own `mercury-fixture-gepa.ts` note: that suite's header already
frames snapshot drift as "regenerate after an emitter change... review the diff like a
lockfile," no REBASE_LOG requirement of its own, logged here for the paper trail.**
Verified names-only via `assertFixtureNamesOnly` (`src/oracle/names-diff.ts`) wherever the
tool's positional-bijection check could confirm it cleanly; the two cases below hit the
tool's own documented limit (no scope analysis — two DIFFERENT old names occupying
disjoint sibling scopes both resolving to the same new bare name reports as a "collision"
even though it is safe) and were verified by hand instead (both are genuinely independent,
non-overlapping function scopes — see each entry).

- **`inhuman-gepa-full.ts`** — 8 renames, all pure:
  - `__x2 → __x` (the `frontier` function's `.filter` callback — a SEPARATE, sibling scope
    from `failuresOf`'s own `__x`; the old ad hoc walker suffixed it purely because its
    single-flat-stack collision tracking couldn't see the two were disjoint. Hit the
    names-diff tool's collision limit — verified by hand: `failuresOf`/`frontier` are two
    unrelated top-level `const`s, zero overlap.)
  - `__acc2 → __acc`, `__item3 → __item` (`paretoWeight`'s `.reduce`)
  - `__acc3 → __acc`, `__item4 → __item` (`select`'s `.reduce`)
  - `picked → isPicked` (the `picked?` predicate function) and `picked_2 → picked` (the
    named-let loop var, `sampleBatch`) — **the one semantic-reading improvement, not just
    renumbering**: this is precisely the "gepa-full bug" `front/scheme-scope.ts`'s own
    header names as the read-register namer's motivating case (a data binding and a
    same-named predicate contesting one bare name) — the content-aware ladder trick
    (predicate yields the bare name when a co-scoped plain binding wants it) now fires in
    the RUN register too, for the first time. The DATA (the accumulated picked set) reads
    as `picked`; the PREDICATE reads as `isPicked` — better than the old, backwards
    assignment (`picked` the predicate, `picked_2` the data).
  - `__acc4 → __acc`, `__item5 → __item` (`proposalBatchScore`'s `.reduce`)
  - `__acc5 → __acc`, `__item6 → __item` (`parentBatchScore`'s `.reduce`)
- **`mercury-fixture-gepa.ts`** — 2 renames, both the same disjoint-sibling-scope pattern:
  `__x2 → __x` (`failing`'s `.filter`) and `__x3 → __x` (`frontier`'s `.filter`) — two
  unrelated top-level `const`s, verified by hand for the same names-diff-tool-limit reason
  as `inhuman-gepa-full.ts`'s `__x2` row above.

Regenerated via `vitest run emitted-fixtures.test.ts -u` (the file's own documented
workflow) against the real, gate-authoritative `compileGreenfield(session, source)`;
every other `fixtures/emitted/*.ts`/`fixtures/gate1-corpus/*` fixture re-checked and
confirmed byte-identical (no other corpus program exercises a sibling-scope glue name or a
predicate/plain-binding same-bare-name contest).


Constitution §9 golden discipline ("Golden discipline (two golden sets,
epoch-stamped)"): a byte-change to any `*.golden.ts` file in this directory
requires an entry here — "re-base once, explicitly" is a mechanism (this log),
never a culture instruction. This log is Gate 3's own — separate from
`fixtures/cross-pass/REBASE_LOG.md` (the typefacts-extraction cross-pass
fixtures' log; different owner, different pipeline slice, no collision).

## goldenEpoch 2 — first-class-car-hof: eta lands (R5c, 2026-07-16)

**One golden changed, by design — the exact flip goldenEpoch 1's own note
watched for.** `car`'s Phase-1 row (`rules/phase1.ts`) already declared
`refPolicy: "eta"`, but `carRule` carried only `.call` — no `.ref` method — so
the walker's value-position ladder (`registryValueRef`) fell through to the
rung-3 `RuntimeRef` shim every time. This wave gave `carRule` a `.ref` that
eta-expands `call` against the INSTANTIATED use-site signature
(`ctx.selfFacts?.callable` — `TypeFacts.callable`), consuming extraction
machinery that was ALREADY WIRED and unmodified by this landing
(typefacts/extract.ts's `probeCallable`, "Value-position probe —
single-occurrence Refs in argument position" — the once-unverified assumption
arrival-ts-transpiler-design.md §4.2 flagged, "whether the lens delivers
instantiated signatures in argument position," now proven live).

**`first-class-car-hof.golden.ts`** — the named Gate-3 golden this landing targets:
```diff
- import { car, list } from "./stage0.mts";
+ import { list } from "./stage0.mts";
  function OracleMain() {
      const xss = list(list(1, 2), list(3, 4));
-     return xss.map(car);
+     return xss.map(([head]) => head);
  }
```
`car` drops out of the import line entirely (FRAME's import-as-query only
imports symbols a surviving `RuntimeRef` still references — eta replaced that
reference with an inlined arrow). The destructured `([head]) => head` shape
(not the `.ref`-built `(x) => x[0]`) is LEGIBILITY's destructuring +
element-name-singularization passes firing on the newly-inlined arrow, an
EMERGENT interaction with existing, unmodified passes — not something this
landing's `.ref` method constructs directly.

Regenerated by running the real, gate-authoritative `compileGreenfield(session,
source)` against the fixture's unchanged `source` and committing the observed
bytes verbatim (same discipline as every other entry in this log) — the arrow
shape above was read off the actual pipeline output, never hand-typed.

**A SECOND fixture was affected, discovered empirically (not assumed) —
`fixtures/emitted/mercury-fixture-gepa.ts`** (`emitted-fixtures.test.ts`'s own
snapshot, a different fixture directory/discipline than this gate3 log, no
REBASE_LOG requirement of its own — that suite's header already frames
snapshot drift as "regenerate after an emitter change... review the diff like
a lockfile"). `mercury-fixture-gepa.scm`'s own copy-as-chunk header names
EXACTLY why: it was chosen because it "pairs a first-class `car` in HOF
position (`(map car …)`) with an independent two-list `map` zip" — the SAME
pattern this landing targets, so the SAME eta-expansion fires on it too:
`.map(car)` → `.map(([head]) => head)`, `car` drops from the import line, and
inserting the eta arrow's own fresh binding earlier in the SAME compilation
shifts an UNRELATED `filter` guard's fresh-name suffix two lines down
(`__x`/`__x2` → `__x2`/`__x3` — cosmetic renumbering, same shape, not a
behavior change). Regenerated the same way (`vitest run
emitted-fixtures.test.ts -u`, reviewed the diff, confirmed it is exactly the
two expected shapes above and nothing else). This is not scope creep: it is
the identical, correct mechanism firing wherever the pattern already occurs in
the committed corpus — not applying it here would leave a second real program
stale relative to what the compiler now actually emits.

**Verified the blast radius stops at exactly these two fixtures**: the full
`gate3-goldens.test.ts` suite re-run before/after — `multi-list-map`,
`async-map-promise-all`, `apply-plus`, `apply-map-transpose`,
`short-circuit-or`, `legibility-destructure` are all byte-identical to
goldenEpoch 1 (none of the other five exercises a bare symbol in HOF value
position the way `first-class-car-hof` does by design). `cross-pass-
fixtures.test.ts` and every OTHER `fixtures/emitted/*.ts`/`fixtures/gate1-
corpus/*` fixture were also re-run and are unaffected (none references `car`
in value position either) — confirmed via the full arrival-mercury suite, not
assumed from the two known cases alone.

`cdr` is the structurally identical, natural follow-up — deliberately NOT done
this wave (no golden names it yet; land it as its own reviewed, one-golden
change when a case pins it, same discipline as this entry).

## goldenEpoch 1 — initial baseline (2026-07-14)

First-landing baseline for the six hard cases the constitution's Gate 3 names
(§9: "goldens vs the `goldenEpoch: 1` baseline on the hard cases"):
`multi-list-map`, `async-map-promise-all`, `apply-plus`, `apply-map-transpose`,
`short-circuit-or`, `first-class-car-hof`.

Generated by running the real, gate-authoritative `compileGreenfield(session,
source)` (constitution §9's dual-path rule: the new pipeline is the gate
subject from Phase 1) against each fixture's `source` and committing the
observed bytes verbatim — no hand-typed residual or renderer output. One
shared `OracleSession` per test suite, per the oracle-harness's §4.1 reuse
contract.

Two runtime-module additions landed alongside this baseline (both additive,
`src/runtime/stage0.ts`), because `compileGreenfield`'s FRAME stage doors on
any `RuntimeRef` symbol absent from the manifest, and neither symbol had a
prior reason to exist there:

- `car`/`cdr` in VALUE position — needed the moment either name appears as a
  bare HOF argument (`first-class-car-hof`'s `(map car xss)`); call position
  never needed them (the emit rules fold inline unconditionally).
- `infer` — needed for ANY async-seeded program to compile at all
  (`async-map-promise-all`). The shim is an honest placeholder that throws
  (the framework axis is out of scope for Phase 1 — see `phase1.ts`'s own
  `TODO(config.framework)`); it exists so the ASYNC-IFY rewrite SHAPE can be
  pinned, not to answer real inference calls.

No prior baseline existed — this is Gate 3's first landing, not a rebase of a
previous epoch. The one WATCHED future flip: `first-class-car-hof`'s golden
comment names the exact upgrade (`car`'s row growing a `.ref` that reads
`callable` facts) that will change its bytes on purpose.

## goldenEpoch 1 — new fixture added, no existing golden changed (2026-07-14)

LEGIBILITY (constitution §3.5's third invention — implicit destruction,
element-name singularization, pure-region CSE) wired into `compileGreenfield`
between `walk()`/`exportUnitResult` and `asyncIfy` (a documented deviation from
the constitution's §3.1/§3.5 pipeline-diagram ordering — see
`../../legibility/legibility.ts`'s header for the full reasoning: CSE hoists
duplicate calls into an ordinary sync-shaped `Const` BEFORE asyncness exists,
so ASYNC-IFY's ordinary Const-handling awaits it correctly with zero changes
to either pass).

**None of the six existing goldens changed a single byte.** Checked directly
(full `compileGreenfield` re-run against each fixture's `source`, byte-compared
against the committed `golden`): none of `multi-list-map`,
`async-map-promise-all`, `apply-plus`, `apply-map-transpose`,
`short-circuit-or`, `first-class-car-hof` happens to contain a destructure-
eligible tuple access, a multi-list map with a NAMED (`Ref`-shaped) driving
collection, or a duplicate pure call — the three shapes LEGIBILITY acts on.
(`multi-list-map`'s receiver is `list(1, 2, 3)` — a `Call`, not a `Ref` —  so it
has no derivable collection name for singularization either; a `Call`-shaped
receiver only yields a name when its OWN callee resolves to a registered
symbol, and `pluralize.singular("list") === "list"`, already singular, in any
case.)

**One new fixture added** — `legibility-destructure.golden.ts` — to give Gate 3
concrete, oracle-agreeing coverage of the constitution's own worked example
(`(lambda (pair) (+ (car pair) (cadr pair)))` → `([first, second]) => first +
second`, spelled `(car (cdr pair))` since `cadr` is not yet a bound registry
symbol — see the fixture's own header). Generated the same way every other
fixture in this file was: running the real `compileGreenfield(session, source)`
and committing the observed bytes verbatim; `runOracle` on the same source
agrees with the interpreter (checked, not asserted in this fixture file itself
— see `../legibility.test.ts`'s oracle-session describe block for the
committed oracle-agreement assertion on this exact transformation).

Singularization and CSE are NOT separately added as gate3 fixtures (the
existing six had no natural, uncontrived slot for either without forcing an
artificial-looking source program); both are covered — with oracle agreement
checked, not just byte-pinned — end to end through the real `compileGreenfield`
pipeline in `../legibility.test.ts`'s own "wired into compileGreenfield"
`describe` block instead. That suite is this landing's de facto second golden
set for the pass; nothing here contradicts it.
