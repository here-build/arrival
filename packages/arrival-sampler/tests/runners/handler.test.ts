// handler.test.ts — the request→response CORE end-to-end, with the decode MOCKED (a canned scheme string). No
// model, no GPU. Asserts the two contracts produce the right OpenAI response shape, the prose seam works, and
// the grant Σ + rendered prompt reach the decode correctly.

import { describe, it, expect } from "vitest";

import { handleChatCompletion, type DecodeArgs, type DecodeFn } from "../../src/runners/server/handler.js";
import type { ChatCompletionRequest, OpenAITool } from "../../src/runners/server/openai-types.js";

const weatherTool: OpenAITool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a location.",
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

/** A canned decode that returns a fixed program and records what it was asked (so we can assert the Σ + prompt). */
function cannedDecode(program: string): { decode: DecodeFn; seen: { args?: DecodeArgs } } {
  const seen: { args?: DecodeArgs } = {};
  const decode: DecodeFn = (args) => {
    seen.args = args;
    return Promise.resolve(program);
  };
  return { decode, seen };
}

const baseReq = (over: Partial<ChatCompletionRequest>): ChatCompletionRequest => ({
  model: "Arch-Agent-1.5B",
  messages: [{ role: "user", content: "What's the weather in Paris in celsius?" }],
  tools: [weatherTool],
  ...over,
});

const fixedOpts = (decode: DecodeFn) => ({ decode, now: () => 1_700_000_000, mintId: () => "chatcmpl-test" });

describe("handleChatCompletion — FC contract (default)", () => {
  it("translates the decoded scheme call into OpenAI tool_calls with finish_reason tool_calls", async () => {
    const { decode } = cannedDecode(`(get_weather "Paris" celsius)`);
    const res = await handleChatCompletion(baseReq({ contract: "fc" }), fixedOpts(decode));

    expect(res.object).toBe("chat.completion");
    expect(res.model).toBe("Arch-Agent-1.5B");
    const choice = res.choices[0]!;
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls).toHaveLength(1);
    const tc = choice.message.tool_calls![0]!;
    expect(tc.function.name).toBe("get_weather");
    expect(JSON.parse(tc.function.arguments)).toEqual({ location: "Paris", unit: "celsius" });
  });

  it("defaults to FC when no contract is set", async () => {
    const { decode } = cannedDecode(`(get_weather "Paris" celsius)`);
    const res = await handleChatCompletion(baseReq({}), fixedOpts(decode));
    expect(res.choices[0]!.finish_reason).toBe("tool_calls");
    expect(res.choices[0]!.message.tool_calls).toHaveLength(1);
  });

  it("emits MULTIPLE tool_calls for a multi-call decode", async () => {
    const timerTool: OpenAITool = {
      type: "function",
      function: {
        name: "set_timer",
        parameters: { type: "object", properties: { minutes: { type: "integer" } }, required: ["minutes"] },
      },
    };
    const { decode } = cannedDecode(`(get_weather "Tokyo" fahrenheit) (set_timer 5)`);
    const res = await handleChatCompletion(
      baseReq({ tools: [weatherTool, timerTool], contract: "fc" }),
      fixedOpts(decode),
    );
    const tcs = res.choices[0]!.message.tool_calls!;
    expect(tcs).toHaveLength(2);
    expect(tcs.map((t) => t.function.name)).toEqual(["get_weather", "set_timer"]);
    expect(JSON.parse(tcs[1]!.function.arguments)).toEqual({ minutes: 5 });
  });

  it("feeds the VERBOSE tool surface + grant Σ to the decode", async () => {
    const { decode, seen } = cannedDecode(`(get_weather "Paris" celsius)`);
    await handleChatCompletion(baseReq({ contract: "fc" }), fixedOpts(decode));
    // Verbose surface: the param description must be present (the fc surface is the rich one).
    expect(seen.args!.systemPrompt).toContain("PARAMETERS:");
    // Σ: the grant env admits the tool name.
    expect(seen.args!.grantEnv.boundSymbols().has("get_weather")).toBe(true);
    expect(seen.args!.userPrompt).toContain("Paris");
  });
});

