// sigma.test.ts — characterization/regression pins for the Σ (bound-symbol) gate `passesSigma`
// in mask-compiler.ts. These behaviors (literal-position-gating + the `:`-keyword member-read
// exemption) were landed earlier but NOT pinned by any test. This file pins them so a concurrent
// interpreter-side refactor can't silently revert line 99 (`:`-keyword at operator/argument) or the
// literal-position gate (`(1 …)` / `(#t …)` ungeneratable) without a red test.
//
// We drive `classifyCandidate(scanner, prefix, candidateStr)` directly (the SAME oracle path the
// mask uses) and assert on the returned reason ("feasible" | "structural" | "sigma"). No toy vocab
// is needed — the classifier takes raw prefix/candidate strings. Σ is only live with a grant env, so
// every case uses `makeOracle(grantEnv())`, binding ONLY car/cdr/some-bound-op as callables.

// Resolved to arrival-scheme SOURCE via vitest alias (see vitest.config.ts) — the REAL oracle.

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { describe, it, expect } from "vitest";

import { classifyCandidate } from "../../src/mask-compiler.js";

/** Identity stand-in for a callable binding value (a function value ⇒ callable in arrival's env). */
const callable = (x: unknown): unknown => x;

/** A tiny grant env binding car/cdr AND a multi-char `some-bound-op` (so `(ca` prefixes `car` and
 *  `some-bound-op ` is a usable operator that fixes an argument slot). */
function grantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({
    car: callable,
    cdr: callable,
    "some-bound-op": callable,
  });
}

/** One Σ-gate characterization row: a (prefix, candidate) probe and whether Σ must REJECT it ("sigma").
 *  `rejected: true` ⇒ `classifyCandidate(...)` must be "sigma"; `false` ⇒ must NOT be "sigma" (admitted). */
interface SigmaCase {
  readonly prefix: string;
  readonly candidate: string;
  readonly rejected: boolean;
  readonly why: string;
}
const assertSigma = (scanner: ReturnType<typeof makeOracle>, { prefix, candidate, rejected }: SigmaCase): void => {
  const verdict = classifyCandidate(scanner, prefix, candidate);
  if (rejected) expect(verdict).toBe("sigma");
  else expect(verdict).not.toBe("sigma");
};

describe("passesSigma (via classifyCandidate) — `:`-keyword member-read exemption", () => {
  const scanner = makeOracle(grantEnv());

  // A `:`-keyword is callable-like (a member-read), so it is exempt from Σ at BOTH an argument slot and an
  // operator slot (line 99). Every probe here must be admitted (not "sigma").
  it.each<SigmaCase>([
    { prefix: "(car ", candidate: ":", rejected: false, why: "`:` at an ARGUMENT slot (keyword accessor, mid-atom)" },
    { prefix: "(car ", candidate: ":Field", rejected: false, why: "`:Field` at an ARGUMENT slot" },
    { prefix: "(", candidate: ":Field", rejected: false, why: "`:Field` at an OPERATOR slot (line 99)" },
    { prefix: "(", candidate: ":", rejected: false, why: "bare `:` at an OPERATOR slot" },
  ])("$why is admissible (not sigma)", (c) => assertSigma(scanner, c));
});

describe("passesSigma (via classifyCandidate) — literal position-gating", () => {
  const scanner = makeOracle(grantEnv());

  // `#t`/`#f`/numbers are VALUES, exempt from Σ ONLY at an ARGUMENT slot. At the OPERATOR slot the exemption
  // does NOT apply (a literal prefixes no bound callable) → "sigma". The `1`-at-operator case is what kills `(1)`.
  it.each<SigmaCase>([
    { prefix: "(some-bound-op ", candidate: "#", rejected: false, why: "`#` (#-literal prefix) at an ARGUMENT slot" },
    { prefix: "(some-bound-op ", candidate: "#t", rejected: false, why: "`#t` at an ARGUMENT slot" },
    { prefix: "(some-bound-op ", candidate: "5", rejected: false, why: "a number `5` at an ARGUMENT slot" },
    { prefix: "(", candidate: "#", rejected: true, why: "`#` at an OPERATOR slot" },
    { prefix: "(", candidate: "1", rejected: true, why: "a number `1` at an OPERATOR slot (kills `(1)`)" },
  ])("$why → rejected=$rejected", (c) => assertSigma(scanner, c));
});

describe("passesSigma (via classifyCandidate) — the gate still earns its keep", () => {
  const scanner = makeOracle(grantEnv());

  // The gate REJECTS an unbound operator atom but must NOT over-reject a live prefix / a full bound callable.
  it.each<SigmaCase>([
    { prefix: "(", candidate: "nonexistent-tool", rejected: true, why: "an unbound operator atom" },
    { prefix: "(", candidate: "ca", rejected: false, why: "a BOUND operator prefix `ca` (prefix of car)" },
    { prefix: "(", candidate: "car", rejected: false, why: "the full bound callable `car` at an OPERATOR slot" },
  ])("$why → rejected=$rejected", (c) => assertSigma(scanner, c));
});
