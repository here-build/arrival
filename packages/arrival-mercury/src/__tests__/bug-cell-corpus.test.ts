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
 * Rows red for NON-Phase-0 reasons. Phase 0 fixes truthiness only (`lowerIf` /
 * `emitTailForm` / `and` / `or` / `not`); these rows pin cells owned by later
 * mechanisms. Every reason below was verified against the live emitters and
 * the live interpreter, not transcribed from the spec.
 */
const KNOWN_RED: Readonly<Record<string, string>> = {
  "short-circuit-effect":
    "prohibited-dynamics Door is Phase 1 (CoreForm): compiled output carries a bare `set(n, 999)` call, and today's interpreter lazily skips the untaken or-branch (returns 0) — no static door on either side yet",
  // NOT red: short-circuit-control — the harness's COMPILED_PREAMBLE supplies the
  // error() shim (harness.ts), so the taken-branch (error …) raise classifies
  // user-error on both sides today; the Phase-1/2 per-symbol residual will merely
  // replace the shim, not change the verdict.
  "modulo-neg":
    "compiled emits the JS remainder `-7 % 3` → -1; the correct-algorithm modulo residual is Phase-1 slice work, not Phase-0 truthiness",
  "equal-nested-list":
    "compiled equal? emits `===` (reference compare on two fresh arrays → false); structural equal? residual is Phase 1/2 (operator-identity cell)",
  "eq-vs-equal-string-eq":
    "compiled eq? emits `===` on JS string primitives → true; interpreter eq? is boxed-string identity → #f; per-symbol eq? residual is Phase 1/2",
  "member-assoc":
    "member/assoc have no emitters — compiled output calls bare unbound identifiers (ReferenceError); per-symbol residuals are Phase 1/2",
  "nan-eqv":
    "compiled eqv? emits `===` (NaN === NaN → false); interpreter eqv? is Object.is-shaped (#t); eqv? residual is Phase 1/2",
  "neg-zero-eqv":
    "compiled eqv? emits `===` (-0.0 === 0.0 → true); interpreter Object.is → #f; same eqv? cell as nan-eqv",
  "symbol-face":
    "representation-law gap: mercury lowers 'hello to the interned-name face \"hello\" while rosetta egress is \"'hello\" (ASymbol arrival/toJS) — reconciliation unowned by any current phase",
  "every-last-value":
    "SRFI every is value-RETURNING (last predicate result, 2); compiled .every folds to a boolean — the value-shape residual is Phase 1/2 (the predicate-boundary truthiness half is already fixed)",
  "any-witness":
    "SRFI any returns the first truthy predicate RESULT; mercury has no `any` emitter — unbound identifier in the artifact; per-symbol residual is Phase 1/2",
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
