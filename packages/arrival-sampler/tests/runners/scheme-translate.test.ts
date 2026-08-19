// scheme-translate.test.ts — THE SUBTLE PART, tested hard. A decoded positional scheme call must become an
// OpenAI tool_call with NAMED, JSON-TYPED arguments: positional→named via the tool's JSON-Schema declaration
// order, and each value JSON-typed against its param schema (number stays number, bool stays bool, string-typed
// slot coerces, enum value-symbol → its string, list → JSON array). Multi-call decode → multiple tool_calls.

import { describe, it, expect } from "vitest";

import { parseSchemeForms } from "../../src/runners/server/scheme-parse.js";
import { schemeCallsToToolCalls, schemeCallToToolCall, makeCallIdMinter, type ToolShape } from "../../src/runners/server/scheme-translate.js";
import { toolsToGrantEnv } from "../../src/runners/server/tool-env.js";
import type { OpenAITool } from "../../src/runners/server/openai-types.js";

const weatherTool: OpenAITool = {
  type: "function",
  function: {
    name: "get_weather",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["location"],
    },
  },
};

const timerTool: OpenAITool = {
  type: "function",
  function: {
    name: "set_timer",
    parameters: {
      type: "object",
      properties: {
        minutes: { type: "integer" },
        repeat: { type: "boolean" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["minutes"],
    },
  },
};

/** Build the {@link ToolShape} from a tool set (the same source the env builder produces). */
function shapeOf(tools: readonly OpenAITool[]): ToolShape {
  const g = toolsToGrantEnv(tools);
  return { paramOrderByTool: g.paramOrderByTool, schemaByTool: g.schemaByTool };
}

describe("schemeCallToToolCall — positional → named + JSON typing", () => {
  it("maps a string + enum-symbol call to correctly NAMED string arguments", () => {
    const shape = shapeOf([weatherTool]);
    const [call] = parseSchemeForms(`(get_weather "Paris" celsius)`);
    const tc = schemeCallToToolCall(call!, shape, makeCallIdMinter());
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("get_weather");
    // arguments is a JSON STRING (OpenAI's quirk) — parse it and assert the named, typed object.
    expect(JSON.parse(tc.function.arguments)).toEqual({ location: "Paris", unit: "celsius" });
    expect(tc.id).toBe("call_0");
  });

  it("JSON-types a numeric slot as a number and a boolean slot as a boolean", () => {
    const shape = shapeOf([timerTool]);
    const [call] = parseSchemeForms(`(set_timer 5 #t)`);
    const tc = schemeCallToToolCall(call!, shape, makeCallIdMinter());
    const args = JSON.parse(tc.function.arguments);
    expect(args).toEqual({ minutes: 5, repeat: true });
    // Crucially the number is a JSON number, not the string "5", and the bool is a JSON boolean.
    expect(typeof args.minutes).toBe("number");
    expect(typeof args.repeat).toBe("boolean");
  });

  it("coerces a bare number into a STRING slot when the schema says string", () => {
    const stringySlot: OpenAITool = {
      type: "function",
      function: {
        name: "set_zip",
        parameters: { type: "object", properties: { zip: { type: "string" } }, required: ["zip"] },
      },
    };
    const shape = shapeOf([stringySlot]);
    const [call] = parseSchemeForms(`(set_zip 94107)`);
    const tc = schemeCallToToolCall(call!, shape, makeCallIdMinter());
    const args = JSON.parse(tc.function.arguments);
    expect(args).toEqual({ zip: "94107" });
    expect(typeof args.zip).toBe("string");
  });

  it("maps a (list …) argument to a JSON array, typing each element by the items schema", () => {
    const shape = shapeOf([timerTool]);
    const [call] = parseSchemeForms(`(set_timer 10 #f (list "wake" "gym"))`);
    const tc = schemeCallToToolCall(call!, shape, makeCallIdMinter());
    const args = JSON.parse(tc.function.arguments);
    expect(args).toEqual({ minutes: 10, repeat: false, labels: ["wake", "gym"] });
    expect(Array.isArray(args.labels)).toBe(true);
  });

  it("falls back to arg0, arg1, … and the atom's intrinsic type for an UNKNOWN tool (no schema)", () => {
    const shape: ToolShape = { paramOrderByTool: new Map(), schemaByTool: new Map() };
    const [call] = parseSchemeForms(`(mystery "x" 7 #t)`);
    const tc = schemeCallToToolCall(call!, shape, makeCallIdMinter());
    expect(JSON.parse(tc.function.arguments)).toEqual({ arg0: "x", arg1: 7, arg2: true });
  });
});

describe("schemeCallsToToolCalls — multi-call decode → multiple tool_calls", () => {
  it("translates several top-level forms into ordered tool_calls with distinct ids", () => {
    const shape = shapeOf([weatherTool, timerTool]);
    const calls = parseSchemeForms(`(get_weather "Tokyo" fahrenheit) (set_timer 3 #t)`);
    expect(calls).toHaveLength(2);
    const tcs = schemeCallsToToolCalls(calls, shape);
    expect(tcs).toHaveLength(2);
    expect(tcs[0]!.function.name).toBe("get_weather");
    expect(JSON.parse(tcs[0]!.function.arguments)).toEqual({ location: "Tokyo", unit: "fahrenheit" });
    expect(tcs[1]!.function.name).toBe("set_timer");
    expect(JSON.parse(tcs[1]!.function.arguments)).toEqual({ minutes: 3, repeat: true });
    // Distinct, monotonic ids.
    expect(tcs[0]!.id).toBe("call_0");
    expect(tcs[1]!.id).toBe("call_1");
  });

  it("unwraps a (begin …) sequencing wrapper into the child calls", () => {
    const shape = shapeOf([weatherTool, timerTool]);
    const calls = parseSchemeForms(`(begin (get_weather "Rome" celsius) (set_timer 1))`);
    expect(calls).toHaveLength(2);
    const tcs = schemeCallsToToolCalls(calls, shape);
    expect(tcs.map((t) => t.function.name)).toEqual(["get_weather", "set_timer"]);
  });

  it("unwraps a (list (call) (call)) parallel wrapper — the model's natural parallel shape", () => {
    // arch-1.5b emits parallel intents as `(list (f …) (g …))` rather than two top-level forms (probe-observed).
    const shape = shapeOf([weatherTool]);
    const calls = parseSchemeForms(`(list (get_weather "Paris" celsius) (get_weather "Tokyo" fahrenheit))`);
    expect(calls).toHaveLength(2);
    const tcs = schemeCallsToToolCalls(calls, shape);
    expect(tcs.map((t) => t.function.name)).toEqual(["get_weather", "get_weather"]);
    expect(JSON.parse(tcs[0]!.function.arguments)).toEqual({ location: "Paris", unit: "celsius" });
    expect(JSON.parse(tcs[1]!.function.arguments)).toEqual({ location: "Tokyo", unit: "fahrenheit" });
  });

  it("unwraps an (array (call) (call)) wrapper too", () => {
    const calls = parseSchemeForms(`(array (get_weather "Rome") (set_timer 2))`);
    expect(calls.map((c) => c.name)).toEqual(["get_weather", "set_timer"]);
  });

  it("does NOT unwrap a data list of bare atoms — (list \"a\" \"b\") stays ONE form, not two calls", () => {
    // The discriminator: a data list's body tokens are atoms, not call forms, so it is left as a single
    // (non-tool) `list` form — never split into per-element calls. (A list ARG inside a real call is unaffected.)
    const calls = parseSchemeForms(`(list "a" "b")`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("list");
  });
});
