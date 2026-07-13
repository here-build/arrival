/**
 * The corpus tier-1 contract (oracle-harness.md §2/§4.3): a hand-authored
 * `.scm` row carries an independent, hand-reasoned `ExpectedOutcome` sidecar,
 * and the test checks THREE ways — `interpreter ≡ expected`, `compiled ≡
 * expected`, `interpreter ≡ compiled` — so an *interpreter* regression is
 * caught too (pure differential testing is blind to "both sides agree on the
 * same wrong answer"). Divergence-by-design rows (`divergent`, the RATIO
 * ruling's exact-overflow class) instead check each side against its own half
 * and never assert `interpreter ≡ compiled`.
 *
 * Sidecars are TS, not JSON, because `value` can be `NaN`/`-0` — and because
 * `value: undefined` is a legitimate expectation (`(if #f 'a)`), presence is
 * detected via `Object.hasOwn`, so a row expecting `undefined` must write
 * `{ value: undefined }` explicitly.
 */
import type { ErrorClass } from "./error-classifier.js";
import {
  agreementOf,
  evalCompiled,
  evalInterpreter,
  oracleEqual,
  type OracleSession,
  type Outcome,
  show,
} from "./harness.js";
import type { Strategy } from "@inhuman.tools/mercury";

export interface ExpectedOutcome {
  readonly value?: unknown; // mutually exclusive with errorClass and divergent
  readonly errorClass?: ErrorClass;
  /** Divergence-by-design (spec §2): interpreter and compiled are EXPECTED to
   *  disagree (exact overflow: interpreter throws the teaching error, compiled
   *  floats on). When present, each side is checked against its own half and
   *  the usual three-way `interpreter ≡ compiled` check does not apply. */
  readonly divergent?: { readonly interpreter: ExpectedOutcome; readonly compiled: ExpectedOutcome };
}

/**
 * Match one outcome against one (non-divergent) expectation. Returns
 * `undefined` on match, else a human-readable reason — the corpus test's
 * failure vocabulary.
 */
export function outcomeMatches(outcome: Outcome, expected: ExpectedOutcome): string | undefined {
  if (expected.divergent !== undefined) {
    throw new Error("outcomeMatches: `divergent` is a row-level split — runCorpusCase routes each half to its side");
  }
  const hasValue = Object.hasOwn(expected, "value");
  const hasClass = expected.errorClass !== undefined;
  if (hasValue === hasClass) {
    throw new Error("ExpectedOutcome must set exactly one of `value` / `errorClass` (or `divergent` at the row level)");
  }
  if (hasValue) {
    if (outcome.kind !== "value") {
      return `expected value ${show(expected.value)}, got throw [${outcome.errorClass}] "${outcome.message}"`;
    }
    return oracleEqual(outcome.value, expected.value)
      ? undefined
      : `expected value ${show(expected.value)}, got ${show(outcome.value)}`;
  }
  if (outcome.kind !== "throw") return `expected throw [${expected.errorClass}], got value ${show(outcome.value)}`;
  return outcome.errorClass === expected.errorClass
    ? undefined
    : `expected throw [${expected.errorClass}], got throw [${outcome.errorClass}] "${outcome.message}"`;
}

function validateExpected(expected: ExpectedOutcome): void {
  const marks = [
    Object.hasOwn(expected, "value"),
    expected.errorClass !== undefined,
    expected.divergent !== undefined,
  ].filter(Boolean).length;
  if (marks !== 1) throw new Error("ExpectedOutcome must set exactly one of `value` / `errorClass` / `divergent`");
  if (expected.divergent !== undefined) {
    for (const [side, half] of Object.entries(expected.divergent)) {
      if (half.divergent !== undefined) {
        throw new Error(`ExpectedOutcome.divergent.${side} must not itself be divergent`);
      }
    }
  }
}

export interface CorpusVerdict {
  pass: boolean;
  /** Empty on pass; each entry names which of the checks failed and why. */
  failures: string[];
  interpreter: Outcome;
  compiled: Outcome;
}

/**
 * Run one corpus row end-to-end: evaluate both sides ONCE, then apply either
 * the three-way check (plain rows) or the per-side divergent check (spec §4.3).
 */
export async function runCorpusCase(
  session: OracleSession,
  source: string,
  expected: ExpectedOutcome,
  opts?: { strategy?: Strategy },
): Promise<CorpusVerdict> {
  validateExpected(expected);
  const interpreter = await evalInterpreter(session, source);
  const compiled = await evalCompiled(source, opts);
  const failures: string[] = [];
  if (expected.divergent !== undefined) {
    const mi = outcomeMatches(interpreter, expected.divergent.interpreter);
    if (mi !== undefined) failures.push(`interpreter ≢ expected.divergent.interpreter: ${mi}`);
    const mc = outcomeMatches(compiled, expected.divergent.compiled);
    if (mc !== undefined) failures.push(`compiled ≢ expected.divergent.compiled: ${mc}`);
  } else {
    const mi = outcomeMatches(interpreter, expected);
    if (mi !== undefined) failures.push(`interpreter ≢ expected: ${mi}`);
    const mc = outcomeMatches(compiled, expected);
    if (mc !== undefined) failures.push(`compiled ≢ expected: ${mc}`);
    const { agree, detail } = agreementOf(interpreter, compiled);
    if (!agree) failures.push(`interpreter ≢ compiled: ${detail ?? "disagree"}`);
  }
  return { pass: failures.length === 0, failures, interpreter, compiled };
}