describe("handleChatCompletion — prompt contract", () => {
  it("returns the call AS TEXT in content, finish_reason stop, NO tool_calls", async () => {
    const { decode } = cannedDecode(`(get_weather "Paris" celsius)`);
    const res = await handleChatCompletion(baseReq({ contract: "prompt" }), fixedOpts(decode));
    const choice = res.choices[0]!;
    expect(choice.finish_reason).toBe("stop");
    expect(choice.message.content).toBe(`(get_weather "Paris" celsius)`);
    expect(choice.message.tool_calls).toBeUndefined();
  });

  it("feeds the COMPACT tool surface to the decode (terse, no per-param descriptions)", async () => {
    const { decode, seen } = cannedDecode(`(get_weather "Paris" celsius)`);
    await handleChatCompletion(baseReq({ contract: "prompt" }), fixedOpts(decode));
    // Compact surface omits the verbose PARAMETERS block — it's a one-line signature.
    expect(seen.args!.systemPrompt).not.toContain("PARAMETERS:");
    expect(seen.args!.systemPrompt).toContain("get_weather(location:string, unit:enum{celsius|fahrenheit})");
  });
});

describe("handleChatCompletion — prose / no-call seam", () => {
  it("returns a plain assistant text message when NO tools are offered", async () => {
    const { decode } = cannedDecode(`(get_weather "Paris" celsius)`);
    const res = await handleChatCompletion(baseReq({ tools: [] }), fixedOpts(decode));
    const choice = res.choices[0]!;
    expect(choice.finish_reason).toBe("stop");
    expect(choice.message.tool_calls).toBeUndefined();
    expect(typeof choice.message.content).toBe("string");
  });

  it("returns prose when the decode produces no parseable call", async () => {
    const { decode } = cannedDecode(`I cannot help with that.`);
    const res = await handleChatCompletion(baseReq({ contract: "fc" }), fixedOpts(decode));
    const choice = res.choices[0]!;
    expect(choice.finish_reason).toBe("stop");
    expect(choice.message.content).toBe("I cannot help with that.");
    expect(choice.message.tool_calls).toBeUndefined();
  });

  it("a truncated terminal form does NOT leak its scheme opener into content", async () => {
    // `(respond "partial answer` is unbalanced → unparseable → prose fallback. The `(respond "` must be stripped.
    const { decode } = cannedDecode(`(respond "partial answer`);
    const res = await handleChatCompletion(baseReq({ contract: "fc" }), fixedOpts(decode));
    const choice = res.choices[0]!;
    expect(choice.finish_reason).toBe("stop");
    expect(choice.message.content).toBe("partial answer");
    expect(choice.message.content).not.toContain("(respond");
  });
});

describe("handleChatCompletion — render override (the serialization seam)", () => {
  it("render: python-ast returns the BFCL surface as content (no tool_calls)", async () => {
    const { decode } = cannedDecode(`(get_weather "Paris" celsius)`);
    const res = await handleChatCompletion(baseReq({ render: "python-ast" }), fixedOpts(decode));
    const choice = res.choices[0]!;
    expect(choice.finish_reason).toBe("stop");
    expect(choice.message.content).toBe(`[get_weather(location="Paris", unit="celsius")]`);
    expect(choice.message.tool_calls).toBeUndefined();
  });

  it("render: scheme returns write-mode scheme as content", async () => {
    const { decode } = cannedDecode(`(get_weather "Paris" celsius)`);
    const res = await handleChatCompletion(baseReq({ render: "scheme" }), fixedOpts(decode));
    expect(res.choices[0]!.message.content).toBe(`(get_weather "Paris" celsius)`);
  });

  it("render: tool-calls (explicit) is byte-identical to the default structured FC response", async () => {
    const { decode } = cannedDecode(`(get_weather "Paris" celsius)`);
    const res = await handleChatCompletion(baseReq({ render: "tool-calls" }), fixedOpts(decode));
    const choice = res.choices[0]!;
    expect(choice.finish_reason).toBe("tool_calls");
    const tc = choice.message.tool_calls![0]!;
    expect(tc.function.name).toBe("get_weather");
    expect(JSON.parse(tc.function.arguments)).toEqual({ location: "Paris", unit: "celsius" });
  });
});
