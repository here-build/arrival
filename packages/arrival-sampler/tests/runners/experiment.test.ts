// experiment.test.ts — the sweep engine + the prelude strategies, MODEL-FREE: canned decoders stand in for the
// roster, a trivial evaluator for the BFCL checker. Asserts the matrix shape, the per-(model, strategy)
// aggregation (accuracy + by-category + signal means), and that the four strategies render DISTINCT prompts.

import { describe, expect, it } from "vitest";

import {
  runExperiment,
  type ExperimentDecoder,
  type ExperimentEntry,
  type ExperimentEvaluate,
} from "../research/openai-server/experiment.js";
import { PROMPT_STRATEGIES, promptStrategy } from "../research/openai-server/prompt-strategies.js";
import type { OpenAITool } from "../../src/runners/server/openai-types.js";

const weatherTool: OpenAITool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Current weather for a location.",
    parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
  },
};

/** Ground truth in BFCL shape: per function, per param, a list of acceptable values. */
type Answer = Record<string, Record<string, string[]>>;

const dataset: ExperimentEntry<Answer>[] = [
  { id: "e1", category: "simple", userPrompt: "weather in Paris?", tools: [weatherTool], answer: { get_weather: { location: ["Paris"] } } },
  { id: "e2", category: "parallel", userPrompt: "weather in Rome?", tools: [weatherTool], answer: { get_weather: { location: ["Rome"] } } },
];

// Two canned "models": one always emits the right call, one always emits a wrong one.
const decoders: ExperimentDecoder[] = [
  { model: "good", decode: ({ userPrompt }) => Promise.resolve(`(get_weather "${userPrompt.includes("Paris") ? "Paris" : "Rome"}")`) },
  { model: "bad", decode: () => Promise.resolve(`(get_weather "Berlin")`) },
];

// Trivial evaluator: pass iff the output contains an acceptable location; emit one behavioral signal (length).
const evaluate: ExperimentEvaluate<Answer> = (output, entry) => {
  const accepted = entry.answer.get_weather?.location ?? [];
  return { pass: accepted.some((loc) => output.includes(loc)), signals: { outLen: output.length } };
};

describe("runExperiment", () => {
  it("sweeps roster × strategy × suite and aggregates per (model, strategy)", async () => {
    const result = await runExperiment({ format: "scheme", decoders, strategies: PROMPT_STRATEGIES, dataset, evaluate });

    // 2 models × 4 strategies × 2 entries.
    expect(result.cells.length).toBe(2 * 4 * 2);
    // 2 models × 4 strategies aggregate cells.
    expect(result.aggregates.length).toBe(8);

    const good = result.aggregates.filter((a) => a.model === "good");
    const bad = result.aggregates.filter((a) => a.model === "bad");
    expect(good).toHaveLength(4);
    expect(good.every((a) => a.accuracy === 1)).toBe(true);
    expect(bad.every((a) => a.accuracy === 0)).toBe(true);

    // by-category split present, and the behavioral signal averaged.
    const oneGood = good[0]!;
    expect(Object.keys(oneGood.byCategory).sort()).toEqual(["parallel", "simple"]);
    expect(oneGood.byCategory.simple).toBe(1);
    expect(oneGood.signals.outLen).toBeGreaterThan(0);
    expect(oneGood.n).toBe(2);
  });

  it("the four prelude strategies render DISTINCT, non-empty prompts that name the tool", () => {
    const prompts = PROMPT_STRATEGIES.map((s) => s.render([weatherTool]));
    expect(new Set(prompts).size).toBe(4);
    for (const p of prompts) {
      expect(p.length).toBeGreaterThan(0);
      expect(p).toContain("get_weather");
    }
  });

  it("scheme-decl renders a Scheme declaration; symbols renders a bare name list", () => {
    expect(promptStrategy("scheme-decl").render([weatherTool])).toContain("(define (get_weather location)");
    expect(promptStrategy("symbols").render([weatherTool])).toContain("get_weather");
  });

  it("promptStrategy throws on an unknown name", () => {
    expect(() => promptStrategy("nope")).toThrow(/unknown prompt strategy/);
  });
});
