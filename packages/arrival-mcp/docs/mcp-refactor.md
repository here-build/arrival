# MCP Architecture Refactor

## Problem Statement

Current implementation mixes concerns:

- Tools know about MCP protocol details (`$schema`, annotations)
- Result transformation is scattered
- No client capability awareness
- Header constants duplicated
- No batch request support

## Current Architecture (Problematic)

```
ToolInteraction (abstract)
├── getToolDescription() → returns MCP Tool with $schema ❌
├── getToolSchema() → returns MCP inputSchema
└── executeTool() → returns string | object | Blob

ActionToolInteraction extends ToolInteraction
├── registerAction()
├── getToolSchema() → generates oneOf (was broken)
└── executeTool() → returns results or error object

MCPServer
├── callTool() → wraps result in CallToolResult (missing isError)
└── getToolDefinitions() → collects tool descriptions

HonoMCPServer extends MCPServer
├── processJsonRpcRequest() → handles methods
├── get/post/delete handlers
└── hardcoded headers, no batch support
```

**Issues:**

1. `$schema` at wrong level (Tool vs inputSchema)
2. `isError` never set
3. `oneOf` was wrapped in invalid `type:` object ✅ fixed
4. Header casing inconsistent
5. No batch JSON-RPC
6. No client capability negotiation

## Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        TRANSPORT                             │
│  HonoTransport (HTTP/SSE, headers, batch handling)          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      MCP PROTOCOL                            │
│  - JSON-RPC dispatch                                         │
│  - toMCPSchema(schema, clientCaps) → Tool["inputSchema"]    │
│  - toMCPResult(result) → CallToolResult                     │
│  - toMCPError(error) → CallToolResult { isError: true }     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         TOOLS                                │
│  Pure business logic, typed inputs/outputs                   │
│  No MCP awareness                                            │
└─────────────────────────────────────────────────────────────┘
```

## Core Types

```typescript
// ============================================================
// RESULT TYPE - Tools return this, not strings
// ============================================================

type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

// Helper constructors
const ok = <T>(data: T): ToolResult<T> => ({ ok: true, data });
const err = (error: string, code?: string): ToolResult<never> =>
  ({ ok: false, error, code });

// ============================================================
// CLIENT CAPABILITIES - What the client supports
// ============================================================

interface ClientCapabilities {
  /** Client name for personalization */
  name?: string;

  /** Does client support oneOf/anyOf in schemas? */
  supportsUnions: boolean;

  /** Does client want $schema in inputSchema? */
  wantsMetaSchema: boolean;

  /** Does client support tool annotations? */
  supportsAnnotations: boolean;
}

// Detect from client info
const detectCapabilities = (clientInfo?: MCPClientInfo): ClientCapabilities => {
  const name = clientInfo?.name?.toLowerCase() ?? "";

  return {
    name: clientInfo?.name,
    // Claude Code doesn't support top-level unions
    supportsUnions: !name.includes("claude-code"),
    // Most clients don't need $schema
    wantsMetaSchema: false,
    // Annotations are MCP 2025+
    supportsAnnotations: true,
  };
};

// ============================================================
// CONSTANTS - Single source of truth
// ============================================================

const MCP = {
  HEADERS: {
    SESSION_ID: "mcp-session-id",
  },
  PROTOCOL_VERSION: "2025-06-18",
  JSON_SCHEMA_DRAFT: "https://json-schema.org/draft/2020-12/schema",
} as const;
```

## Pure Transformation Functions

```typescript
// ============================================================
// SCHEMA TRANSFORMATION
// ============================================================

/**
 * Transform a JSON Schema to MCP-compatible inputSchema
 * Applies client-capability-aware transformations
 */
const toMCPInputSchema = (
  schema: JSONSchema7,
  caps: ClientCapabilities
): Tool["inputSchema"] => {
  let result = structuredClone(schema);

  // Remove $schema from schema (it goes at inputSchema level if needed)
  delete result.$schema;

  // Ensure type: "object" at root (some clients require this)
  result.type ??= "object";

  // Flatten unions for clients that don't support them
  if (!caps.supportsUnions) {
    result = flattenUnions(result);
  }

  // Add $schema if client wants it
  if (caps.wantsMetaSchema) {
    result.$schema = MCP.JSON_SCHEMA_DRAFT;
  }

  return result as Tool["inputSchema"];
};

/**
 * Flatten oneOf/anyOf into discriminated object for dumb clients
 *
 * FROM: { oneOf: [{ const: "a", ... }, { const: "b", ... }] }
 * TO:   { type: "object", properties: { action: { enum: ["a", "b"] }, ... } }
 */
