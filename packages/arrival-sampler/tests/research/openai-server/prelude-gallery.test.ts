// prelude-gallery.test.ts — the FIRST oracle experiment (opt-in: `pnpm research`). Two artifacts to
// __research-output__/, both MODEL-FREE so the pipeline is exercisable without a GPU:
//
//   1. prelude-gallery.md — every prompt strategy rendered for a representative Σ, side by side, so the
//      declaration shapes can be eyeballed before a model ever runs.
//   2. demo-sweep.csv — the engine run with a CANNED decode over a tiny suite, producing the aggregate table.
//      This proves the sweep → artifact pipeline end to end; a REAL run swaps the canned decode for the oracle
//      endpoint / makeRealDecode bound to each roster model, and the trivial evaluate for the BFCL checker.
//      (See README.md for the full design + the real-wiring step.)

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  runExperiment,
  type ExperimentDecoder,
  type ExperimentEntry,
  type ExperimentEvaluate,
} from "./experiment.js";
import { PROMPT_STRATEGIES } from "./prompt-strategies.js";
import type { OpenAITool } from "../../../src/runners/server/openai-types.js";

const OUT = fileURLToPath(new URL("../../src/runners/server/../../src/runners/server/src/__research-output__/", import.meta.url));

const sampleTools: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Current weather for a location.",
      parameters: {
        type: "object",
        properties: { location: { type: "string" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the web for a query.",
      parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
    },
  },
];

type Answer = Record<string, Record<string, string[]>>;

describe("prelude experiment artifacts", () => {
  it("writes the prelude gallery (every strategy rendered for the same Σ)", () => {
    mkdirSync(OUT, { recursive: true });
    const md = [
      "# Prelude gallery — `Σ → systemPrompt` per strategy",
      "",
      "_Regenerate with `pnpm research`. The grammar enforces validity regardless of the prelude; this is only",
      "about which teaching shape a model decodes best._",
      "",
      ...PROMPT_STRATEGIES.flatMap((s) => [`## ${s.name}`, "", `> ${s.description}`, "", "```", s.render(sampleTools), "```", ""]),
    ].join("\n");
    writeFileSync(path.join(OUT, "prelude-gallery.md"), md);
    expect(md).toContain("scheme-decl");
    expect(md).toContain("(define (get_weather location unit)");
  });

  it("writes a demo aggregate CSV from a canned sweep (real run swaps the decode + evaluate)", async () => {
    const dataset: ExperimentEntry<Answer>[] = [
      { id: "s1", category: "simple", userPrompt: "weather in Paris?", tools: [sampleTools[0]!], answer: { get_weather: { location: ["Paris"] } } },
      { id: "s2", category: "simple", userPrompt: "search for cats", tools: [sampleTools[1]!], answer: { search_web: { query: ["cats"] } } },
    ];
    const decoders: ExperimentDecoder[] = [
      { model: "canned-good", decode: ({ userPrompt }) => Promise.resolve(userPrompt.includes("Paris") ? `(get_weather "Paris")` : `(search_web "cats")`) },
    ];
    const evaluate: ExperimentEvaluate<Answer> = (output, entry) => {
      const [fn, params] = Object.entries(entry.answer)[0]!;
      const okValue = Object.values(params)[0]?.some((v) => output.includes(v)) ?? false;
      return { pass: output.includes(fn) && okValue, signals: { outLen: output.length } };
    };

    const result = await runExperiment({ format: "scheme", decoders, strategies: PROMPT_STRATEGIES, dataset, evaluate });

    const header = "format,model,strategy,n,accuracy,outLen";
    const rows = result.aggregates.map(
      (a) => `${a.format},${a.model},${a.strategy},${a.n},${a.accuracy.toFixed(3)},${(a.signals.outLen ?? 0).toFixed(1)}`,
    );
    writeFileSync(path.join(OUT, "demo-sweep.csv"), [header, ...rows].join("\n"));
    expect(result.aggregates.length).toBe(PROMPT_STRATEGIES.length); // one (model,strategy) row per strategy
  });
});
