/**
 * Gate 1 — the frozen §9 type-availability metric, executed against the
 * committed gate1-corpus manifest.
 *
 * Scope (per the mission's own instruction: "Do NOT interpret the Gate-1 number
 * … measure and report; the readout is the gate agent's + V's"): this test
 * asserts the MEASUREMENT RUNS (zero classify-time doors, the sample-size guard
 * clears) and that the emitted report BYTE-MATCHES the committed
 * `gate1-report.json` — a metric change (a lens improvement, a rule landing, a
 * corpus edit) becomes a visible, reviewed diff, never silent drift. Re-generate
 * the committed file only via an explicit re-run when a change is intentional
 * (mirroring the goldens' "re-base once, explicitly" discipline, constitution §8).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GATE1_MANIFEST, runGate1Measurement, SAMPLE_SIZE_THRESHOLD } from "../gate1/measure.js";
import { openOracleSession } from "../index.js";
import type { OracleSession } from "../index.js";

const REPORT_PATH = fileURLToPath(new URL("fixtures/gate1-report.json", import.meta.url));

describe("Gate 1 — type-availability measurement over the committed corpus", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
  });

  it("the manifest names exactly the three committed corpus programs", () => {
    expect(GATE1_MANIFEST.map((m) => m.name)).toEqual([
      "inhuman-gepa-full",
      "mercury-fixture-gepa",
      "ai-winter-ebl-investigation",
    ]);
  });

  it("runs clean (zero classify-time doors per program) and clears the sample-size guard", () => {
    const report = runGate1Measurement(session);
    for (const p of report.perProgram) {
      expect(p.doors, `${p.name} should classify through OUR front with zero malformed doors`).toBe(0);
    }
    expect(report.sampleSizeGuard.measured).toBeGreaterThanOrEqual(SAMPLE_SIZE_THRESHOLD);
    expect(report.sampleSizeGuard.passed).toBe(true);
  });

  it("matches the committed gate1-report.json byte-for-byte", () => {
    const report = runGate1Measurement(session);
    const committed = JSON.parse(readFileSync(REPORT_PATH, "utf8")) as unknown;
    expect(report).toEqual(committed);
  });
});
