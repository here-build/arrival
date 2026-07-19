import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TypeScriptIntelTool, TypeScriptLSPServer } from "./index.js";
import { toSExprString } from "@inhuman.tools/arrival-serializer";
import * as fs from "fs";
import * as path from "path";

describe("TypeScript LSP MCP Server Integration", () => {
  let tool: TypeScriptIntelTool;
  let server: TypeScriptLSPServer;

  const testDir = path.join(__dirname, "../test-fixtures");
  const testFile = path.join(testDir, "test-file.ts");

  const testContent = `interface User {
  id: number;
  name: string;
}

class UserService {
  private users: User[] = [];
  
  addUser(user: User): void {
    this.users.push(user);
  }
  
  findUser(id: number): User | undefined {
    return this.users.find(u => u.id === id);
  }
}

const service = new UserService();
const testUser: User = { id: 1, name: "Test" };
service.addUser(testUser);`;

  beforeAll(() => {
    // Create test directory and file
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    fs.writeFileSync(testFile, testContent);

    // Create a simple tsconfig.json for the test directory
    const tsconfig = {
      compilerOptions: {
        target: "es2022",
        module: "commonjs",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true
      }
    };
    fs.writeFileSync(path.join(testDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    tool = new TypeScriptIntelTool();
    server = new TypeScriptLSPServer(tool);
  });

  afterAll(() => {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Tool Registration", () => {
    it("should describe typescript-intel tool (McpTool contract)", async () => {
      const listed = await tool.describe();

      expect(listed.name).toBe("typescript-intel");
      expect(listed.inputSchema).toBeDefined();
      expect(listed.inputSchema.type).toBe("object");
      expect((listed.inputSchema as { properties?: { action?: unknown } }).properties?.action).toBeDefined();
      // Server shell holds the same tool instance
      expect(server.tool).toBe(tool);
    });
  });

  describe("Position-based Actions", () => {
    it("should handle hover with selector", async () => {
      const result = await tool.execute({
        action: "hover",
        filePath: testFile,
        selector: "const service### = new"
      });

      const sexpr = toSExprString(result);
      expect(sexpr).toContain("(HoverInfoImpl");
      expect(sexpr).toContain("const service: UserService");
    });

    it("should handle definition with occurrence selector", async () => {
      const result = await tool.execute({
        action: "definition",
        filePath: testFile,
        selector: "User#2" // Second occurrence in UserService class
      });

      const sexpr = toSExprString(result);
      expect(sexpr).toContain("(list");
      // Definition results use class name or symbol name as first element
      expect(sexpr).toContain(":kind");
    });

    it("should handle references", async () => {
      const result = await tool.execute({
        action: "references",
        filePath: testFile,
        selector: "add###User(user"
      });

      const sexpr = toSExprString(result);
      expect(sexpr).toContain("(list");
      expect(sexpr).toContain("(ReferenceImpl");
      expect(sexpr).toContain(":line");
      expect(sexpr).toContain(":char");
    });

    it("should handle deprecated line/character format", async () => {
      const result = await tool.execute({
        action: "hover",
        filePath: testFile,
        line: 18,
        character: 6
      });

      const sexpr = toSExprString(result);
      expect(sexpr).toContain("(HoverInfoImpl");
    });
  });

  describe("File-based Actions", () => {
    it("should handle diagnostics", async () => {
      const result = await tool.execute({
        action: "diagnostics",
        filePath: testFile
      });

      const sexpr = toSExprString(result);
      // Should be empty list for valid code
      expect(sexpr).toBe("(list)");
    });

    it("should handle diagnostics with errors", async () => {
      const errorFile = path.join(testDir, "error.ts");
      fs.writeFileSync(errorFile, `
const x: number = "not a number";
const y: string = 42;
`);

      const result = await tool.execute({
        action: "diagnostics",
        filePath: errorFile,
        severity: "error"
      });

      const sexpr = toSExprString(result);
      expect(sexpr).toContain("(list");
      expect(sexpr).toContain("(DiagnosticImpl");
      expect(sexpr).toContain("error");
      expect(sexpr).toContain("Type 'string' is not assignable to type 'number'");
    });

    it("should handle document symbols", async () => {
      const result = await tool.execute({
        action: "symbols",
        filePath: testFile
      });

      const sexpr = toSExprString(result);
      expect(sexpr).toContain("(list");
      // Symbols are returned with their name as the first element
      expect(sexpr).toContain(":expression symbol");
      expect(sexpr).toContain("User");
      expect(sexpr).toContain("UserService");
      expect(sexpr).toContain("addUser");
    });
  });

  describe("Search Actions", () => {
    it("should handle symbol search", async () => {
      const result = await tool.execute({
        action: "search-symbol",
        projectRoot: testDir,
        query: "User"
      });

      const sexpr = toSExprString(result);
      expect(sexpr).toContain("(list");
      expect(sexpr).toContain(":expression symbol");
      expect(sexpr).toContain("User");
    }, 60000); // Increase timeout for search

    it("should handle symbol search with kind filter", async () => {
      const result = await tool.execute({
        action: "search-symbol",
        projectRoot: testDir,
        query: "User",
        kind: "class"
      });

      const sexpr = toSExprString(result);
      // Should only find UserService class, not User interface
      expect(sexpr).toContain("UserService");
      expect(sexpr).not.toContain(":kind interface");
    }, 60000); // Increase timeout for search
  });

  describe("Error Handling", () => {
    it("should handle unknown action", async () => {
      try {
        await tool.execute({ action: "not-a-real-action" });
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Unknown action");
      }
    });

    it("should handle missing required parameters", async () => {
      try {
        await tool.execute({
          action: "hover"
          // Missing filePath
        });
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("requires filePath");
      }
    });

    it("should handle invalid selector", async () => {
      try {
        await tool.execute({
          action: "hover",
          filePath: testFile,
          selector: "nonexistent### code"
        });
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Could not find text");
      }
    });

    it("should handle file not found", async () => {
      try {
        await tool.execute({
          action: "hover",
          filePath: "/nonexistent/file.ts",
          selector: "const x###"
        });
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe("S-Expression Format", () => {
    it("should format hover info correctly", async () => {
      const result = await tool.execute({
        action: "hover",
        filePath: testFile,
        selector: "interface User### {"
      });

      const sexpr = toSExprString(result);
      // Check s-expression structure - HoverInfoImpl is the class name
      expect(sexpr).toMatch(/^\(HoverInfoImpl/);
      expect(sexpr).toContain("interface User");
      expect(sexpr.split("\n").length).toBeGreaterThanOrEqual(1);
    });

    it("should handle nested s-expressions", async () => {
      const result = await tool.execute({
        action: "symbols",
        filePath: testFile
      });

      const sexpr = toSExprString(result);
      // Check for nested structure with parent relationships
      expect(sexpr).toContain(":parent");
      // Symbols have :parent pointing to their containing symbol
      expect(sexpr).toContain(":parent User");
    });

    it("call() returns s-expression text for registerTools serialization", async () => {
      const text = await tool.call({
        action: "hover",
        filePath: testFile,
        selector: "const service### = new"
      });
      expect(typeof text).toBe("string");
      expect(text).toContain("(HoverInfoImpl");
    });
  });
});