const flattenUnions = (schema: JSONSchema7): JSONSchema7 => {
  // Deep transform - find all oneOf/anyOf and flatten
  // Implementation depends on schema structure
  return schema; // TODO: implement based on actual patterns
};

// ============================================================
// RESULT TRANSFORMATION
// ============================================================

/**
 * Transform typed tool result to MCP CallToolResult
 */
const toMCPResult = <T>(result: ToolResult<T>): CallToolResult => {
  if (result.ok) {
    return {
      content: serializeContent(result.data),
      isError: false,
    };
  } else {
    return {
      content: [{ type: "text", text: result.error }],
      isError: true,
    };
  }
};

/**
 * Serialize data to MCP content array
 */
const serializeContent = (data: unknown): CallToolResult["content"] => {
  if (typeof data === "string") {
    return [{ type: "text", text: data }];
  }

  if (Array.isArray(data)) {
    return data.flatMap(item => serializeContent(item));
  }

  if (data instanceof Blob) {
    return [serializeBlob(data)];
  }

  return [{ type: "text", text: JSON.stringify(data, null, 2) }];
};

const serializeBlob = async (blob: Blob): Promise<ImageContent | AudioContent> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const base64 = btoa(String.fromCharCode(...bytes));
  const type = blob.type.startsWith("image/") ? "image" : "audio";

  return { type, data: base64, mimeType: blob.type };
};
```

## Tool Definition (No MCP Knowledge)

```typescript
// ============================================================
// TOOL INTERFACE - Pure, no MCP awareness
// ============================================================

interface ToolDefinition<TInput, TOutput> {
  /** Tool name */
  name: string;

  /** Human-readable description */
  description: string | (() => string | Promise<string>);

  /** Input schema (Zod) */
  inputSchema: z.ZodType<TInput>;

  /** Execute the tool */
  execute: (
    input: TInput,
    ctx: ToolContext
  ) => Promise<ToolResult<TOutput>>;

  /** Optional hints */
  hints?: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
  };
}

interface ToolContext {
  /** Hono request context */
  hono: Context;

  /** Session state (mutable) */
  state: Record<string, unknown>;

  /** Client capabilities */
  client: ClientCapabilities;
}

// ============================================================
// TOOL FACTORY
// ============================================================

const defineTool = <TInput, TOutput>(
  def: ToolDefinition<TInput, TOutput>
): ToolDefinition<TInput, TOutput> => def;

// Example usage:
const getUserTool = defineTool({
  name: "get-user",
  description: "Get user by ID",
  inputSchema: z.object({
    userId: z.string().describe("User ID"),
  }),
  hints: { readOnly: true },

  execute: async ({ userId }, ctx) => {
    const user = await db.users.find(userId);
    if (!user) {
      return err(`User ${userId} not found`, "NOT_FOUND");
    }
    return ok(user);
  },
});
```

## Action Tool (Batched Operations)

```typescript
// ============================================================
// ACTION TOOL - Higher-level abstraction for batched mutations
// ============================================================

interface ActionDefinition<TContext, TProps, TResult> {
  name: string;
  description: string | (() => string | Promise<string>);

  /** Required context fields */
  requiredContext: (keyof TContext)[];

  /** Optional context fields */
  optionalContext?: (keyof TContext)[];

  /** Action arguments schema */
  propsSchema: z.ZodType<TProps>;

  /** Execute single action */
  execute: (context: TContext, props: TProps) => Promise<TResult>;
}

interface ActionToolDefinition<TContext> {
  name: string;
  description: string;

  /** Context schema */
  contextSchema: { [K in keyof TContext]: z.ZodType<TContext[K]> };

  /** Registered actions */
  actions: ActionDefinition<TContext, any, any>[];
}

/**
 * Generate schema for action tool
 * Uses oneOf for action variants (will be flattened for dumb clients)
 */
const actionToolToSchema = <TContext>(
  def: ActionToolDefinition<TContext>,
  caps: ClientCapabilities
): Tool["inputSchema"] => {
  const actionSchemas = def.actions.map(action => ({
    type: "array" as const,
    description: resolveDescription(action.description),
    items: [
      { const: action.name },
      ...getPropsSchemaItems(action.propsSchema),
    ],
  }));

  const baseSchema = {
    type: "object" as const,
    properties: {
      actions: {
        type: "array" as const,
        description: "List of actions to execute",
        items: {
          oneOf: actionSchemas,  // oneOf at items level, not wrapped in type
        },
      },
      ...contextToProperties(def.contextSchema),
    },
    required: ["actions", ...getUniversallyRequired(def)],
  };

  return toMCPInputSchema(baseSchema, caps);
};
```

## MCP Protocol Layer

```typescript
// ============================================================
// MCP SERVER - Protocol handling, no transport knowledge
// ============================================================

