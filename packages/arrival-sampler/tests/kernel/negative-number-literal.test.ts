// negative-number-literal.test.ts — a partial signed/decimal number at an ARGUMENT slot must stay
// feasible under a restricted Σ grant env. Regression: a tokenizer splits `-11` into `-`+`11`; the lone
// leading `-` was classified as the (unbound) subtraction identifier and masked → the constrained model
// lost the sign (emitted `11`). The structural+Σ oracle must read `-` as a negative-number-in-progress.

import { makeOracle, oracleEnvFromBindings } from "@inhuman.tools/arrival/oracle";
import { describe, it, expect } from "vitest";

import { classifyCandidate } from "../../src/mask-compiler.js";

describe("negative / decimal number literals survive the Σ gate at an argument slot", () => {
  // A Σ grant env binding ONLY the tool — arithmetic `-`/`+` are NOT bound (the BFCL-simple shape).
  const env = oracleEnvFromBindings({ solve_quadratic: () => 0 });
  const scanner = makeOracle(env);
  const at = "(solve_quadratic 3 "; // an argument slot

  // The cursor lands mid-token on a number prefix — all must be feasible (not Σ-masked).
  it.each(["-", "+", "-1", "-11", "-.5", "-.", ".5", ".", "+3", "2.0", "11"])(
    "keeps %j feasible (number-in-progress)",
    (frag) => {
      expect(classifyCandidate(scanner, at, frag)).not.toBe("sigma");
    },
  );

  // Step-by-step: `-` then `1` then `1` — the whole `-11` path stays open.
  it("admits the full -11 token across the - / 1 / 1 split", () => {
    expect(classifyCandidate(scanner, "(solve_quadratic 3 ", "-")).not.toBe("sigma");
    expect(classifyCandidate(scanner, "(solve_quadratic 3 -", "1")).not.toBe("sigma");
    expect(classifyCandidate(scanner, "(solve_quadratic 3 -1", "1")).not.toBe("sigma");
  });

  // Pure identifiers that merely start with a sign/dot are NOT numbers — they stay under Σ (unbound here).
  it.each(["->", "...", "-foo"])("still Σ-masks the unbound identifier %j", (frag) => {
    expect(classifyCandidate(scanner, at, frag)).toBe("sigma");
  });
});
