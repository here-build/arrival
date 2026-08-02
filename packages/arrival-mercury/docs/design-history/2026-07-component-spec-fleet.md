# 2026-07 component-spec fleet — retired

The compiler was designed spec-first: a 9-spec component fleet (+ README index) under
`docs/working-proposals/arrival-mercury/`, bound to the constitution (now `../constitution.md`),
each spec adversarially revised against its siblings (the README reconciled 13 cross-spec
conflicts and 58 open items as of 2026-07-13). The fleet was then BUILT — `src/` mirrors it
one-to-one — and the specs were retired 2026-08-02: the code is canonical, and the specs cite
pre-build `inhuman/public-packages/mercury/` paths that no longer resolve at HEAD.

## Spec → src map

| Spec | As-built |
|---|---|
| `coreform-ir.md` | `src/coreform/` (classify, CoreForm union, NodeId, Door taxonomy) |
| `typefacts-extraction.md` | `src/typefacts/` (lens-program, extract, closed facts vocabulary) |
| `residual-renderer.md` | `src/residual/` (R/Decl algebra, `ts.factory` render, chunks) |
| `registry-emit.md` | `src/registry/` (harvest, dry-activation, greenfield session) |
| `async-await-plane.md` | `src/naming/asyncness.ts` + materializer (see divergence below) |
| `engine-walker.md` | `src/walker/` (walk, names) + peepholes in `src/peepholes/` |
| `type-emit-lawt.md` | `src/type-emit/` (`__scmTruth` wrap, narrows grammar, builtins) |
| `phase1-symbol-rules.md` | `src/rules/phase1.ts` + stage-0 runtime in `src/runtime/` |
| `oracle-harness.md` | extracted to its own package, `arrival-mercury-oracle` (harness, error-classifier, fuzzer tests, gate3 fixtures) |
| `orchestration-dag.md` | fleet sequencing artifact (E0–E5 tracks) — consumed, no code twin |
| `e2-substrate-evidence.md` | read-only evidence memo on here.build's mature Mercury — consumed by the E2 track |
| `dnf-prevaluation-evidence.md` | kept: `../dnf-prevaluation-evidence.md` → `src/prevalue/` (+ `src/propagate/`) |
| `gate3-human-grade-rulings.md` | promoted: `inhuman/docs/decisions/IN-032-mercury-behavioral-equivalence-floor.md`; R-G6 → `src/prevalue/` |

## Where as-built diverged from spec (per the specs' own revision notes)

- **Async plane rewritten in full (2026-07-13, V ruling "async-ify by cascade on type data"):**
  the spec's original pre-emit CoreForm SCC fixpoint (`placeAwait`, `invokesArg`, `asyncRoot`)
  was DELETED, replaced by a post-emit typed-dataflow pass over the finished Residual tree.
  This dissolved conflicts C1/C9/C11; `registry-emit.md` correspondingly deleted
  `invokesArg`/`asyncRoot`/`EmitCtx.argAsync`/`buildEmitCtx` and bake-check #3, and
  `phase1-symbol-rules.md` rewrote `map`/`filter` sync-shaped (`infer`'s residual unchanged —
  it composes correctly under the new pass).
- **Oracle left the package:** specced as `mercury/src/__tests__/oracle/`, shipped as the
  sibling package `arrival-mercury-oracle` (black-box boundary made a package boundary).
- **Prevaluation was not in the original fleet at all:** `src/prevalue/` + `src/propagate/`
  landed off the Gate-3 R-G6 ruling and the DNF evidence memo's V correction (the TS type
  lattice IS arrival's variant space).

---

*Provenance: distilled 2026-08-02 from the 14 spec docs + `arrival-mercury-engine-plan.md`,
all retired the same day; full texts in git history under `docs/working-proposals/`.*
