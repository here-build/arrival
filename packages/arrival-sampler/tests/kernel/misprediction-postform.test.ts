// misprediction-postform.test.ts — model-free pin for node G3 (post-first-top-level-close padding
// exclusion) of the sampler roadmap. The real misprediction harness (src/__research__) drives a model
// and is opt-in via `pnpm research`; this test exercises ONLY the pure aggregation + post-form detection
// so it runs in the default CI suite (no download, no model).
//
// THE CONFOUND it pins: the model never makes EOS its argmax, so generation runs to the token cap and
// keeps emitting MORE valid top-level forms / fences / prose AFTER the task program's first top-level
// form has closed. Those post-close steps are structurally feasible at top level and inflate the
// all-steps "feasible" rate. G3 stops counting steps once the FIRST complete top-level Scheme form has
// closed (firstTopLevelFormClosed), excluding them from totalSteps + every kind/mid-form/confidence
// tally while retaining them in the raw per-step array.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  aggregate,
  firstTopLevelFormClosed,
  type PreferKind,
  type StepMetric,
} from "../research/benchmarks/misprediction-metrics.js";

interface FixtureStep {
  prefix: string;
  preferKind: PreferKind;
  closeable: boolean;
  attemptedAtom?: string;
}
interface Fixture {
  taskId: string;
  steps: readonly FixtureStep[];
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../research/fixtures/post-close-stream.json", import.meta.url)), "utf8"),
) as Fixture;

/** Build a full StepMetric from a synthetic fixture step. `postForm` is DERIVED from the prefix via the
 *  detector under test (not stored in the fixture), so the test exercises detection + exclusion together. */
function toStep(f: FixtureStep, i: number, taskId: string): StepMetric {
  return {
    taskId,
    stepIndex: i,
    preferTokenId: 0,
    preferStr: "x",
    preferLogit: 0,
    preferProb: 0.5,
    top2Margin: 1,
    preferKind: f.preferKind,
    attemptedAtom: f.preferKind === "sigma" ? (f.attemptedAtom ?? null) : null,
    iterationsUntilFeasible: 1,
    widened: false,
    fallback: false,
    closeable: f.closeable,
    postForm: firstTopLevelFormClosed(f.prefix),
    arity: null,
  };
}

describe("G3 post-form-close padding exclusion", () => {
  const steps = FIXTURE.steps.map((f, i) => toStep(f, i, FIXTURE.taskId));

  it("(a) flags post-form starting exactly at the step after the first top-level close", () => {
    const flags = steps.map((s) => s.postForm);
    // First closed form is `(set-timer 600)`: prefix at the step that EMITS the final `)` (index 6,
    // prefix `(set-timer 600`) is still mid-form; index 7's prefix already contains the closed form.
    expect(flags.slice(0, 7)).toEqual(Array.from({ length: 7 }, () => false));
    expect(flags.slice(7).every((f) => f === true)).toBe(true);
    expect(flags.indexOf(true)).toBe(7);
  });

  it("(b) headline denominators count ONLY pre/at-close steps; post-close excluded", () => {
    const report = aggregate(steps);
    const preClose = steps.filter((s) => !s.postForm).length; // 7
    const postClose = steps.length - preClose; // 12

    expect(report.totalSteps).toBe(preClose);
    expect(report.postFormSteps).toBe(postClose);

    // Pre/at-close kinds only: indices 0-6 = 5 feasible, 1 sigma, 1 structural.
    expect(report.kindFreq.feasible).toBe(5);
    expect(report.kindFreq.sigma).toBe(1);
    expect(report.kindFreq.structural).toBe(1);
    expect(report.kindFreq.feasible + report.kindFreq.sigma + report.kindFreq.structural).toBe(report.totalSteps);

    // Mid-form (!closeable) is also taken over the task program only: all 7 pre-close steps are !closeable.
    expect(report.midFormSteps).toBe(7);

    // Confidence n's sum to the task-program denominator, not the full stream.
    const confN =
      report.confidenceByKind.feasible.n + report.confidenceByKind.sigma.n + report.confidenceByKind.structural.n;
    expect(confN).toBe(report.totalSteps);

    // The post-close `(play-sound "beep")` form's `beep` Σ-attempt must NOT leak into the symbol tally;
    // only the pre-close `6` Σ-attempt is counted.
    expect(report.attemptedSymbolTally.beep).toBeUndefined();
    expect(report.attemptedSymbolTally["6"]).toBe(1);
  });

  it("(c) a stream with NO post-close padding is unchanged (all steps counted)", () => {
    const noPadding = steps.filter((s) => !s.postForm); // truncate at first close → no post-form steps
    const report = aggregate(noPadding);
    expect(report.postFormSteps).toBe(0);
    expect(report.totalSteps).toBe(noPadding.length);
    expect(report.kindFreq.feasible + report.kindFreq.sigma + report.kindFreq.structural).toBe(noPadding.length);
  });

  it("firstTopLevelFormClosed: closes at the matching paren, respects strings, ignores prose", () => {
    expect(firstTopLevelFormClosed("")).toBe(false);
    expect(firstTopLevelFormClosed("(set-timer 600")).toBe(false); // unbalanced
    expect(firstTopLevelFormClosed("(set-timer 600)")).toBe(true);
    expect(firstTopLevelFormClosed('(play-sound ")")')).toBe(true); // `)` inside string doesn't close early
    expect(firstTopLevelFormClosed("no parens here")).toBe(false);
    expect(firstTopLevelFormClosed("(a (b))")).toBe(true); // nested closes only at top-level depth 0
  });
});
