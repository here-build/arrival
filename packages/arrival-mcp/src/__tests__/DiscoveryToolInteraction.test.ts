import { describe, it, expect, beforeEach } from "vitest";
import { DiscoveryToolInteraction } from "../DiscoveryToolInteraction";
import type { Context } from "hono";
import * as z from "zod";

// Simple test implementation
class TestDiscoveryTool extends DiscoveryToolInteraction<{ testContext: string }> {
  static readonly name = "test-discovery";
  readonly description = "Test discovery tool";

  readonly contextSchema = {
    testContext: z.string().describe("Test context value"),
  };

  protected async registerFunctions(context: { testContext: string }): Promise<void> {
    // Register a simple function that echoes the context
    this.registerFunction(
      "echo-context",
      "Returns the test context value",
      [],
      () => context.testContext
    );

    // Register a function with parameters
    this.registerFunction(
      "add-numbers",
      "Adds two numbers",
      [z.number().describe("first number"), z.number().describe("second number")],
      (a: number, b: number) => a + b
    );
  }
}

function createMockContext(): Context {
  return {
    req: {
      header: () => undefined,
    },
    get: () => undefined,
    set: () => {},
  } as any;
}

describe("DiscoveryToolInteraction", () => {
  let tool: TestDiscoveryTool;
  let mockContext: Context;

  beforeEach(() => {
    mockContext = createMockContext();
    tool = new TestDiscoveryTool(mockContext);
  });

  describe("Tool Schema", () => {
    it("should generate valid tool schema", async () => {
      const schema = await tool.getToolSchema();

      expect(schema).toBeDefined();
      expect(schema.type).toBe("object");
      expect(schema.properties).toHaveProperty("expr");
      expect(schema.properties).toHaveProperty("testContext");
      expect(schema.required).toContain("expr");
      expect(schema.required).toContain("testContext");
    });
  });

  describe("Function Registration", () => {
    it("should execute registered function without parameters", async () => {
      const result = await tool.executeTool({
        expr: "(echo-context)",
        testContext: "test-value-123",
      });

      expect(result).toBe("test-value-123");
    });

    it("should execute registered function with parameters", async () => {
      const result = await tool.executeTool({
        expr: "(add-numbers 5 3)",
        testContext: "test",
      });

      expect(result).toBe("8");
    });

    it("should handle LIPS expressions with multiple function calls", async () => {
      const result = await tool.executeTool({
        expr: "(+ (add-numbers 5 3) (add-numbers 10 2))",
        testContext: "test",
      });

      expect(result).toBe("20");
    });
  });

  describe("Available Functions", () => {
    it("should execute successfully with registered functions", async () => {
      // Trigger function registration and verify it works
      const result = await tool.executeTool({
        expr: "(add-numbers 1 1)",
        testContext: "test",
      });

      // Verify the function executed correctly
      expect(result).toBe("2");
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid function calls", async () => {
      await expect(
        tool.executeTool({
          expr: "(non-existent-function)",
          testContext: "test",
        })
      ).rejects.toThrow();
    });

    it("should handle invalid parameter types", async () => {
      await expect(
        tool.executeTool({
          expr: '(add-numbers "not-a-number" 5)',
          testContext: "test",
        })
      ).rejects.toThrow();
    });
  });

  describe("Timeout Handling", () => {
    it("should timeout long-running expressions", async () => {
      const tool = new (class extends TestDiscoveryTool {
        protected async registerFunctions(context: { testContext: string }) {
          this.registerFunction(
            "infinite-loop",
            "Never returns",
            [],
            () => {
              while (true) {
                // Infinite loop
              }
            }
          );
        }
      })(mockContext);

      await expect(
        tool.executeTool({
          expr: "(infinite-loop)",
          testContext: "test",
        })
      ).rejects.toThrow(/timeout/i);
    }, 10000); // 10s test timeout
  });
});
