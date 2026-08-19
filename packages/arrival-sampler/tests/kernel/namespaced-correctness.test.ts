// namespaced-correctness.test.ts — verdict: the cross-scheme correctness scorer is sound.
//
// The Stage-0 measurement spine needs a per-task binary correctness signal that is IDENTICAL across
// naming schemes (canonical, dei, die, bang, bdei, bdie) — otherwise an A/B between schemes compares
// apples to relabelled apples. This test hand-writes a CORRECT program in each scheme's surface syntax
// and asserts it scores `ok`, and that a wrong-tool program does not. No model — pure scorer + sim.

import { describe, expect, it } from "vitest";

import { TOOL_BY_NAME } from "../../src/runners/fixtures/apple-intents/registry.js";
import { TASKS } from "../../src/runners/fixtures/apple-intents/tasks.js";
import { runAndScore } from "../harness/score.js";
import { appleName, makeNamespacedDeviceSim, type Scheme } from "../../src/runners/apple-namespaced.js";

const SCHEMES: Scheme[] = ["dei", "die", "bang", "bdei", "bdie"];
const timerTask = TASKS.find((t) => t.id === "timer-10min")!;
const textTask = TASKS.find((t) => t.id === "text-mom-late")!;

/** The renamed head for a canonical tool under a scheme (what the model must emit). */
const nameOf = (canonical: string, scheme: Scheme): string => appleName(TOOL_BY_NAME.get(canonical)!, scheme);

describe("namespaced sim records canonical names → existing predicates score every scheme", () => {
  it.each(SCHEMES)("%s: a correct timer program scores ok", async (scheme) => {
    const sim = await makeNamespacedDeviceSim(scheme);
    const program = `(${nameOf("set-timer", scheme)} (* 10 60))`;
    const r = await runAndScore(program, timerTask, sim);
    expect(r.category).toBe("ok");
  });

  it.each(SCHEMES)("%s: a correct send-message program scores ok", async (scheme) => {
    const sim = await makeNamespacedDeviceSim(scheme);
    const program = `(${nameOf("send-message", scheme)} "Mom" "I'll be 10 minutes late")`;
    const r = await runAndScore(program, textTask, sim);
    expect(r.category).toBe("ok");
  });

  it.each(SCHEMES)("%s: the WRONG tool does not score ok", async (scheme) => {
    const sim = await makeNamespacedDeviceSim(scheme);
    // Using the flashlight to satisfy a timer task must not pass.
    const program = `(${nameOf("set-flashlight", scheme)} #t)`;
    const r = await runAndScore(program, timerTask, sim);
    expect(r.category).not.toBe("ok");
  });
});
