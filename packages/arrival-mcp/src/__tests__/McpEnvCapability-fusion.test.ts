// McpEnvCapability — the FUSION ruling (arrival-mcp-extended-capability.md, postdating
// rulings): `McpEnvCapability extends EnvCapability` houses BOTH the capability spec AND the
// MCP surface (capability-level `description`/`dynamicDescription`, per-verb `isTool`). One
// entity; `instanceof McpEnvCapability` = catalogued, a plain `EnvCapability` dep = invisible
// internal — no side bag handed to the runner.

import { EnvCapability } from "@inhuman.tools/arrival/capability";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { McpEnvCapability } from "../McpEnvCapability.js";
import { tool } from "../tool.js";

describe("instanceof McpEnvCapability — catalogued vs invisible internal", () => {
  it("a plain EnvCapability dep grants live verbs but stays UNDOCUMENTED to the catalog", () => {
    const plainDep = new EnvCapability("plain-internal", {
      symbols: {
        // A described verb — even so, a plain EnvCapability is never inspected by
        // `allAnnotationEntries` (the `instanceof` gate), so this never reaches the
        // catalog no matter what its metadata carries.
        internalHelper: tool.pure`internal-helper: should never surface`({ shape: {} }, () => "internal"),
      },
    });
    const root = new McpEnvCapability("root", {
      deps: [plainDep],
      symbols: {
        publicOp: tool.pure`public-op: the only catalogued verb`({ shape: {} }, () => "public"),
      },
    });

    const names = Object.keys(root.allAnnotations());
    expect(names).toContain("publicOp");
    expect(names).not.toContain("internalHelper");
  });

  it("an McpEnvCapability dep DOES contribute to the catalog (deps-first, self-last precedence)", () => {
    const mcpDep = new McpEnvCapability("mcp-dep", {
      symbols: {
        depOp: tool.pure`dep-op: from the dependency`({ shape: {} }, () => "dep"),
      },
    });
    const root = new McpEnvCapability("root2", {
      deps: [mcpDep],
      symbols: {
        rootOp: tool.pure`root-op: from the root`({ shape: {} }, () => "root"),
      },
    });

    const names = Object.keys(root.allAnnotations());
    expect(names).toContain("depOp");
    expect(names).toContain("rootOp");
  });

  it("a nearer capability's entry wins a name clash over a dep's (last-write-wins, self-last)", () => {
    const dep = new McpEnvCapability("dep-clash", {
      symbols: { op: tool.pure`op: dep version`({ shape: {} }, () => "dep") },
    });
    const root = new McpEnvCapability("root-clash", {
      deps: [dep],
      symbols: { op: tool.pure`op: root version`({ shape: {} }, () => "root") },
    });
    expect(root.allAnnotations().op?.description).toBe("root version");
  });
});

describe("per-verb isTool metadata flows through the catalog (§2.5 exposure taxonomy)", () => {
  it("a verb marked isTool: true carries the flag on its lifted annotation", () => {
    const cap = new McpEnvCapability("tool-flagged", {
      symbols: {
        exposed: tool.pure`exposed: an exposed verb`({ shape: {} }, () => "x", { isTool: true }),
        hidden: tool.pure`hidden: a declared action only`({ shape: {} }, () => "y"),
      },
    });
    expect(cap.allAnnotations().exposed?.isTool).toBe(true);
    expect(cap.allAnnotations().hidden?.isTool).toBeUndefined();
  });
});

describe("capability-level description / dynamicDescription (CAP_DESCRIPTION / CAP_DYNAMIC_DESCRIPTION) — the fusion's own field", () => {
  it("carries a static top-level description as an instance field", () => {
    const cap = new McpEnvCapability("described", { description: "the whole capability, in one line" });
    expect(cap.description).toBe("the whole capability, in one line");
  });

  it("resolveDescription() returns the static description when no dynamic arm is declared", async () => {
    const cap = new McpEnvCapability("static-only", { description: "static text" });
    await expect(cap.resolveDescription()).resolves.toBe("static text");
  });

  it("resolveDescription() prefers the dynamic arm, falling back to static on undefined resolution", async () => {
    let calls = 0;
    const cap = new McpEnvCapability<{ region: z.ZodOptional<z.ZodString> }, never>("dynamic-cap", {
      configuration: { region: z.string().optional() },
      description: "static fallback",
      dynamicDescription() {
        calls += 1;
        const region = this.configuration?.region;
        return region === undefined ? undefined : `live for ${region}`;
      },
    });

    // No activation supplied: receiver-free fallback (byte-compatible legacy posture) —
    // `this.configuration` is undefined on the bare capability instance, so the dynamic arm
    // itself resolves `undefined` and the static sibling stands.
    await expect(cap.resolveDescription()).resolves.toBe("static fallback");
    expect(calls).toBe(1);

    // A real activation (as `lower()` would build) flows through as `this`.
    const activation = { configuration: { region: "eu-west" }, resources: {}, degradation: { active: false } };
    await expect(cap.resolveDescription(activation as never)).resolves.toBe("live for eu-west");
    expect(calls).toBe(2);
  });

  it("absent description/dynamicDescription resolves to undefined, not a throw", async () => {
    const cap = new McpEnvCapability("bare", {});
    await expect(cap.resolveDescription()).resolves.toBeUndefined();
  });
});

describe("annotation lifting preserves getters un-invoked (the projectDiscovery regression)", () => {
  // An `inputSchema` GETTER reads `this.resources` — legal per the McpAnnotation doc: it is
  // resolved via `Reflect.get(annotation, "inputSchema", activation)` at CALL time. Lifting
  // must therefore never [[Get]] the property while building the annotation bag (a spread
  // does), or the getter fires with `this` = the fresh bag, where `resources` is undefined.
  it("an inline inputSchema getter survives construction without firing", () => {
    let fired = 0;
    let receiver: unknown;
    const cap = new McpEnvCapability("lazy-schema", {
      symbols: {
        probe: {
          fn: () => "x",
          description: "getter-guarded verb",
          get inputSchema(): readonly z.ZodType[] {
            // Mirrors projectDiscovery: the getter is lazy precisely because it dereferences
            // live resources — firing it before activation exists is the regression.
            fired++;
            receiver = this;
            return [z.string()];
          },
        },
      },
    });
    expect(fired).toBe(0); // construction lifted the getter as a DESCRIPTOR, never a value read
    const annotation = cap.allAnnotations()["probe"]!;
    expect(fired).toBe(0); // enumerating annotations still must not fire it
    const activation = { resources: { db: { live: "armed" } } };
    const schemas = Reflect.get(annotation, "inputSchema", activation) as readonly z.ZodType[];
    expect(fired).toBe(1); // resolve-time invocation only
    expect(receiver).toBe(activation); // and with the ACTIVATION as `this`, not the lifted bag
    expect(schemas).toHaveLength(1);
  });

  it("an explicit-record getter survives the same way", () => {
    let fired = 0;
    const cap = new McpEnvCapability("lazy-explicit", {
      symbols: {
        probe: { fn: () => "x", description: "d" },
      },
      annotations: {
        probe: {
          description: "d",
          get inputSchema(): readonly z.ZodType[] {
            fired++;
            return [z.string()];
          },
        },
      },
    });
    expect(fired).toBe(0);
    void cap.allAnnotations();
    expect(fired).toBe(0);
  });
});
