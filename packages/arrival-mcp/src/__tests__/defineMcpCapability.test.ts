// defineMcpCapability — the DI-rework authoring surface (rework-zone-guidelines.md §2): a thin
// wrapper over `EnvCapability.define`, so the RETURNED value is an ordinary `EnvCapability` — no
// more "record vs builder `symbols`" distinction to guard (the `{fn}`-record annotation-lifting
// machinery this file used to pin, `liftInlineAnnotations`, died with it: `tools` IS a builder
// callback by construction now, the same shape `EnvCapability.define`'s own `symbols` callback
// always was).
import { EnvCapability } from "@inhuman.tools/arrival/capability";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { defineMcpCapability, isMcpCapability, resolveCapabilityDescription } from "../defineMcpCapability.js";
import { tool } from "../tool.js";

describe("defineMcpCapability — the one authoring surface", () => {
  it("returns a plain EnvCapability — the tools callback runs eagerly, verbs bake through", () => {
    const cap = defineMcpCapability("greet-caps", {
      tools: () => ({
        greet: tool.pure`greet: says hi`({ shape: {} }, () => "hi"),
      }),
    });
    expect(cap).toBeInstanceOf(EnvCapability);
    expect(Object.keys(cap.spec.symbols ?? {})).toEqual(["greet"]);
  });

  it("is recognized as an MCP capability — a plain EnvCapability is not", () => {
    const mcp = defineMcpCapability("mcp-caps", { tools: () => ({}) });
    const plain = new EnvCapability("plain-caps", { symbols: {} });
    expect(isMcpCapability(mcp)).toBe(true);
    expect(isMcpCapability(plain)).toBe(false);
  });

  it("configuration threads through exactly like EnvCapability.define's own", () => {
    const cap = defineMcpCapability("configured-caps", {
      configuration: { who: z.string() },
      tools: (symbol, sz) => ({
        greet: symbol.rosetta`greet: says hi to the configured person`({ input: [], output: [sz.dynamic] }, function (): any {
          return `hi ${this.configuration.who}`;
        }),
      }),
    });
    expect(cap.spec.configuration).toBeDefined();
  });

  describe("capability-level description / dynamicDescription", () => {
    it("absent description/dynamicDescription resolves to undefined, not a throw", async () => {
      const cap = defineMcpCapability("bare-caps", { tools: () => ({}) });
      await expect(resolveCapabilityDescription(cap)).resolves.toBeUndefined();
    });

    it("carries a static description, resolved verbatim", async () => {
      const cap = defineMcpCapability("described-caps", { description: "the whole capability, in one line", tools: () => ({}) });
      await expect(resolveCapabilityDescription(cap)).resolves.toBe("the whole capability, in one line");
    });

    it("prefers the dynamic arm, falling back to static on undefined resolution", async () => {
      let calls = 0;
      const cap = defineMcpCapability("dynamic-caps", {
        configuration: { region: z.string().optional() },
        description: "static fallback",
        dynamicDescription() {
          calls += 1;
          const region = this.configuration?.region;
          return region === undefined ? undefined : `live for ${region}`;
        },
        tools: () => ({}),
      });

      // No activation supplied: receiver-free fallback — `this.configuration` is undefined on
      // the bare capability object, so the dynamic arm itself resolves `undefined`.
      await expect(resolveCapabilityDescription(cap)).resolves.toBe("static fallback");
      expect(calls).toBe(1);

      // A real activation flows through as `this`.
      const activation = { configuration: { region: "eu-west" }, resources: {} };
      await expect(resolveCapabilityDescription(cap, activation)).resolves.toBe("live for eu-west");
      expect(calls).toBe(2);
    });
  });
});
