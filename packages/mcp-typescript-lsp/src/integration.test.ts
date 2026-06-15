import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TypeScriptLSPServer } from "./index";
import { toSExprString } from "@here.build/arrival";
import * as fs from "fs";
import * as path from "path";

describe("TypeScript LSP MCP Server Integration", () => {
  let server: TypeScriptLSPServer;
  let handleToolCall: (name: string, args: any) => Promise<any>;
  let getTools: () => any[];

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

    // Create server instance
    server = new TypeScriptLSPServer();
    // Access the private methods for testing
    handleToolCall = (server as any).handleToolCall.bind(server);
    getTools = (server as any).getTools.bind(server);
  });

  afterAll(() => {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Tool Registration", () => {
    it("should list typescript-intel tool", () => {
      const tools = getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("typescript-intel");
      expect(tools[0].inputSchema).toBeDefined();
      expect(tools[0].inputSchema.type).toBe("object");
      expect(tools[0].inputSchema.properties.action).toBeDefined();
    });
  });

  describe("Position-based Actions", () => {
    it("should handle hover with selector", async () => {
      const result = await handleToolCall("typescript-intel", {
        action: "hover",
        filePath: testFile,
        selector: "const service### = new"
      });

      const sexpr = toSExprString(result);
      expect(sexpr).toContain("(HoverInfoImpl");
      expect(sexpr).toContain("const service: UserService");
    });

    it("should handle definition with occurrence selector", async () => {
      const result = await handleToolCall("typescript-intel", {
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
      const result = await handleToolCall("typescript-intel", {
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
      const result = await handleToolCall("typescript-intel", {
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
      const result = await handleToolCall("typescript-intel", {
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

      const result = await handleToolCall("typescript-intel", {
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
      const result = await handleToolCall("typescript-intel", {
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
      const result = await handleToolCall("typescript-intel", {
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
      const result = await handleToolCall("typescript-intel", {
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
    it("should handle invalid tool name", async () => {
      try {
        await handleToolCall("invalid-tool", {});
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Unknown tool");
      }
    });

    it("should handle missing required parameters", async () => {
      try {
        await handleToolCall("typescript-intel", {
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
        await handleToolCall("typescript-intel", {
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
        await handleToolCall("typescript-intel", {
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
      const result = await handleToolCall("typescript-intel", {
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
      const result = await handleToolCall("typescript-intel", {
        action: "symbols",
        filePath: testFile
      });

      const sexpr = toSExprString(result);
      // Check for nested structure with parent relationships
      expect(sexpr).toContain(":parent");
      // Symbols have :parent pointing to their containing symbol
      expect(sexpr).toContain(":parent User");
    });
  });
});
