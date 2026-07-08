/**
 * R7RS identity-predicate conformance — bug ledger.
 *
 * Why this file exists
 * --------------------
 * R7RS § 6.1 defines a three-level hierarchy: `eq?` (pointer-grade), `eqv?`
 * (atom-grade, including same-numeric-value with same-exactness), and `equal?`
 * (structural, recurses into pairs/vectors/strings). The three are NOT
 * interchangeable — collapsing them breaks `memq`/`assv`/`hash-table-ref/eqv`/
 * `case` dispatch.
 *
 * Our current `eq?` and `eqv?` are both aliased to a single `equal` helper at
 * `lips.ts:3634-3635`. That helper takes a partial-deep stance:
 *   - For Pair / Array / unknown objects it falls through to `else x === y`
 *     (lips.ts:674) — happens to match the R7RS pointer-grade answer.
 *   - For strings (lips.ts:670-672) it value-compares via `valueOf()` — wrong:
 *     two distinct heap SchemeString instances compare equal, collapsing
 *     eq?/eqv? into a string-equal? shape.
 *
 * The string path is the load-bearing identity bug. Symbol interning and the
 * accidental-correct Pair/Array path are guarded as passing invariants so any
 * future patch that "unifies" `equal` won't silently regress the right answers.
 *
 * Style — each `it.fails` describes EXPECTED R7RS behavior. `it.fails` is
 * vitest 4's "this should fail; passing = regression" — perfect for bug
 * ledgers (when the bug gets fixed, removing `.fails` flips the test green).
 */

import { describe, expect, it } from "vitest";
import { exec } from "../eval/generator-exec.js";
import { freshEnv } from "./_fresh-env.js";

const env = await freshEnv();

/** Coerce a Scheme result to a JS primitive — handles SchemeBool wrapper and raw JS booleans. */
// INVERTED (RULINGS.md R1, docs/test-invariant-atlas/verdicts/evaluator.md): exec's
// uniform plain-JS exit landed — `evalScheme` below always returns a plain boolean
// now. Collapsed to that one asserted shape (was: tolerate boolean-as-raw AND
// boxed-with-.value/valueOf simultaneously — the "accepts boxed or raw" contract P4
// forbids).
const truthy = (r: unknown): boolean => {
  if (typeof r === "boolean") return r;
  return Boolean(r);
};

async function evalScheme(src: string): Promise<unknown> {
  const [r] = await exec(src, { env });
  return r;
}

describe("r7rs identity — passing invariants (regression guards)", () => {
  it("eq? on interned symbols is #t (R7RS § 6.1)", async () => {
    // The parser interns symbols — both occurrences of 'foo resolve
    // to the same heap SchemeSymbol, so eq? must be #t.
    const r = await evalScheme("(eq? 'foo 'foo)");
    expect(truthy(r)).toBe(true);
  });

  it("eq? on two distinct (list 1) calls is #f (R7RS § 6.1)", async () => {
    // Each `list` call mints a fresh Pair → in `equal` (lips.ts:633) Pair has
    // no special-case branch → falls through to `else x === y` (lips.ts:674)
    // → returns false. Correct by accident — guard against a future "let's
    // deepEqual into pairs" rewrite that would silently flip this to #t.
    const r = await evalScheme("(eq? (list 1) (list 1))");
    expect(truthy(r)).toBe(false);
  });

  it("eqv? on two distinct vector copies is #f (R7RS § 6.1)", async () => {
    // Vectors are JS Arrays; `equal` falls through to `else x === y` →
    // reference identity → #f. R7RS-correct by accident; regression guard.
    const r = await evalScheme(`(eqv? (vector 1 2) (vector 1 2))`);
    expect(truthy(r)).toBe(false);
  });

  it("string-length counts code points, not UTF-16 code units (R7RS § 6.7)", async () => {
    // The public `string-length` binding lives at `bridge.ts:680` and uses
    // `[...str].length` (code-point iteration). The internal SchemeString getter
    // at `SchemeString.ts:45` uses `.__string__.length` (code units, would be 2
    // for "😀"); that getter is NOT exposed to Scheme. Guard that the public
    // binding is the one Scheme code sees.
    const r = await evalScheme(`(string-length "😀")`);
    expect(Number((r as { valueOf: () => unknown }).valueOf())).toBe(1);
  });
});

// [STALE-LABEL] (2026-07-08 test-invariant-atlas sweep, [P15]
// docs/test-invariant-atlas/verdicts/evaluator.md): this describe title + the per-test
// "Predicted failure value" comments claimed `it.fails` semantics, but every test here is
// a plain `it(...)`. Ran the suite — all pass today, so the described bugs are already
// FIXED. Relabeled to match r7rs-numbers.test.ts's own honest "FIXED at ..." convention.
describe("r7rs identity — eq?/eqv? string-identity fixes (regression guards)", () => {
  it(
    "eq? on two distinct string-copy results is #f (R7RS § 6.1)",
    async () => {
      // FIXED (was: `lips.ts:670-672` compared strings via `.valueOf()`, returning #t
      // for two unrelated heap instances — collapsing eq?/eqv? into string-equal? shape).
      // R7RS § 6.1: `(eq? "x" "x")` on literals is implementation-defined, but distinct
      // heap instances (`string-copy` minted fresh objects) should not compare eq? — the
      // predicate is meant to be at most a pointer-grade check.
      const r = await evalScheme(`(eq? (string-copy "abc") (string-copy "abc"))`);
      expect(truthy(r)).toBe(false);
    },
  );

  it(
    "eqv? on two distinct string-copy results is #f (R7RS § 6.1)",
    async () => {
      // FIXED (same root cause as above: eq?/eqv? no longer alias a value-comparing-via-
      // valueOf helper). R7RS § 6.1 leaves eqv? on string literals unspecified, but the
      // same-instance-vs-fresh-instance distinction is now respected.
      const r = await evalScheme(`(eqv? (string-copy "abc") (string-copy "abc"))`);
      expect(truthy(r)).toBe(false);
    },
  );

  it(
    "eqv? on two distinct make-string results is #f (R7RS § 6.1)",
    async () => {
      // FIXED (same fix, exercised through a different constructor). Every
      // `make-string` call mints a fresh SchemeString; eqv? on two distinct heap
      // instances now correctly answers #f under atom-grade semantics.
      const r = await evalScheme(`(eqv? (make-string 1 #\\a) (make-string 1 #\\a))`);
      expect(truthy(r)).toBe(false);
    },
  );
});
