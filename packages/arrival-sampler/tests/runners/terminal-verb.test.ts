// terminal-verb.test.ts — the abstain / agentic-terminal seam (RED-first).
//
// The grant Σ binds a terminal "respond" verb so the constrained decode can emit a FINAL natural-language answer
// instead of a tool call; the handler routes a terminal-verb form to the prose path (content, finish_reason
// "stop", NO tool_calls). This one move is BOTH the irrelevance/abstain fix (turn 1: emit `(respond …)` instead
// of a call) AND the thing that lets the oracle close an agentic loop (act, observe, …, then `(respond …)`).
// See terminal.ts for why the verb SET is wider than the canonical one (the probe's `(display …)` finding).

import { describe, it, expect } from "vitest";

import { handleChatCompletion, type DecodeFn } from "../../src/runners/server/handler.js";
import type { ChatCompletionRequest, OpenAITool } from "../../src/runners/server/openai-types.js";
import { renderToolPrompt } from "../../src/runners/server/prompt-render.js";
import { CANONICAL_TERMINAL_VERB, TERMINAL_VERBS } from "../../src/runners/server/terminal.js";
import { toolsToGrantEnv } from "../../src/runners/server/tool-env.js";

const weatherTool: OpenAITool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a location.",
    parameters: {
      type: "object",
      properties: { location: { type: "string" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
      required: ["location"],
    },
  },
};

const canned = (program: string): DecodeFn => () => Promise.resolve(program);
const baseReq = (over: Partial<ChatCompletionRequest>): ChatCompletionRequest => ({
  model: "m",
  messages: [{ role: "user", content: "Can you suggest a chocolate cake recipe?" }],
  tools: [weatherTool],
  ...over,
});
const opts = (decode: DecodeFn) => ({ decode, now: () => 1, mintId: () => "id" });

describe("terminal verb — grant Σ admits it", () => {
  it("binds the canonical terminal verb (respond) as an admissible operator", () => {
    const { env } = toolsToGrantEnv([weatherTool]);
    expect(env.boundSymbols().has(CANONICAL_TERMINAL_VERB)).toBe(true);
    expect(env.boundSymbols().has("respond")).toBe(true);
  });

  it("binds the whole terminal-verb idiom set (the model's natural display/print too)", () => {
    const { env } = toolsToGrantEnv([weatherTool]);
    for (const v of TERMINAL_VERBS) expect(env.boundSymbols().has(v)).toBe(true);
  });
});

describe("terminal verb — handler routes it to the prose path (the abstain / final-answer exit)", () => {
  it("(respond \"…\") → content, finish_reason stop, NO tool_calls — even with tools offered", async () => {
    const res = await handleChatCompletion(
      baseReq({ contract: "fc" }),
      opts(canned(`(respond "I can only fetch weather; I can't suggest a recipe.")`)),
    );
    const c = res.choices[0]!;
    expect(c.finish_reason).toBe("stop");
    expect(c.message.content).toBe("I can only fetch weather; I can't suggest a recipe.");
    expect(c.message.tool_calls).toBeUndefined();
  });

  it("the model's natural (display \"…\") also routes to a final answer", async () => {
    const res = await handleChatCompletion(
      baseReq({ contract: "fc" }),
      opts(canned(`(display "no function applies here")`)),
    );
    const c = res.choices[0]!;
    expect(c.finish_reason).toBe("stop");
    expect(c.message.content).toBe("no function applies here");
    expect(c.message.tool_calls).toBeUndefined();
  });

  it("a REAL tool call is unaffected — terminal routing must not swallow actual calls (regression)", async () => {
    const res = await handleChatCompletion(
      baseReq({ contract: "fc", messages: [{ role: "user", content: "weather in Paris in celsius?" }] }),
      opts(canned(`(get_weather "Paris" celsius)`)),
    );
    const c = res.choices[0]!;
    expect(c.finish_reason).toBe("tool_calls");
    expect(c.message.tool_calls).toHaveLength(1);
    expect(c.message.tool_calls![0]!.function.name).toBe("get_weather");
  });
});

describe("terminal verb — the prompt makes finishing discoverable", () => {
  it("the rendered tool surface names the canonical terminal verb", () => {
    expect(renderToolPrompt([weatherTool], "fc")).toContain(CANONICAL_TERMINAL_VERB);
    expect(renderToolPrompt([weatherTool], "prompt")).toContain(CANONICAL_TERMINAL_VERB);
  });
});
