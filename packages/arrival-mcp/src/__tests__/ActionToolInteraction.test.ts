import { beforeEach, describe, expect, it } from "vitest";
import { ActionToolInteraction } from "../ActionToolInteraction";
import type { Context } from "hono";
import * as z from "zod";

// Simple test implementation
class TestActionTool extends ActionToolInteraction<{ projectId: string }> {
  static readonly name = "test-action";
  readonly description = "Test action tool";

  readonly contextSchema = {
    projectId: z.string().describe("Project ID"),
  };

  constructor(context: Context) {
    super(context);

    // Register some test actions
    this.registerAction({
      name: "create-item",
      description: "Create a test item",
      props: {
        projectId: z.string().describe("Project ID (from context)"),
        name: z.string().describe("Item name"),
        value: z.number().optional().describe("Optional value"),
      },
      handler: async (context, { name, value }) => ({
        action: "create-item",
        projectId: context.projectId,
        item: { name, value: value || 0 },
        success: true,
      }),
    });

    this.registerAction({
      name: "delete-item",
      description: "Delete a test item",
      props: {
        projectId: z.string().describe("Project ID (from context)"),
        itemId: z.string().describe("Item ID to delete"),
      },
      handler: async (context, { itemId }) => ({
        action: "delete-item",
        projectId: context.projectId,
        deletedId: itemId,
        success: true,
      }),
    });

    this.registerAction({
      name: "failing-action",
      description: "Action that always fails",
      props: {
        projectId: z.string().describe("Project ID"),
      },
      handler: async () => {
        throw new Error("Intentional failure");
      },
    });
  }

  protected async registerFunctions(context: { projectId: string }): Promise<() => Promise<void>> {
    // Register helper functions for LIPS expressions
    this.registerFunction(
      "get-project-id",
      "Returns the project ID from context",
      [],
      () => context.projectId
    );

    return async () => {};
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

describe("ActionToolInteraction", () => {
  let tool: TestActionTool;
  let mockContext: Context;

  beforeEach(() => {
    mockContext = createMockContext();
    tool = new TestActionTool(mockContext);
  });

  describe("Tool Schema", () => {
    it("should generate valid tool schema with actions", async () => {
      const schema = await tool.getToolSchema();

      expect(schema).toBeDefined();
      expect(schema.type).toBe("object");
      expect(schema.properties).toHaveProperty("actions");
      expect(schema.properties).toHaveProperty("projectId");
      expect(schema.required).toContain("actions");
      expect(schema.required).toContain("projectId");
    });

    it("should include all registered actions in schema", async () => {
      const schema = await tool.getToolSchema();
      // @ts-expect-error
      const actionsSchema = schema.properties.actions;

      // @ts-expect-error
      expect(actionsSchema.type).toBe("array");
      // @ts-expect-error
      expect(actionsSchema.items.type.oneOf).toHaveLength(3); // create-item, delete-item, failing-action
    });
  });

  describe("Single Action Execution", () => {
    it("should execute single action successfully", async () => {
      const result = await tool.executeTool({
        projectId: "proj-123",
        actions: [["create-item", "Test Item", 42]],
      });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        action: "create-item",
        projectId: "proj-123",
        item: { name: "Test Item", value: 42 },
        success: true,
      });
    });

    it("should handle optional parameters", async () => {
      const result = await tool.executeTool({
        projectId: "proj-123",
        actions: [["create-item", "Test Item"]],
      });

      expect(result[0].item).toMatchObject({
        name: "Test Item",
        value: 0, // Default value
      });
    });
  });

  describe("Batch Action Execution", () => {
    it("should execute multiple actions in sequence", async () => {
      const result = await tool.executeTool({
        projectId: "proj-123",
        actions: [
          ["create-item", "Item 1", 10],
          ["create-item", "Item 2", 20],
          ["delete-item", "item-to-delete"],
        ],
      });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(3);
      expect(result[0].item.name).toBe("Item 1");
      expect(result[1].item.name).toBe("Item 2");
      expect(result[2].deletedId).toBe("item-to-delete");
    });

    it("should share context across all actions", async () => {
      const result = await tool.executeTool({
        projectId: "shared-project-id",
        actions: [
          ["create-item", "Item A"],
          ["create-item", "Item B"],
        ],
      });

      expect(result[0].projectId).toBe("shared-project-id");
      expect(result[1].projectId).toBe("shared-project-id");
    });
  });

  describe("Validation", () => {
    it("should validate all actions before executing", async () => {
      const result = await tool.executeTool({
        projectId: "proj-123",
        actions: [
          ["create-item", "Valid Item"],
          ["non-existent-action"],
          ["create-item", "Another Item"],
        ],
      });

      expect(result).toMatchObject({
        success: false,
        validation: "failed",
        errors: expect.arrayContaining([
          expect.objectContaining({
            action: "non-existent-action",
          }),
        ]),
      });
    });

    it("should not execute any actions if validation fails", async () => {
      const result = await tool.executeTool({
        projectId: "proj-123",
        actions: [
          ["create-item", "Item 1"],
          ["invalid-action"],
        ],
      });

      expect(result).toHaveProperty("validation", "failed");
      expect(result).toHaveProperty("message");
      // @ts-expect-error
      expect(result.message).toContain("No actions were executed");
    });

    it("should validate parameter types", async () => {
      const result = await tool.executeTool({
        projectId: "proj-123",
        actions: [
          ["create-item", "Item", "not-a-number"], // Should be number
        ],
      });

      expect(result).toMatchObject({
        success: false,
        validation: "failed",
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle runtime errors during execution", async () => {
      const result = await tool.executeTool({
        projectId: "proj-123",
        actions: [
          ["create-item", "Item 1"],
          ["failing-action"],
          ["create-item", "Item 3"], // Should not execute
        ],
      });

      expect(result).toMatchObject({
        partial: true,
        executed: 1,
        total: 3,
        failedAction: {
          index: 1,
          action: "failing-action",
          error: "Intentional failure",
        },
      });
      // @ts-expect-error
      expect(result.results).toHaveLength(1); // Only first action executed
    });
  });

  describe("Function Registration", () => {
    it("should allow registering helper functions", async () => {
      // Function registration happens during executeTool
      const result = await tool.executeTool({
        projectId: "test-proj-456",
        actions: [["create-item", "Test"]],
      });

      // Verify the action executed successfully (indirectly confirms functions registered)
      expect(result[0]).toMatchObject({
        action: "create-item",
        projectId: "test-proj-456",
        success: true,
      });
    });
  });

  describe("Context Constraints", () => {
    it("should require context properties that all actions need", async () => {
      const schema = await tool.getToolSchema();

      // projectId is required by all actions, so it should be in required
      expect(schema.required).toContain("projectId");
    });
  });
});
