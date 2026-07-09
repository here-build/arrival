// Q20a — eager-oracle opt-out law (PROVENANCE-PLAN.md Q20 split; the sampler case).
//
// `setEagerProvenanceOracleEnabled(false)` is the process-wide opt-OUT for provenance
// NON-consumers with real-time budgets (arrival-sampler's oracle loop). The law has
// three clauses:
//   1. Flag OFF skips stamp ACCUMULATION — results carry empty provenance even when
//      operands are stamped, and boolean verdicts collapse to the eq?-stable
//      flyweights (allocation-free hot loop).
//   2. Flag OFF does NOT skip BOXING — R1's boxed-value discipline is semantics, not
//      provenance payload: raw scalars still exit `withInputProvenance` boxed.
//   3. The default is ON and restoring it restores stamping — Q20b (post Q16/Q19)
//      owns flipping the default; until then production provenance rides this path.
//
// Granularity note: the flag is module-global by ruling (V, 2026-07-09: sampler is an
// experimental package running in its own processes). If a process ever needs stamped
// and unstamped envs simultaneously, upgrade path = RunContext-carried flag.

import { describe, it, expect, afterEach } from "vitest";
import {
  isEagerProvenanceOracleEnabled,
  setEagerProvenanceOracleEnabled,
  withInputProvenance,
  mintVerdict,
  schemeTrue,
  schemeFalse,
} from "../../values/op-helpers.js";
import { AValue } from "../../values/primitives/AValue.js";
import { fromJs } from "../../values/primitives/boxing.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";

const stamped = (v: number, id: number): AValue =>
  fromJs(CONSTANT_CTX, v, new Set([id])) as AValue;

afterEach(() => setEagerProvenanceOracleEnabled(true));

describe("Q20a — eager-oracle opt-out (@ledger: Q20a — LANDED)", () => {
  it("default is ON, and ON stamps: result unions operand provenance", () => {
    expect(isEagerProvenanceOracleEnabled()).toBe(true);
    const out = withInputProvenance([stamped(1, 7), stamped(2, 9)], 3);
    expect(out).toBeInstanceOf(AValue);
    expect([...(out as unknown as AValue).provenance].sort()).toEqual([7, 9]);
  });

  it("OFF skips accumulation: stamped operands, empty-provenance result", () => {
    setEagerProvenanceOracleEnabled(false);
    const out = withInputProvenance([stamped(1, 7), stamped(2, 9)], 3);
    expect(out).toBeInstanceOf(AValue); // clause 2: boxing survives
    expect((out as unknown as AValue).provenance.size).toBe(0); // clause 1
  });

  it("OFF collapses verdicts to the eq?-stable flyweights even from stamped operands", () => {
    setEagerProvenanceOracleEnabled(false);
    expect(mintVerdict([stamped(1, 7)], true)).toBe(schemeTrue);
    expect(mintVerdict([stamped(1, 7)], false)).toBe(schemeFalse);
  });

  it("OFF leaves already-boxed results untouched (no strip, no re-wrap)", () => {
    setEagerProvenanceOracleEnabled(false);
    const boxed = stamped(5, 7);
    expect(withInputProvenance([stamped(1, 9)], boxed)).toBe(boxed);
  });

  it("round-trip: restoring ON restores stamping", () => {
    setEagerProvenanceOracleEnabled(false);
    setEagerProvenanceOracleEnabled(true);
    const out = withInputProvenance([stamped(1, 7)], 2);
    expect([...(out as unknown as AValue).provenance]).toEqual([7]);
  });
});
