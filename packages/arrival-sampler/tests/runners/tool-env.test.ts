// tool-env.test.ts — OpenAI tool JSON → grant Σ (OracleEnvΣ). Asserts the right names are bound with the
// right shape: each tool name is an admissible operator (callable), list-constructors are bound, enum members
// become bound value-symbols, and the per-tool positional param order is captured (the translation's source).

import { describe, it, expect } from "vitest";

import type { OpenAITool } from "../../src/runners/server/openai-types.js";
import { toolsToGrantEnv } from "../../src/runners/server/tool-env.js";

/** A representative weather tool: a free-form string `location` + an enum `unit`. */
const weatherTool: OpenAITool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a location.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City and state, e.g. San Francisco, CA" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["location"],
    },
  },
};

describe("toolsToGrantEnv", () => {
  it("binds each tool name as an admissible operator + captures its positional param order", () => {
    const { env, paramOrderByTool } = toolsToGrantEnv([weatherTool]);
    // The tool name resolves in Σ (bound as a callable — the only operator admitted at the head slot).
    expect(env.boundSymbols().has("get_weather")).toBe(true);
    // The positional param order is the JSON-Schema declaration order (the translation's source). No TS
    // signature is carried on the env now — `oracleEnvFromBindings`'s `signatureOf` is null; typed-mode narrows
    // via the lens built from the schemas, not the env (see tool-env's note).
    expect(paramOrderByTool.get("get_weather")).toEqual(["location", "unit"]);
  });

  it("binds the list/array constructors (so a list argument is the no-quote (list …) form)", () => {
    const { env } = toolsToGrantEnv([weatherTool]);
    expect(env.boundSymbols().has("list")).toBe(true);
    expect(env.boundSymbols().has("array")).toBe(true);
  });

  it("binds each closed-domain enum member as a value-symbol (so the model may name it bare)", () => {
    const { env } = toolsToGrantEnv([weatherTool]);
    // The enum unit values are bound as symbols the oracle admits at an argument slot.
    expect(env.boundSymbols().has("celsius")).toBe(true);
    expect(env.boundSymbols().has("fahrenheit")).toBe(true);
  });

  it("does NOT bind an undeclared name (Σ admits exactly the offered surface)", () => {
    const { env } = toolsToGrantEnv([weatherTool]);
    expect(env.boundSymbols().has("set_flashlight")).toBe(false);
    expect(env.boundSymbols().has("kelvin")).toBe(false);
  });

  it("captures param order + schema for MULTIPLE offered tools (the multi / parallel_multiple Σ)", () => {
    const second: OpenAITool = {
      type: "function",
      function: {
        name: "set_timer",
        parameters: {
          type: "object",
          properties: {
            minutes: { type: "integer" },
            label: { type: "string" },
          },
          required: ["minutes"],
        },
      },
    };
    const { env, paramOrderByTool, schemaByTool } = toolsToGrantEnv([weatherTool, second]);
    expect(env.boundSymbols().has("get_weather")).toBe(true);
    expect(env.boundSymbols().has("set_timer")).toBe(true);
    expect(paramOrderByTool.get("set_timer")).toEqual(["minutes", "label"]);
    expect(schemaByTool.get("set_timer")?.minutes?.type).toBe("integer");
  });

  it("handles a tool with NO parameters (empty positional order, name still bound)", () => {
    const noArgs: OpenAITool = { type: "function", function: { name: "ping" } };
    const { env, paramOrderByTool } = toolsToGrantEnv([noArgs]);
    expect(env.boundSymbols().has("ping")).toBe(true);
    expect(paramOrderByTool.get("ping")).toEqual([]);
  });
});
