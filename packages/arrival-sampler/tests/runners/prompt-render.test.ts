// prompt-render.test.ts — the two tool surfaces. The compact (prompt-contract) surface must be TERSE: names +
// positional signatures, NO descriptions / per-param doc. The verbose (fc-contract) surface carries the full
// schema (descriptions, required flags, enum lists).

import { describe, it, expect } from "vitest";

import { renderCompactToolPrompt, renderVerboseToolPrompt, renderToolPrompt } from "../../src/runners/server/prompt-render.js";
import type { OpenAITool } from "../../src/runners/server/openai-types.js";

const weatherTool: OpenAITool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a location, rendered verbosely with a long doc string.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City and state, e.g. San Francisco, CA" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "Temperature unit" },
      },
      required: ["location"],
    },
  },
};

describe("renderCompactToolPrompt — terse surface (prompt contract)", () => {
  const compact = renderCompactToolPrompt([weatherTool]);

  it("includes the name + a positional signature line", () => {
    expect(compact).toContain("get_weather(location:string, unit:enum{celsius|fahrenheit})");
  });

  it("does NOT include the verbose per-param descriptions", () => {
    expect(compact).not.toContain("City and state, e.g. San Francisco, CA");
    expect(compact).not.toContain("Get the current weather for a location, rendered verbosely");
  });

  it("is materially shorter than the verbose surface (the context-efficiency win)", () => {
    const verbose = renderVerboseToolPrompt([weatherTool]);
    expect(compact.length).toBeLessThan(verbose.length);
  });
});

describe("renderVerboseToolPrompt — full schema (fc contract)", () => {
  const verbose = renderVerboseToolPrompt([weatherTool]);

  it("includes the function description and per-param docs", () => {
    expect(verbose).toContain("Get the current weather for a location");
    expect(verbose).toContain("City and state, e.g. San Francisco, CA");
  });

  it("marks required vs optional and lists enum choices", () => {
    expect(verbose).toContain("[required]");
    expect(verbose).toContain("[optional]");
    expect(verbose).toContain("one of: celsius, fahrenheit");
  });
});

describe("renderToolPrompt — contract selector", () => {
  it("selects compact for prompt and verbose for fc", () => {
    expect(renderToolPrompt([weatherTool], "prompt")).toBe(renderCompactToolPrompt([weatherTool]));
    expect(renderToolPrompt([weatherTool], "fc")).toBe(renderVerboseToolPrompt([weatherTool]));
  });
});
