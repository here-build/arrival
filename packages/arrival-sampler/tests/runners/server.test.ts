// server.test.ts — the HTTP shell over a real loopback socket, decode MOCKED. Asserts the two endpoints speak
// OpenAI wire: POST /v1/chat/completions returns a tool_calls response (fc) a real client would accept, and
// GET /v1/models lists the roster. No model, no GPU — the decode seam returns a canned scheme string.

import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it, expect } from "vitest";

import { createOpenAIServer } from "../../src/runners/server/server.js";
import type { DecodeFn } from "../../src/runners/server/handler.js";
import type { ChatCompletionResponse, ModelsResponse, OpenAITool } from "../../src/runners/server/openai-types.js";

const weatherTool: OpenAITool = {
  type: "function",
  function: {
    name: "get_weather",
    parameters: {
      type: "object",
      properties: { location: { type: "string" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
      required: ["location"],
    },
  },
};

let baseUrl = "";
let close: () => Promise<void>;

beforeEach(async () => {
  const decode: DecodeFn = () => Promise.resolve(`(get_weather "Paris" celsius)`);
  const server = createOpenAIServer({ decode, defaultModel: "Arch-Agent-1.5B" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await close();
});

describe("POST /v1/chat/completions", () => {
  it("returns an OpenAI tool_calls response (fc contract)", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "Arch-Agent-1.5B",
        messages: [{ role: "user", content: "Weather in Paris?" }],
        tools: [weatherTool],
        contract: "fc",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatCompletionResponse;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
    const tc = body.choices[0]!.message.tool_calls![0]!;
    expect(tc.function.name).toBe("get_weather");
    expect(JSON.parse(tc.function.arguments)).toEqual({ location: "Paris", unit: "celsius" });
  });

  it("returns text content (prompt contract)", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "Arch-Agent-1.5B",
        messages: [{ role: "user", content: "Weather in Paris?" }],
        tools: [weatherTool],
        contract: "prompt",
      }),
    });
    const body = (await res.json()) as ChatCompletionResponse;
    expect(body.choices[0]!.finish_reason).toBe("stop");
    expect(body.choices[0]!.message.content).toBe(`(get_weather "Paris" celsius)`);
  });

  it("applies the server default model when the request omits one", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Weather?" }], tools: [weatherTool] }),
    });
    const body = (await res.json()) as ChatCompletionResponse;
    expect(body.model).toBe("Arch-Agent-1.5B");
  });

  it("400s on invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/models", () => {
  it("lists the roster ids in OpenAI list shape", async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsResponse;
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((m) => m.id === "Arch-Agent-1.5B")).toBe(true);
    expect(body.data[0]!.object).toBe("model");
  });
});

describe("unknown route", () => {
  it("404s", async () => {
    const res = await fetch(`${baseUrl}/v1/nope`);
    expect(res.status).toBe(404);
  });
});