class MCPProtocol {
  private tools: Map<string, ToolDefinition<any, any>> = new Map();
  private sessions: Map<string, SessionState> = new Map();

  register<TIn, TOut>(tool: ToolDefinition<TIn, TOut>): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  /** Handle tools/list */
  async listTools(caps: ClientCapabilities): Promise<ListToolsResult> {
    const tools: Tool[] = [];

    for (const def of this.tools.values()) {
      tools.push({
        name: def.name,
        description: await resolveDescription(def.description),
        inputSchema: toMCPInputSchema(
          z.toJSONSchema(def.inputSchema),
          caps
        ),
        ...(caps.supportsAnnotations && def.hints ? {
          annotations: {
            readOnlyHint: def.hints.readOnly,
            destructiveHint: def.hints.destructive,
            idempotentHint: def.hints.idempotent,
          },
        } : {}),
      });
    }

    return { tools };
  }

  /** Handle tools/call */
  async callTool(
    name: string,
    args: unknown,
    ctx: ToolContext
  ): Promise<CallToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // Validate input
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: formatZodError(parsed.error) }],
        isError: true,
      };
    }

    // Execute
    try {
      const result = await tool.execute(parsed.data, ctx);
      return toMCPResult(result);
    } catch (e) {
      return {
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      };
    }
  }

  /** Handle JSON-RPC dispatch */
  async dispatch(
    method: string,
    params: unknown,
    ctx: ToolContext
  ): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.serverInfo;

      case "tools/list":
        return this.listTools(ctx.client);

      case "tools/call":
        const { name, arguments: args } = params as CallToolRequest["params"];
        return this.callTool(name, args, ctx);

      case "ping":
        return {};

      default:
        throw { code: -32601, message: `Method not found: ${method}` };
    }
  }

  readonly serverInfo = {
    protocolVersion: MCP.PROTOCOL_VERSION,
    serverInfo: { name: "arrival-mcp", version: "1.0.0" },
    capabilities: { tools: { list: true } },
  };
}
```

## Transport Layer

```typescript
// ============================================================
// HONO TRANSPORT - HTTP/SSE, headers, batching
// ============================================================

class HonoMCPTransport {
  constructor(private protocol: MCPProtocol) {
  }

  /** Create Hono routes */
  routes() {
    const app = new Hono();

    app.get("/", this.handleGet);
    app.post("/", this.handlePost);
    app.delete("/", this.handleDelete);

    return app;
  }

  private handlePost = async (c: Context): Promise<Response> => {
    const sessionId = c.req.header(MCP.HEADERS.SESSION_ID) ?? crypto.randomUUID();
    c.header(MCP.HEADERS.SESSION_ID, sessionId);

    const body = await c.req.json();
    const caps = detectCapabilities(this.getClientInfo(sessionId));
    const ctx = this.createToolContext(c, sessionId, caps);

    // Handle batch requests
    const isBatch = Array.isArray(body);
    const requests = isBatch ? body : [body];

    const responses = await Promise.all(
      requests.map(req => this.processRequest(req, ctx))
    );

    const result = isBatch ? responses : responses[0];

    // SSE or JSON response
    if (c.req.header("accept")?.includes("text/event-stream")) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: JSON.stringify(result) });
        await stream.close();
      });
    }

    return c.json(result);
  };

  private async processRequest(
    { id, method, params }: JSONRPCRequest,
    ctx: ToolContext
  ): Promise<JSONRPCResponse> {
    try {
      const result = await this.protocol.dispatch(method, params, ctx);
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: (error as any).code ?? -32603,
          message: (error as any).message ?? "Internal error",
        },
      };
    }
  }

  // ... handleGet, handleDelete, session management
}
```

## Usage

```typescript
// Create protocol
const mcp = new MCPProtocol()
  .register(getUserTool)
  .register(createProjectTool)
  .register(actionsTool);

// Create transport
const transport = new HonoMCPTransport(mcp);

// Mount routes
app.route("/mcp", transport.routes());
```

## Migration Path

1. **Phase 1**: Fix immediate bugs (done: oneOf structure)
2. **Phase 2**: Add `isError` to current implementation
3. **Phase 3**: Extract constants, fix header casing
4. **Phase 4**: Introduce `ToolResult<T>` type
5. **Phase 5**: Extract pure transformation functions
6. **Phase 6**: Refactor to layered architecture

## Benefits

- **Testable**: Pure functions can be unit tested in isolation
- **Composable**: Layers can be swapped (different transports, protocols)
- **Type-safe**: `ToolResult<T>` makes success/error explicit
- **Client-aware**: Capability detection adapts schemas automatically
- **Spec-compliant**: `isError`, proper `$schema` placement, batch support
