/**
 * Tier-1 bug-cell corpus (oracle-harness.md §4.3) — every `corpus/<name>.scm` +
 * `<name>.expect.ts` pair, checked three ways: interpreter ≡ expected,
 * compiled ≡ expected, interpreter ≡ compiled. The independent, hand-reasoned
 * `expected` is what lets this tier catch an INTERPRETER regression too — pure
 * differential testing is blind to "both sides agree on the same wrong answer."
 *
 * Divergence-by-design rows (`ExpectedOutcome.divergent` — exact overflow)
 * assert each side against its own half and never check agreement.
 *
 * KNOWN_RED rows are `it.fails`-tracked (the ruled convention, oracle-harness.md
 * §7 Q4): red for a reason OUTSIDE the Phase-0 truthiness fixes, with the owning
 * mechanism named per row. When that mechanism lands, the row starts failing
 * the `.fails` wrapper — the loud signal to promote it to a plain assertion,
 * never a flake to chase.
 *
 * Adding a case is "drop two files" into corpus/.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupOracleScratch, openOracleSession, oracleEqual, runOracle, show } from "../index.js";
import type { ExpectedOutcome, OracleSession, Outcome } from "../index.js";

const corpusDir = fileURLToPath(new URL("corpus/", import.meta.url));
const rows = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".scm"))
  .map((f) => f.slice(0, -".scm".length))
  .sort();
if (rows.length === 0) throw new Error(`bug-cell corpus is empty — expected corpus/*.scm at ${corpusDir}`);

/**
 * Rows red under the GREENFIELD gate subject (constitution §9 subject-routing —
 * the harness's default since the subject flip). Every reason below was
 * verified against the live greenfield pipeline and the live interpreter
 * (Wave-C integration gate, 2026-07-14), not transcribed from the spec.
 *
 * Promoted out of this map at the subject flip (each verified end-to-end):
 * modulo-neg (the `modulo` emit rule), equal-nested-list / member-assoc /
 * nan-eqv / neg-zero-eqv (stage-0 equality/list walkers via rung-3 shims),
 * every-last-value / any-witness / every-boolean-pred (value-returning SRFI
 * every/any in stage-0 + the phase1 table's registry-presence rows), and
 * eq-vs-equal-string-eq (re-authored as a divergence-by-design sidecar:
 * boxed-string identity is unobservable post representation-collapse —
 * interpreter #f / compiled #t, permanently).
 *
 * OQ8a resolved by ELIMINATION, not re-ruling (gate3-human-grade-rulings.md
 * R-G6): `short-circuit-effect` promoted OUT of this map when static
 * prevaluation (`../prevalue/index.ts`, consulted by `../walker/walk.ts`)
 * landed — `(or #t (begin (set! n 999) 'x))`'s FIRST operand is a provable
 * `#t`, so the whole `or` folds to the value, and the `(begin (set! n 999)
 * 'x)` branch — Door and all — is dropped whole, never lowered. The
 * compiled artifact now contains no `set!` and no door to place; the
 * interpreter already never evaluated the untaken branch either. Both sides
 * agree on value 0 because the dead branch never contributed to the value
 * on EITHER side — not because the door's placement was re-argued away.
 * See `corpus/short-circuit-effect.expect.ts`'s own updated header.
 */
const KNOWN_RED: Readonly<Record<string, string>> = {
  // NOT red: short-circuit-control — the greenfield path resolves `error` through its
  // harvested define-kind registry row (rung-3 shim) → FRAME → stage-0 `error`
  // (SchemeUserError), so the taken-branch raise classifies user-error on both sides;
  // the legacy path's COMPILED_PREAMBLE shim serves only legacy A/B runs.
};

function describeOutcome(o: Outcome): string {
  if (o.kind === "value") {
    try {
      return `value ${JSON.stringify(o.value)}`;
    } catch {
      return `value <unstringifiable ${typeof o.value}>`;
    }
  }
  return `throw(${o.errorClass}): ${o.message}`;
}

function checkSide(side: "interpreter" | "compiled", outcome: Outcome, expected: ExpectedOutcome): void {
  if (expected.errorClass !== undefined) {
    const got = describeOutcome(outcome);
    expect(outcome.kind, `${side}: expected throw(${expected.errorClass}), got ${got}`).toBe("throw");
    if (outcome.kind === "throw") {
      expect(outcome.errorClass, `${side}: expected throw(${expected.errorClass}), got ${got}`).toBe(expected.errorClass);
    }
    return;
  }
  const want = show(expected.value); // JSON.stringify(undefined) is undefined-the-value — garbled message
  expect(outcome.kind, `${side}: expected value ${want}, got ${describeOutcome(outcome)}`).toBe("value");
  if (outcome.kind === "value") {
    expect(
      oracleEqual(outcome.value, expected.value),
      `${side}: expected value ${want}, got ${describeOutcome(outcome)}`,
    ).toBe(true);
  }
}

/** A sidecar sets exactly one of value | errorClass | divergent — loud authoring guard. */
function assertWellFormed(name: string, expected: ExpectedOutcome): void {
  const set = [
    expected.divergent !== undefined,
    expected.errorClass !== undefined,
    Object.hasOwn(expected, "value"),
  ].filter(Boolean).length;
  if (set !== 1) {
    throw new Error(`corpus/${name}.expect.ts must set exactly one of value | errorClass | divergent (got ${set})`);
  }
}

describe("bug-cell corpus — interpreter ≡ expected ≡ compiled", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
    cleanupOracleScratch();
  });

  for (const name of rows) {
    const runner = name in KNOWN_RED ? it.fails : it;
    runner(
      name,
      async () => {
        const source = readFileSync(`${corpusDir}${name}.scm`, "utf8");
        const { expected } = (await import(`./corpus/${name}.expect.ts`)) as { expected: ExpectedOutcome };
        assertWellFormed(name, expected);

        const verdict = await runOracle(session, source);

        if (expected.divergent !== undefined) {
          checkSide("interpreter", verdict.interpreter, expected.divergent.interpreter);
          checkSide("compiled", verdict.compiled, expected.divergent.compiled);
          // The row exists BECAUSE the sides disagree — if they ever converge,
          // the divergence is stale and the row must become a plain value row.
          expect(verdict.agree, `divergence-by-design row unexpectedly AGREES — promote to a plain row`).toBe(false);
          return;
        }

        checkSide("interpreter", verdict.interpreter, expected);
        checkSide("compiled", verdict.compiled, expected);
        expect(
          verdict.agree,
          `interpreter ≢ compiled — interpreter ${describeOutcome(verdict.interpreter)}; compiled ${describeOutcome(
            verdict.compiled,
          )}${verdict.detail === undefined ? "" : `; ${verdict.detail}`}`,
        ).toBe(true);
      },
      120_000,
    );
  }
});
