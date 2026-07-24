// The FUSION ruling (arrival-mcp-extended-capability.md, postdating rulings), re-landed on the
// DI rework's shape: an MCP capability is an ordinary `EnvCapability` (`defineMcpCapability`
// mints one) plus a side-table catalog-text pair (`defineMcpCapability.ts`'s `mcpCapabilityMeta`)
// — no subclass, no runner-side bag. `mcpCatalogEntries` (the catalog reflection every
// DiscoveryTool.catalog() call reuses) walks a capability's dep closure and includes ONLY the
// MCP capabilities in it (`isMcpCapability`) — a plain `EnvCapability` dep still grants its
// verbs live, but stays invisible to the catalog, same posture as before.
//
// The OLD per-verb annotation-LIFTING machinery (`liftInlineAnnotations`, the `{fn}`-record
// inline-field split, the `inputSchema`-getter-preservation guard) is retired outright — a
// baked `symbol.rosetta` verb's own `input`/`inputRest` contract already validates + decodes at
// the membrane boundary, so there is no second getter to preserve un-invoked.

import { EnvCapability } from "@inhuman.tools/arrival/capability";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { defineMcpCapability, mcpCatalogEntries, resolveCapabilityDescription } from "../defineMcpCapability.js";
import { tool } from "../tool.js";

describe("mcpCatalogEntries — catalogued vs invisible internal", () => {
  it("a plain EnvCapability dep grants live verbs but stays UNDOCUMENTED to the catalog", () => {
    const plainDep = new EnvCapability("plain-internal", {
      symbols: {
        // A described verb — even so, a plain EnvCapability is never an MCP capability
        // (`isMcpCapability`), so this never reaches the catalog no matter what its
        // metadata carries.
        internalHelper: tool.pure`internal-helper: should never surface`({ shape: {} }, () => "internal"),
      },
    });
    const root = defineMcpCapability("root", {
      deps: [plainDep],
      tools: () => ({
        publicOp: tool.pure`public-op: the only catalogued verb`({ shape: {} }, () => "public"),
      }),
    });

    const names = mcpCatalogEntries(root).map((e) => e.name);
    expect(names).toContain("publicOp");
    expect(names).not.toContain("internalHelper");
  });

  it("an MCP capability dep DOES contribute to the catalog (deps-first, self-last precedence)", () => {
    const mcpDep = defineMcpCapability("mcp-dep", {
      tools: () => ({
        depOp: tool.pure`dep-op: from the dependency`({ shape: {} }, () => "dep"),
      }),
    });
    const root = defineMcpCapability("root2", {
      deps: [mcpDep],
      tools: () => ({
        rootOp: tool.pure`root-op: from the root`({ shape: {} }, () => "root"),
      }),
    });

    const names = mcpCatalogEntries(root).map((e) => e.name);
    expect(names).toContain("depOp");
    expect(names).toContain("rootOp");
  });

  it("a nearer capability's entry wins a name clash over a dep's (last-write-wins, self-last)", () => {
    const dep = defineMcpCapability("dep-clash", {
      tools: () => ({ op: tool.pure`op: dep version`({ shape: {} }, () => "dep") }),
    });
    const root = defineMcpCapability("root-clash", {
      deps: [dep],
      tools: () => ({ op: tool.pure`op: root version`({ shape: {} }, () => "root") }),
    });
    const op = mcpCatalogEntries(root).find((e) => e.name === "op");
    expect(op?.metadata.description).toBe("root version");
  });
});

describe("per-verb isTool metadata flows through the catalog", () => {
  it("a verb marked isTool: true carries the flag on its baked metadata", () => {
    const cap = defineMcpCapability("tool-flagged", {
      tools: () => ({
        exposed: tool.pure`exposed: an exposed verb`({ shape: {} }, () => "x", { isTool: true }),
        hidden: tool.pure`hidden: a declared action only`({ shape: {} }, () => "y"),
      }),
    });
    const entries = mcpCatalogEntries(cap);
    expect(entries.find((e) => e.name === "exposed")?.metadata.isTool).toBe(true);
    expect(entries.find((e) => e.name === "hidden")?.metadata.isTool).toBeUndefined();
  });
});

describe("capability-level description / dynamicDescription — the fusion's own field", () => {
  it("carries a static top-level description, resolved verbatim", async () => {
    const cap = defineMcpCapability("described", { description: "the whole capability, in one line", tools: () => ({}) });
    await expect(resolveCapabilityDescription(cap)).resolves.toBe("the whole capability, in one line");
  });

  it("resolveCapabilityDescription() prefers the dynamic arm, falling back to static on undefined resolution", async () => {
    let calls = 0;
    const cap = defineMcpCapability<{ region: z.ZodOptional<z.ZodString> }, Record<string, never>>("dynamic-cap", {
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
    // the bare capability object, so the dynamic arm itself resolves `undefined` and the
    // static sibling stands.
    await expect(resolveCapabilityDescription(cap)).resolves.toBe("static fallback");
    expect(calls).toBe(1);

    // A real activation flows through as `this`.
    const activation = { configuration: { region: "eu-west" }, resources: {} };
    await expect(resolveCapabilityDescription(cap, activation)).resolves.toBe("live for eu-west");
    expect(calls).toBe(2);
  });

  it("absent description/dynamicDescription resolves to undefined, not a throw", async () => {
    const cap = defineMcpCapability("bare", { tools: () => ({}) });
    await expect(resolveCapabilityDescription(cap)).resolves.toBeUndefined();
  });
});
