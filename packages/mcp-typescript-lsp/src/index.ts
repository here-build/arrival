import { toSExprString, type SExprSerializable } from "@here.build/arrival-serializer";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { parseSelectorWithOccurrence } from "./selector-parser.js";
import { TSLanguageServiceWrapper } from "./ts-language-service.js";

/** Typed arguments for the typescript-intel tool call */
interface TypeScriptIntelArgs {
  action: string;
  filePath?: string;
  selector?: string;
  line?: number;
  character?: number;
  severity?: "error" | "warning" | "info" | "hint";
  projectRoot?: string;
  query?: string;
  kind?: "class" | "interface" | "function" | "variable" | "type" | "namespace";
  scope?: "exports" | "top-level" | "outline" | "all";
  target?: string;
  depth?: number;
  includeTests?: boolean;
  groupBy?: "file" | "component" | "flat" | "nested";
  queries?: Array<{ at: string; want: Record<string, unknown> }>;
}

export class TypeScriptLSPServer {
  private readonly server: Server;
  private readonly tsService: TSLanguageServiceWrapper;

  constructor() {
    this.tsService = new TSLanguageServiceWrapper();
    this.server = new Server(
      {
        name: "typescript-intel",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getTools(),
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      const args = (rawArgs ?? {}) as unknown as TypeScriptIntelArgs;

      try {
        const result = await this.handleToolCall(name, args);
        return {
          content: [
            {
              type: "text",
              text: toSExprString(result),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private getTools(): Tool[] {
    return [
      {
        name: "typescript-intel",
        description: `TypeScript/JavaScript code intelligence powered by the TypeScript compiler. Provides semantic understanding that grep/text search cannot: type inference, cross-file references, interface implementations, and more.

## WHEN TO USE THIS TOOL (not grep!)

**"Where is X used?"** → action: "references"
  Find ALL usages of a function, type, variable, or class across the entire codebase.
  Unlike grep, this understands scope, imports, and re-exports.
  Example: Find everywhere \`useState\` hook is called, or all places that use \`UserService\`.

**"Where is X defined?"** → action: "definition"
  Jump to the canonical definition of any symbol - the actual source, not just imports.
  Resolves through re-exports, barrel files, and node_modules to find the real definition.
  Example: Find where \`TplNode\` type is actually defined, not where it's imported.

**"What type is X?"** → action: "hover"
  Get full type information for any expression, including inferred types.
  Shows the resolved type even for complex generics and conditional types.
  Example: See what type \`props.children\` resolves to, or what a function returns.

**"Are there type errors?"** → action: "diagnostics"
  Get TypeScript compiler errors and warnings for a file. More accurate than \`tsc\`
  because it uses the same language service that IDEs use.
  Example: Check if your changes introduced any type errors before committing.

**"What implements this interface?"** → action: "find-implementations"
  Find all classes/objects that implement an interface or extend a class.
  Example: Find all components that implement \`React.FC\`, or all services extending \`BaseService\`.

**"What extends/implements X?"** → action: "type-hierarchy"
  See the full inheritance tree - what a type extends and what extends it.
  Example: Understand the class hierarchy of \`TplNode\` → \`TplTag\` | \`TplComponent\` | \`TplSlot\`.

**"What would break if I change X?"** → action: "impact-analysis"
  Trace downstream dependencies to see what code would be affected by changes.
  Example: Before refactoring \`UserService\`, see all files that depend on it.

**"What symbols are in this file?"** → action: "symbols"
  List all classes, functions, types, variables in a file with their locations.
  Example: Get an overview of a large file's structure.

**"Find symbol by name across project"** → action: "search-symbol"
  Search for symbols by name pattern across the entire project.
  Example: Find all types containing "User" in their name.

## HOW TO SPECIFY POSITION

Use \`selector\` with ### marker to point at code (preferred):
  selector: "const user###: User"  → points at the colon
  selector: "function foo###("     → points at the opening paren
  selector: "User#2"               → second occurrence of "User" in file

Or use line/character (1-based line, 0-based character):
  line: 42, character: 10

## OUTPUT FORMAT

Results use S-expressions for compact, parseable output:
  hover: (HoverInfoImpl :expression hover "const x: number" :full-type "number")
  definition: (list (DefinitionImpl :file "/path.ts" :line 42 :char 8 :kind "class"))
  references: (list (ReferenceImpl :file "/a.ts" :line 10 :char 5) ...)
  diagnostics: (list (DiagnosticImpl :message "Type error" :line 15 :code 2322 :severity error))`,
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "hover",
                "definition",
                "references",
                "completions",
                "diagnostics",
                "symbols",
                "search-symbol",
                "call-hierarchy",
                "type-hierarchy",
                "impact-analysis",
                "find-implementations",
                "analyze",
              ],
              description: `The semantic operation to perform:
• "references" - Find all usages of a symbol (like "Find All References" in IDE)
• "definition" - Jump to where a symbol is defined (like "Go to Definition")
• "hover" - Get type info for a symbol (like hovering in IDE)
• "diagnostics" - Get type errors/warnings in a file
• "find-implementations" - Find classes implementing an interface
• "type-hierarchy" - See inheritance tree (extends/implements)
• "impact-analysis" - Trace what depends on a symbol
• "symbols" - List all symbols in a file
• "search-symbol" - Find symbols by name across project
• "completions" - Get autocomplete suggestions
• "call-hierarchy" - See what calls a function and what it calls
• "analyze" - Unified query for multiple pieces of info at once`,
            },
            filePath: {
              type: "string",
              description:
                "Absolute path to the .ts/.tsx/.js/.jsx file to analyze. Required for all actions except search-symbol.",
            },
            selector: {
              type: "string",
              description: `RECOMMENDED: Code snippet with ### marking exactly where to look. The ### acts as a cursor position.
Examples:
  "const user###: User"     → analyze the type annotation
  "user.###name"            → analyze the 'name' property access
  "function ###handleClick" → analyze the function name
  "User#2"                  → second occurrence of "User" in the file (for disambiguation)`,
            },
            line: {
              type: "number",
              description:
                "Alternative to selector: 1-based line number. Use with 'character'. Selector is usually easier.",
            },
            character: {
              type: "number",
              description: "Alternative to selector: 0-based character offset within the line. Use with 'line'.",
            },
            severity: {
              type: "string",
              enum: ["error", "warning", "info", "hint"],
              description:
                "For 'diagnostics' action: filter by minimum severity. 'error' = only errors, 'warning' = errors + warnings, etc.",
            },
            projectRoot: {
              type: "string",
              description:
                "For 'search-symbol' action: root directory to search in (usually the project root or a package directory)",
            },
            query: {
              type: "string",
              description:
                "For 'search-symbol' action: symbol name pattern to search for. Example: 'User' finds User, UserService, UserModel, etc.",
            },
            kind: {
              type: "string",
              enum: ["class", "interface", "function", "variable", "type", "namespace"],
              description:
                "For 'search-symbol' action: only return symbols of this kind. Example: kind='interface' to find only interfaces.",
            },
            scope: {
              type: "string",
              enum: ["exports", "top-level", "outline", "all"],
              default: "top-level",
              description: `For 'symbols' action: filter symbol scope level.
• "exports" — Only exported symbols
• "top-level" (default) — All module-level declarations (exported or not), no function internals
• "outline" — Module-level declarations + class/interface members (methods, properties, enum values)
• "all" — Every symbol at every scope level`,
            },
            target: {
              type: "string",
              description:
                "For 'impact-analysis' action: the symbol name to analyze. Example: 'UserService' to see what depends on UserService.",
            },
            depth: {
              type: "number",
              minimum: 1,
              maximum: 5,
              default: 2,
              description: "How many levels deep to trace impact (for impact-analysis)",
            },
            includeTests: {
              type: "boolean",
              default: true,
              description: "Include test files in impact analysis",
            },
            groupBy: {
              type: "string",
              enum: ["file", "component", "flat", "nested"],
              default: "file",
              description: "How to group impact analysis results (nested shows dependency chains)",
            },
            queries: {
              type: "array",
              description: "Symbol queries for unified analyze action",
              items: {
                type: "object",
                properties: {
                  at: {
                    type: "string",
                    description: "Selector with ### marker or line:char position",
                  },
                  want: {
                    type: "object",
                    description: "Information bundles to retrieve",
                    properties: {
                      identity: {
                        oneOf: [{ type: "boolean" }, { type: "object", properties: {}, additionalProperties: true }],
                      },
                      location: {
                        oneOf: [{ type: "boolean" }, { type: "object", properties: {}, additionalProperties: true }],
                      },
                      type: {
                        oneOf: [
                          { type: "boolean" },
                          {
                            type: "object",
                            properties: {
                              expanded: { type: "boolean" },
                              constraints: { type: "boolean" },
                            },
                          },
                        ],
                      },
                      signature: {
                        oneOf: [{ type: "boolean" }, { type: "object", properties: {}, additionalProperties: true }],
                      },
                      hierarchy: {
                        oneOf: [
                          { type: "boolean" },
                          {
                            type: "object",
                            properties: {
                              depth: { type: "number" },
                              implementations: { type: "boolean" },
                            },
                          },
                        ],
                      },
                      members: {
                        oneOf: [{ type: "boolean" }, { type: "object", properties: {}, additionalProperties: true }],
                      },
                      usage: {
                        oneOf: [
                          { type: "boolean" },
                          {
                            type: "object",
                            properties: {
                              limit: { type: "number" },
                              includeTests: { type: "boolean" },
                            },
                          },
                        ],
                      },
                      impact: {
                        oneOf: [
                          { type: "boolean" },
                          {
                            type: "object",
                            properties: {
                              depth: { type: "number" },
                              includeTests: { type: "boolean" },
                            },
                          },
                        ],
                      },
                      diagnostics: {
                        oneOf: [
                          { type: "boolean" },
                          {
                            type: "object",
                            properties: {
                              severity: { enum: ["error", "warning", "info", "hint"] },
                            },
                          },
                        ],
                      },
                      flow: {
                        oneOf: [{ type: "boolean" }, { type: "object", properties: {}, additionalProperties: true }],
                      },
                    },
                  },
                },
                required: ["at", "want"],
              },
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
    ];
  }

  private async handleToolCall(name: string, args: TypeScriptIntelArgs): Promise<SExprSerializable> {
    if (name !== "typescript-intel") {
      throw new Error(`Unknown tool: ${name}`);
    }

    const { action } = args;

    // Convert selector to line/character if provided
    if (args.selector && args.filePath) {
      const position = parseSelectorWithOccurrence(args.filePath, args.selector);
      args.line = position.line;
      args.character = position.character;
    }

    // Validate required params based on action
    const positionActions = [
      "hover",
      "definition",
      "references",
      "completions",
      "call-hierarchy",
      "type-hierarchy",
      "find-implementations",
    ];
    if (positionActions.includes(action) && (!args.filePath || args.line == null || args.character == null)) {
      throw new Error(`Action '${action}' requires filePath and either selector or line/character`);
    }

    switch (action) {
      case "hover":
        return await this.tsService.getHover(args.filePath!, args.line!, args.character!);

      case "definition":
        return await this.tsService.getDefinition(args.filePath!, args.line!, args.character!);

      case "references":
        return await this.tsService.getReferences(args.filePath!, args.line!, args.character!);

      case "completions":
        return await this.tsService.getCompletions(args.filePath!, args.line!, args.character!);

      case "diagnostics":
        if (!args.filePath) {
          throw new Error("Action 'diagnostics' requires filePath");
        }
        return await this.tsService.getDiagnostics(args.filePath, args.severity);

      case "symbols":
        if (!args.filePath) {
          throw new Error("Action 'symbols' requires filePath");
        }
        return await this.tsService.getDocumentSymbols(args.filePath, args.scope);

      case "search-symbol":
        if (!args.projectRoot || !args.query) {
          throw new Error("Action 'search-symbol' requires projectRoot and query");
        }
        return await this.tsService.searchSymbols(args.projectRoot, args.query, args.kind);

      case "call-hierarchy":
        return await this.tsService.getCallHierarchy(args.filePath!, args.line!, args.character!);

      case "type-hierarchy":
        return await this.tsService.getTypeHierarchy(args.filePath!, args.line!, args.character!);

      case "impact-analysis":
        if (!args.target) {
          throw new Error("Action 'impact-analysis' requires target");
        }
        return await this.tsService.analyzeImpact(
          args.target,
          args.filePath,
          args.depth || 2,
          args.includeTests !== false,
          args.groupBy || "file",
        );

      case "find-implementations":
        return await this.tsService.findImplementations(args.filePath!, args.line!, args.character!);

      case "analyze":
        if (!args.filePath || !args.queries || !Array.isArray(args.queries)) {
          throw new Error("Action 'analyze' requires filePath and queries array");
        }
        return await this.tsService.analyze(args.filePath, args.queries);

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("TypeScript LSP MCP server started");
  }
}

// Export for library usage
export { TSLanguageServiceWrapper as TSLanguageServiceWrapper } from "./ts-language-service.js";
export type {
  HoverInfo as HoverInfo,
  Definition as Definition,
  Reference as Reference,
  Diagnostic as Diagnostic,
} from "./types.js";
