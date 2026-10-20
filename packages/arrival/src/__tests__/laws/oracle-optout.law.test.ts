// Q20a/Q20b — eager-oracle opt-in law (docs/PROVENANCE.md §4 "the eager stamp path is a
// TEST-ONLY oracle"), restated for P17-P19: the oracle is a per-RUN flag
// (`RunContext.eagerStamps`), not a module global.
//
// Clauses:
//   1. The DEFAULT run is OFF — it accumulates ZERO stamps, even from stamped operands.
//   2. OFF does NOT skip BOXING — R1's boxed-value discipline is semantics, not
//      provenance payload: raw scalars still exit `withInputProvenance` boxed.
//   3. OFF collapses boolean verdicts to the eq?-stable flyweights (allocation-free).
//   4. A run minted `eagerStamps: true` (the CI agreement oracle's own opt-in) restores full
//      accumulation — the oracle exists, on demand. A `silent` run (γ/replay) accumulates too.
//   5. CONCURRENCY: an eager run and a plain run interleaved yield exactly the stamps each
//      yields alone — the flag cannot leak between runs.
//
// W4 ACCUMULATION DEATH (P10's exit-gate phrase: "eager mode demoted to oracle; 186MB
// failure mode gone"): a REAL program through the REAL interpreter with default options
// carries EMPTY provenance end-to-end.
import { describe, it, expect } from "vitest";
import type { EnvWithInternals, ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { withInputProvenance, mintVerdict } from "../../values/op-helpers.js";
import { schemeTrue, schemeFalse } from "../../values/primitives/ABool.js";
import { AValue } from "../../values/primitives/AValue.js";
import { fromJs } from "../../membrane/boxing.js";
import { CONSTANT_CTX, RunContext } from "../../run/RunContext.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { jsToScheme } from "../../membrane/rosetta.js";

const stamped = (v: number, id: number): AValue => fromJs(CONSTANT_CTX, v, new Set([id])) as AValue;
const OFF = new RunContext({});
const ON = new RunContext({ eagerStamps: true });
const SILENT = new RunContext({ silent: true });

describe("Q20b — eager-oracle demotion (@ledger: Q20b — LANDED)", () => {
  it("default run is OFF: production hot path accumulates nothing, even from stamped operands", () => {
    expect(OFF.eagerStamps).toBe(false);
    const out = withInputProvenance(OFF, [stamped(1, 7), stamped(2, 9)], 3);
    expect(out).toBeInstanceOf(AValue); // clause 2: boxing survives regardless
    expect((out as unknown as AValue).provenance.size).toBe(0); // clause 1
  });

  it("default OFF collapses verdicts to the eq?-stable flyweights even from stamped operands", () => {
    expect(mintVerdict(OFF, [stamped(1, 7)], true)).toBe(schemeTrue);
    expect(mintVerdict(OFF, [stamped(1, 7)], false)).toBe(schemeFalse);
  });

  it("default OFF leaves already-boxed results untouched (no strip, no re-wrap)", () => {
    const boxed = stamped(5, 7);
    expect(withInputProvenance(OFF, [stamped(1, 9)], boxed)).toBe(boxed);
  });

  it("an eagerStamps run restores full accumulation (the CI agreement opt-in)", () => {
    const out = withInputProvenance(ON, [stamped(1, 7), stamped(2, 9)], 3);
    expect(out).toBeInstanceOf(AValue);
    expect([...(out as unknown as AValue).provenance].sort()).toEqual([7, 9]);
  });

  it("a silent run (γ/replay) accumulates by construction, without eagerStamps", () => {
    const out = withInputProvenance(SILENT, [stamped(1, 7)], 2);
    expect([...(out as unknown as AValue).provenance]).toEqual([7]);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // W4 — the accumulation death, proven through a REAL exec (not a direct
  // op-helpers.ts call), at the production default, no option touched.
  // ─────────────────────────────────────────────────────────────────────────────
  const PROGRAM = `(string-append "sum=" (number->string (+ a (* b 2))))`;
  const runProgram = async (tag: string, eagerStamps: boolean): Promise<number[]> => {
    const env = inferenceEnv.child(`oracle-${tag}`) as EnvWithInternals<ResolvingAmbient>;
    env.bind("a", jsToScheme(CONSTANT_CTX, 10, {}, new Set([100])));
    env.bind("b", jsToScheme(CONSTANT_CTX, 20, {}, new Set([200])));
    const [result] = (await execState(PROGRAM, eagerStamps ? { env, eagerStamps } : { env })).values;
    expect(result).toBeInstanceOf(AValue);
    return [...(result as AValue).provenance].sort((x, y) => x - y);
  };

  it("W4 — a real program run with DEFAULT options accumulates ZERO stamps end-to-end", async () => {
    expect(await runProgram("w4", false)).toEqual([]);
  });

  it("law — an eager run and a plain run in flight together stamp exactly as they do alone (no flag leak)", async () => {
    const eagerAlone = await runProgram("alone-eager", true);
    const plainAlone = await runProgram("alone-plain", false);
    expect(eagerAlone).toEqual([100, 200]);
    expect(plainAlone).toEqual([]);

    const [eagerTogether, plainTogether, eagerTogether2, plainTogether2] = await Promise.all([
      runProgram("conc-eager-1", true),
      runProgram("conc-plain-1", false),
      runProgram("conc-eager-2", true),
      runProgram("conc-plain-2", false),
    ]);
    expect(eagerTogether).toEqual(eagerAlone);
    expect(eagerTogether2).toEqual(eagerAlone);
    expect(plainTogether).toEqual(plainAlone);
    expect(plainTogether2).toEqual(plainAlone);
  });
});
