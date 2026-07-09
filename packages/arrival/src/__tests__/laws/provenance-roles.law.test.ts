/**
 * LAW (staged) — V1/V2/V4 role-vocabulary rows (docs/PROVENANCE.md §2 "Declaration
 * vocabulary"; docs/PROVENANCE-PLAN.md Cluster V, Q5's stub-file mapping table).
 *
 * Q5 CREATES this file as pure `it.todo` staged spec — none of V1/V2/V4's machinery
 * exists yet. Every row below flips at the Q-node named in its `// @ledger:` comment;
 * Q2 lands the declared `provenance` role field CONCURRENTLY with this file landing,
 * so these rows are written against the SPEC's shape (docs/PROVENANCE.md §2), not
 * against any Q2-in-flight code — they go live in Q2/Q3's wake, never edited to match
 * an interim shape.
 *
 * V3 (opaque quarantine drift alarm) is DELIBERATELY NOT duplicated here — its counted-
 * walk machinery already landed at Q1 and lives in the sibling
 * `laws/opaque-quarantine.law.test.ts` (`countOpaqueNodes`, `src/values/lineage.ts`),
 * whose own header explicitly reserves the option of Q5 folding it in rather than
 * duplicating it. This file takes the "don't duplicate" branch; V3's staged baseline
 * row (`@ledger: opaque quarantine baseline pinned pre-Q6`) stays exactly where it is.
 *
 * V1 (Q2) — the declared `provenance` role field + its drift-alarm door.
 * V2 (Q3) — the classifier consumes declared roles ONLY (heuristics deleted).
 * V4 (Q8a′) — cone-traversal termination over cyclic `binder{cycles}` (loop) nodes.
 */
import { describe, it } from "vitest";

describe("V1 — declared provenance role (§2 CHOSEN: one role per symbol declaration)", () => {
  // @ledger: Q2
  it.todo(
    "every symbol declaration carries exactly one `provenance` role from " +
      "{pipe, fan, source, sink, transparent, loop, opaque} — pipe default for " +
      "native/sequence/tagless kinds, source default for rosetta",
  );

  // @ledger: Q2
  it.todo(
    "the two ad-hoc booleans `fanout?`/`pure?` are GONE, not merely deprecated — " +
      "no declaration surface accepts them any more (§2 EXCLUDED: \"degenerate two-word " +
      "fragment of this vocabulary; each had exactly two readers\")",
  );

  // @ledger: Q2
  it.todo(
    "declaration-completeness: every bound symbol that reaches the classifier has a " +
      "declared role — an undeclared symbol is a build-time error, never a silent " +
      "default-to-opaque",
  );

  // @ledger: Q2
  it.todo(
    "drift-alarm door (assembly-time): a declared role inconsistent with its contract " +
      "shape (e.g. declared `pipe` but the z.lambda position/return shape implies `fan`) " +
      "trips the door at assembly time — CONTRADICTIONS only, never silent (§2 LIMIT: " +
      "\"catches CONTRADICTIONS, not lies: a JS body that fans while declared pipe is " +
      "consistent-but-wrong; contract shape cannot see JS bodies\")",
  );

  // @ledger: Q2
  it.todo(
    "declaration kinds LOWER 1:1 to graph node kinds (one vocabulary, two layers): " +
      "`loop` → `binder{cycles}`; `sink`/`transparent` are declaration-layer facts " +
      "lowering to graph shapes, never a second parallel vocabulary (§2 EXCLUDED, panel C11)",
  );
});

describe("V2 — declaration-driven classifier (§2; PROVENANCE-PLAN.md Q3)", () => {
  // @ledger: Q3
  it.todo(
    "the classifier reads ONLY the declared `provenance` role — the `isRosettaIn` " +
      "heuristic and the `.fanout` duck-read off a bound function are DELETED, not " +
      "merely bypassed (§2 EXCLUDED: \"the key-taxonomy violation the P7 corollary " +
      "exists to kill; every static interpreter reads the declared field\")",
  );

  // @ledger: Q3
  it.todo(
    "named-let and named `do` loops classify as `loop` (lowering to `binder{cycles}`), " +
      "not `opaque` — this is the exact corpus row `laws/opaque-quarantine.law.test.ts` " +
      "marks \"opaque today (pending Q3's binder rewrite)\": `(let loop ((a v1)) a)` " +
      "flips off that corpus's opaque count once this lands",
  );

  // @ledger: Q3
  it.todo(
    "callback roles are extracted from the contract (z.lambda position + return shape) " +
      "into element-transformer / control / effect / accumulator, with declaration " +
      "override only where the contract underdetermines (§2 CHOSEN)",
  );
});

describe("V4 — cone-traversal termination over cyclic binder nodes (§1; PROVENANCE-PLAN.md Q8a′)", () => {
  // @ledger: Q8a′
  it.todo(
    "fullCone/countCone/fieldCone over a `binder{cycles: true}` node TERMINATES — a " +
      "cyclic loop-carried dependency never sends the walker into unbounded recursion " +
      "(the widening interplay Q8a′'s risk register names explicitly)",
  );

  // @ledger: Q8a′
  it.todo(
    "loop wireframing lands template referents BEFORE emission can key records against " +
      "them — a loop-heavy program never emits a record with no template (Q8a′ is a " +
      "HARD gate before Q11a for exactly this reason)",
  );
});
