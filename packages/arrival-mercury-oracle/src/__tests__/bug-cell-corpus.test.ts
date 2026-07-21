/**
 * Tier-1 bug-cell corpus (oracle-harness.md §4.3) — every `corpus/<name>.scm`,
 * paired with its hand-reasoned row in `corpus/expectations.ts`, checked three
 * ways: interpreter ≡ expected, compiled ≡ expected, interpreter ≡ compiled.
 * The independent, hand-reasoned `expected` is what lets this tier catch an
 * INTERPRETER regression too — pure differential testing is blind to "both
 * sides agree on the same wrong answer."
 *
 * Divergence-by-design rows (`ExpectedOutcome.divergent` — exact overflow,
 * representation collapse) assert each side against its own half and never
 * check agreement; a divergent row that starts AGREEING is stale and must be
 * promoted to a plain value row (asserted in the row itself).
 *
 * KNOWN_RED rows are `it.fails`-tracked (the ruled convention, oracle-harness.md
 * §7 Q4): red for a reason OUTSIDE the landed machinery, with the owning
 * mechanism named per row. When that mechanism lands, the row starts failing
 * the `.fails` wrapper — the loud signal to promote it to a plain assertion,
 * never a flake to chase.
 *
 * Adding a case is "drop one `.scm` + one row in `expectations.ts`" — the
 * drift guard below keeps table ≡ directory, and a malformed row fails the
 * authoring sweep (and typecheck — the table is a static import, no longer a
 * per-row dynamic import that only failed at test time).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupOracleScratch, openOracleSession, oracleEqual, runOracle, show } from "@inhuman.tools/arrival-mercury-oracle";
import type { ExpectedOutcome, OracleSession, Outcome } from "@inhuman.tools/arrival-mercury-oracle";
import { CORPUS_EXPECTATIONS } from "./corpus/expectations.js";

const corpusDir = fileURLToPath(new URL("corpus/", import.meta.url));
const scmNames = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".scm"))
  .map((f) => f.slice(0, -".scm".length))
  .sort();

/**
 * Rows red under the GREENFIELD gate subject (constitution §9 subject-routing —
 * the harness's default since the subject flip). Every entry must be verified
 * against the live greenfield pipeline and the live interpreter, and name its
 * owning mechanism. Empty since the Wave-C integration gate (2026-07-14); the
 * promotion history of the rows that once lived here (the `modulo` emit rule,
 * the stage-0 equality/list walkers, value-returning SRFI every/any,
 * short-circuit-effect's prevalue elimination) is this file's git archaeology.
 */
const KNOWN_RED: Readonly<Record<string, string>> = {};

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

describe("bug-cell corpus — interpreter ≡ expected ≡ compiled", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
    cleanupOracleScratch();
  });

  it("drift guard — every .scm has exactly one expectations row and vice versa", () => {
    expect(scmNames.length, "corpus/*.scm is empty").toBeGreaterThan(0);
    const names = CORPUS_EXPECTATIONS.map((r) => r.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, "duplicate row names in expectations.ts").toEqual([]);
    expect([...names].sort(), "expectations.ts rows ≡ corpus/*.scm").toEqual(scmNames);
  });

  it("authoring sweep — every row sets exactly one of value | errorClass | divergent", () => {
    const malformed = CORPUS_EXPECTATIONS.filter((r) => {
      const set = [
        r.expected.divergent !== undefined,
        r.expected.errorClass !== undefined,
        Object.hasOwn(r.expected, "value"),
      ].filter(Boolean).length;
      return set !== 1;
    }).map((r) => r.name);
    expect(malformed).toEqual([]);
  });

  for (const row of CORPUS_EXPECTATIONS) {
    const runner = row.name in KNOWN_RED ? it.fails : it;
    runner(
      row.name,
      async () => {
        const source = readFileSync(`${corpusDir}${row.name}.scm`, "utf8");
        const verdict = await runOracle(session, source);

        const expected = row.expected;
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
