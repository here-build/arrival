## Findings

`golden-prov-arithmetic.test.ts > GOLDEN — documented asymmetries the eager path exhibits TODAY > "(cdr (list a b))..."` — [P10] FLIP-TO-FAILS: plain-green assertion of a provenance drop (spine cell carries `[]`); this is the exact case P10's own text cites as the motivating lie ("cdr of a proper list returning an unstamped spine cell... pinned GREEN").

`golden-prov-arithmetic.test.ts > GOLDEN — documented asymmetries the eager path exhibits TODAY > "(append (list a) (list b))..."` — [P10] FLIP-TO-FAILS: plain-green assertion that append drops all element provenance; P10 names this verbatim as the paradigm violation ("append rebuilding the spine and dropping every element's provenance... pinned GREEN").

`golden-prov-fan.test.ts > GOLDEN (G2 oracle) — pure-map length over a Pair source OVER-ATTRIBUTES today > "(length (map id xs)): count is 3, provenance carries EVERY element id (the A13 leak)"` — [P10/P15] FLIP-TO-FAILS: comment self-identifies as "the A13 leak," pinned green (no `it.fails`) while a sibling `it.todo` GATE section already specifies the correct fix — the exact "documents today's behavior… even annotated" pattern P15 forbids.

`lineage-assumptions.test.ts > ASSUMPTION — a count is identity-entangled today > "A13: (length (map identity xs)) carries every element's provenance"` — [P10] DELETE: verbatim duplicate of golden-prov-fan's A13 leak, pinned green a second time in a different file with no `it.fails`.

`lineage-assumptions.test.ts > ASSUMPTION — a pure-map length over-attributes through the live builtins > "A18b: (length (map id ys))..."` — [P10] DELETE: a third green pin of the identical A13 leak (same bug, same fixture shape, still not `it.fails`).

`lineage-assumptions.test.ts > v0.1 FINALIZATION GATES (G1–G7) > "G6-eager-golden(SchemeVector): a length-preserving vector-map PRESERVES..."` — [P8] REWRITE: one snapshot conflates a sound invariant (`vectorMap`/`vectorMapTwice` preserve the collection box, `prov:[7]`) with a real per-carrier divergence — the *same* operation ("count of a mapped collection") over Pair over-attributes to every element id (A13/A18b: `[100,101,102]`) while over Vector it drops to fully empty (`vectorLength`/`mapLengthCoerce`: `prov:[]`). Three incompatible carrier semantics for one term, frozen together as permanent design — P8 forbids exactly this ("goldens that freeze the divergence"), and the comment explicitly locks it in ("G2 forbids improving it under the flag").

`deferred-value-egress.test.ts > deferred egress — the exec/membrane boundary > "CHARACTERIZATION: under speculate:true, a top-level result ESCAPES exec as a LIVE AHalfBaked"` — [P4/P6] FLIP-TO-FAILS: comment calls this "the real, reproducible leak" — a live, run-A-bound carrier crossing the exec/membrane boundary unforced, asserted green while the fix (force-on-egress) sits in `it.todo` right below it.

`deferred-value-egress.test.ts > deferred egress — un-forced escape is structurally detectable > 'AHalfBaked["arrival/toJS"]() is the interval, never the collapsed value'` — [P9] RULING-NEEDED: the `{ __halfBaked__: "collection" }` return is structurally the same "marker object encoding what the value really was" that P9 names as forbidden (precedent: the retired `{__dotted__}` shape) — but its intent is a loud trip-wire for a value that should never reach `toJS` unforced (P5), not a round-trip promise. Needs a ruling on which principle governs a detectability marker vs. a conversion residue.

## Clean

attestation.test.ts, collapse-provenance.test.ts, evaluator-provenance.fuzz.test.ts, golden-prov-infer.test.ts, golden-prov-special-forms.test.ts, lineage-checkpoint.test.ts, lineage-classifier-from-env.test.ts, lineage-field.test.ts, lineage-grounding.test.ts, lineage-shadow.test.ts, lineage-spike.test.ts, provenance-algebra.property.test.ts, provenance-deep-stamp.test.ts, purity-doors.test.ts, speculative-eval.test.ts, tap.spec.ts

## Counts

- Files in cluster: 20
- Files with findings: 4
- Files clean: 16
- Total findings: 8 (FLIP-TO-FAILS: 4, DELETE: 2, REWRITE: 1, RULING-NEEDED: 1)
