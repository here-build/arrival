// render-strategies.test.ts — the interchangeable rendering seam over the shared ParsedCall shape. Parses with
// the real scheme-parse reader (the endpoint's own parser), so these prove the four surfaces against the same
// input the endpoint feeds them.

import { describe, expect, it } from "vitest";

import { parseSchemeForms } from "../../src/runners/server/scheme-parse.js";
import { RENDER_STRATEGIES, renderStrategy, type RenderContext } from "../../src/runners/server/render-strategies.js";

const ctx: RenderContext = { paramOrder: new Map([["get_weather", ["location", "unit"]]]) };

describe("render strategies", () => {
  const calls = parseSchemeForms(`(get_weather "Paris" celsius)`);

  it("scheme: write-mode, round-trips through parseSchemeForms", () => {
    const scheme = renderStrategy("scheme").render(calls);
    expect(scheme).toBe(`(get_weather "Paris" celsius)`); // string quoted, symbol bare
    // re-parse + re-render is stable (faithful)
    expect(renderStrategy("scheme").render(parseSchemeForms(scheme))).toBe(scheme);
  });

  it("python-ast: the BFCL surface, named via ctx", () => {
    expect(renderStrategy("python-ast").render(calls, ctx)).toBe(`[get_weather(location="Paris", unit="celsius")]`);
  });

  it("python-ast: positional when no param-order is given", () => {
    expect(renderStrategy("python-ast").render(calls)).toBe(`[get_weather("Paris", "celsius")]`);
  });

  it("json: named arguments object", () => {
    expect(JSON.parse(renderStrategy("json").render(calls, ctx))).toEqual([
      { name: "get_weather", arguments: { location: "Paris", unit: "celsius" } },
    ]);
  });

  it("tool-calls: OpenAI shape with stringified arguments", () => {
    const tc = JSON.parse(renderStrategy("tool-calls").render(calls, ctx)) as Array<{
      type: string;
      function: { name: string; arguments: string };
    }>;
    expect(tc[0]!.type).toBe("function");
    expect(tc[0]!.function.name).toBe("get_weather");
    expect(JSON.parse(tc[0]!.function.arguments)).toEqual({ location: "Paris", unit: "celsius" });
  });

  it("renders multiple (parallel) calls", () => {
    const two = parseSchemeForms(`(list (get_weather "Paris" celsius) (get_weather "Rome" celsius))`);
    expect(two).toHaveLength(2);
    expect(renderStrategy("python-ast").render(two, ctx)).toBe(
      `[get_weather(location="Paris", unit="celsius"), get_weather(location="Rome", unit="celsius")]`,
    );
  });

  it("exposes the four surfaces; throws on an unknown name", () => {
    expect(RENDER_STRATEGIES.map((s) => s.name)).toEqual(["scheme", "json", "python-ast", "tool-calls"]);
    expect(() => renderStrategy("nope")).toThrow(/unknown render strategy/);
  });
});
