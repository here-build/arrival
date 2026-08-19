// corpus-conformance.test.ts — the Σ↔reader ANTI-DRIFT gate (the sampler's row of the spec-corpus
// consumer matrix, docs/working-proposals/arrival-curly-vector-literals.md "Deferred reader polish").
//
// THE CONTRACT: Σ (the grammar oracle + the tool-call gate) admits EXACTLY what arrival's reader reads —
// validity, never style. This runner drives an owned copy of the reader's language-portable conformance
// corpus (collection-literals-read.fixture.ts — decoupled from arrival/spec/corpus, since retired) through
// the REAL admission path (`classifyCandidate` over `makeOracle()`) char by char, the way constrained
// decode consumes it:
//
//   • `y_*` / `i_*` (the reader READS these): no char may ever classify "structural", and the complete
//     input must be closeable (EOS admissible) — the whole program is generatable end-to-end.
//   • `n_*` (the reader REJECTS these): some char must classify "structural" — with the DECISIVE rule
//     mirroring the reader's error code (the R-* ↔ E-* map below) — or, for the E-UNTERMINATED cases,
//     the input is never rejected but never closeable (EOS is the mask).
//
// DELIBERATE SUBLANGUAGE EXCLUSIONS: the tool-call gate keeps ONE validated tightening the reader does
// not have — quasiquote `` ` `` is masked (a tool call never opens a template; a mid-form backtick is a
// markdown-fence leak). Corpus cases exercising a quasiquote TEMPLATE are pinned in EXCLUDED with the
// exact rule that must fire, so any OTHER rejection of a reader-valid case still fails loudly. Nothing
// else is excluded — commas (separator AND unquote roles), `,@`, vector/dict literals, quoted literals,
// `#(…)`, and dotted pairs all run through unfiltered.
//
// Σ (bound symbols) is an orthogonal EVAL-validity layer — the corpus is a READER corpus, so the runner
// uses the structural-only `makeOracle()` (validSymbols → null), exactly like the reader knows no env.

import { makeOracle } from "@inhuman.tools/arrival/oracle";
import { describe, expect, it } from "vitest";

import { classifyCandidate } from "../../src/mask-compiler.js";
import type { RuleId, RuleHit } from "../../src/rules.js";
import { collectionLiteralsRead } from "./collection-literals-read.fixture.js";

// Owned fixture (collection-literals-read.fixture.ts), not a cross-package read off
// arrival/spec/corpus — see the fixture's header for why.
const cases = collectionLiteralsRead;

/** The reader-error ↔ sampler-rule mirror. `null` ⇒ the rejection is the BASE structural oracle's
 *  (overClosed — no catalog rule), `"unterminated"` ⇒ never rejected char-wise, masked at EOS instead. */
const ERROR_TO_RULE: Record<string, RuleId | null | "unterminated"> = {
  "E-DICT-ODD-ARITY": "R-DICT-ARITY",
  "E-DICT-BAD-KEY": "R-DICT-KEY",
  "E-DICT-DUP-KEY": "R-DICT-DUP-KEY",
  "E-EXPECTING-DATUM": "R-EXPECTING-DATUM",
  "E-LITERAL-DOT": "R-LITERAL-DOT",
  "E-BRACKET-MISMATCH": "R-BRACKET-MISMATCH",
  "E-BRACKET-UNEXPECTED": null, // a stray closer over-closes — the base scanner (feasible=false), no rule
  "E-UNTERMINATED": "unterminated",
};

/** The tool-call sublanguage's DELIBERATE departures from the reader — reader-valid cases the gate masks,
 *  each pinned to the exact rule that must fire. Quasiquote only (see the header). */
const EXCLUDED: Record<string, RuleId> = {
  y_unquote_outside_literal_untouched: "R-UNQUOTE-QUASI", // "`(a ,b)" — the template opener itself is masked
};

/** Drive `input` char-by-char through the real admission path. Returns the FIRST structural rejection
 *  (step index + the decisive catalog rule, null when the base oracle rejected with no rule) or null
 *  when every char was admitted. */
function firstRejection(input: string): { step: number; rule: RuleId | null } | null {
  const scanner = makeOracle();
  for (let i = 0; i < input.length; i++) {
    const hits: RuleHit[] = [];
    const klass = classifyCandidate(scanner, input.slice(0, i), input[i], undefined, undefined, (h) => hits.push(h));
    if (klass === "structural") {
      const masked = hits.find((h) => h.decision === "masked");
      return { step: i, rule: masked?.ruleId ?? null };
    }
  }
  return null;
}

describe("corpus-conformance — Σ admits exactly what the reader reads (collection-literals-read.jsonl)", () => {
  it("the corpus is present and non-trivial", () => {
    expect(cases.length).toBeGreaterThan(30);
  });

  // Route on the EXPECTATION, not the name prefix alone: an `i_` case may pin an ERROR class
  // (implementation-defined REJECTION — e.g. the lexer-scoped glued `{a:1}` teaching door), and the
  // Σ mirror must make those ungeneratable exactly like the `n_` cases.
  const yes = cases.filter(
    (c) => (c.name.startsWith("y_") || c.name.startsWith("i_")) && c.expect.error === undefined && !(c.name in EXCLUDED),
  );
  it.each(yes)("READS ⇒ generatable: $name — $input", ({ input }) => {
    const rej = firstRejection(input);
    expect(
      rej,
      rej ? `char ${rej.step} (${JSON.stringify(input[rej.step])}) masked by ${rej.rule ?? "base structural"}` : "",
    ).toBeNull();
    // The complete program must be closeable — EOS admissible, the decode can END here.
    expect(makeOracle().analyze(input).closeable, "complete input must be closeable (EOS admissible)").toBe(true);
  });

  const excluded = cases.filter((c) => c.name in EXCLUDED);
  it.each(excluded)("DELIBERATE sublanguage exclusion: $name — masked by the pinned rule only", ({ name, input }) => {
    const rej = firstRejection(input);
    expect(rej, "an excluded case must actually be rejected").not.toBeNull();
    expect(rej!.rule, "…and by EXACTLY the documented tightening").toBe(EXCLUDED[name]);
  });

  const no = cases.filter((c) => c.expect.error !== undefined);
  it.each(no)("REJECTS ⇒ ungeneratable: $name — $input", ({ input, expect: exp }) => {
    const want = ERROR_TO_RULE[exp.error!];
    expect(want, `unmapped reader error code ${exp.error} — extend ERROR_TO_RULE`).not.toBeUndefined();
    const rej = firstRejection(input);
    if (want === "unterminated") {
      // Never char-rejected (every prefix is live) but never closeable — EOS is the mask.
      expect(rej, "an unterminated literal must stay char-admissible").toBeNull();
      expect(makeOracle().analyze(input).closeable, "…but must NOT be closeable (EOS masked)").toBe(false);
      return;
    }
    expect(rej, "a reader-rejected input must be char-rejected by Σ").not.toBeNull();
    expect(rej!.rule, `the decisive rule must mirror the reader's ${exp.error}`).toBe(want);
  });
});
