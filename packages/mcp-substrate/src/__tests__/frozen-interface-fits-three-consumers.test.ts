// Phase 0 exit criterion: the frozen interface must typecheck against THREE shapes — the real
// binder (arrival-manifold), the runner's own internals, and an arrival-mcp-shaped skeleton
// (Fable's addition — proves the third consumer's fit at design time, not discovered later).
// This is a compile-time check; the `it()` bodies are trivial, the VALUE is that the file
// typechecks at all under `tsc`/`vitest`.

import { describe, expect, it } from "vitest";

import type { BoundTool } from "../bound-tool.js";
import { type CalibrationOptions, DEFAULT_CALIBRATION } from "../calibration.js";
import { type AsyncSessionStore, createInMemorySessionStore } from "../session-store.js";
import type { DoorStrategies } from "../strategies.js";
import { type JsonSchemaProperty, type ToolJsonSchema, type ToolSignature, orderedFields } from "../tool-schema.js";

describe("frozen interface fits 3 consumer shapes", () => {
  it("fits manifold's binder shape (kwargs, ManifoldEnv's 4 real fields + toolSchemasForEnv)", () => {
    // Mirrors bind.ts's actual returned `ManifoldEnv`: signatures[], signatureByName,
    // bypassResolution (keyed by bare-name forms — stays binder-only), toolParts
    // ({slug, tool} — becomes BoundTool's identity fields).
    const toolParts = new Map<string, { slug: string; tool: string }>([
      ["github/search", { slug: "github", tool: "search" }],
    ]);
    const signatureByName = new Map<string, string>([["github/search", "(github/search :query string) - search"]]);

    const schema: ToolJsonSchema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
    const fields = orderedFields(schema);
    expect(fields).toHaveLength(1);

    const bound: BoundTool = {
      qualifiedName: "github/search",
      slug: toolParts.get("github/search")!.slug,
      tool: toolParts.get("github/search")!.tool,
      schema,
      signature: (): ToolSignature => ({
        params: fields.map((f) => ({ name: f.name, optional: f.optional, typeToken: "string", schema: f.prop })),
        signatureText: signatureByName.get("github/search")!,
      }),
    };
    const registry: ReadonlyMap<string, BoundTool> = new Map([[bound.qualifiedName, bound]]);
    expect(registry.get("github/search")?.signature().signatureText).toContain("github/search");
  });

  it("fits the runner's own internals (calibration overrides, session store round-trip)", async () => {
    const calibration: CalibrationOptions = { ...DEFAULT_CALIBRATION, futilityRingSize: 20 };
    expect(calibration.futilityRingSize).toBe(20);

    const store: AsyncSessionStore = createInMemorySessionStore();
    await store.set("session-1", JSON.stringify({ history: [] }));
    const restored = await store.get("session-1");
    expect(restored).toBeDefined();
  });

  it("fits an arrival-mcp-shaped skeleton (positional zod-tuple tool, no kwargs)", () => {
    // Mirrors McpEnvCapability.allAnnotations()'s shape: one annotation per bound native verb,
    // no qualifiedName-keyed side tables at all (DiscoveryTool builds a fresh env per call —
    // no bypass-resolution concept, no toolParts map to consult).
    const schema: JsonSchemaProperty = { type: "number" };
    const positionalSchema: ToolJsonSchema = { type: "object", properties: { count: schema }, required: ["count"] };

    const bound: BoundTool = {
      qualifiedName: "roll-dice",
      slug: "native",
      tool: "roll-dice",
      description: "Roll N dice",
      schema: positionalSchema,
      signature: (): ToolSignature => ({
        params: orderedFields(positionalSchema).map((f) => ({
          name: f.name,
          optional: f.optional,
          typeToken: "number",
          schema: f.prop,
        })),
        // A positional renderer produces a DIFFERENT signatureText shape than kwargs' `:key
        // value` — proving the renderer is pluggable, not hardcoded to one syntax.
        signatureText: "(roll-dice count: number)",
      }),
    };
    expect(bound.signature().signatureText).not.toContain(":count");

    // A positional-tuple `isMisuseError` strategy would key on z.tuple().parse()'s error text
    // instead of the kwargs-specific TOOL_MISUSE_SHAPES family — proves the strategy slot, not
    // the kwargs default, is what a second consumer plugs in.
    const strategies: DoorStrategies = {
      isMisuseError: (message) => message.startsWith("Invalid input: expected"),
      synthesizeExample: (qualifiedName) => `(${qualifiedName} 3)`,
      renderRetryExpr: (qualifiedName, args) => `(${qualifiedName} ${Object.values(args ?? {}).join(" ")})`,
    };
    expect(strategies.isMisuseError("Invalid input: expected number, received string")).toBe(true);
  });
});
