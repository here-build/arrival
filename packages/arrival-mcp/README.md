# MCP Framework

Framework for building Model Context Protocol (MCP) servers with clean separation of concerns.

## Architecture

### Core Components

**`MCPServer`** - Protocol-only MCP server
- Manages tools and their lifecycle
- Handles session state (override `getSessionState`, `setSessionState`, `deleteSessionState` for Redis/etc)
- No transport concerns

**`HonoMCPServer`** - HTTP/SSE transport layer
- Bridges HTTP requests to `MCPServer`
- Supports both JSON-RPC and SSE response modes
- Handles session creation/cleanup

**`ToolInteraction`** - Base class for tools
- Access to Hono context: `this.context`
- Access to session state: `this.state`
- Define schema and execution logic

**`DiscoveryToolInteraction`** - Tools that execute Scheme expressions
- Sandboxed LIPS environment
- Register functions for domain-specific operations
- Returns serialized results

**`ActionToolInteraction`** - Tools with batched actions
- Define actions with context constraints
- Batch execution with validation
- Shared context across all actions in batch

## Quick Start

### Define a Tool

```typescript
import { ToolInteraction } from "@here.build/mcp-framework";
import * as z from "zod";

class MyTool extends ToolInteraction<{ input: string }> {
  static readonly name = "my-tool";
  readonly description = "Does something useful";

  async getToolSchema() {
    return {
      type: "object",
      properties: {
        input: { type: "string" }
      },
      required: ["input"]
    };
  }

  async executeTool(args: { input: string }) {
    // Access user from context (set by middleware)
    const user = this.context.get("user");

    // Access session state
    this.state.lastInput = args.input;

    return { result: `Processed: ${args.input}` };
  }
}
```

### Create Server

```typescript
import { Hono } from "hono";
import { MCPServer, HonoMCPServer } from "@here.build/mcp-framework";

const mcpServer = new MCPServer(MyTool, OtherTool);
const honoServer = new HonoMCPServer(mcpServer);

const app = new Hono();

app
  .get("/", honoServer.handler)
  .post("/", honoServer.handler)
  .delete("/", honoServer.deleteHandler);

export default app;
```

## Session Management

Sessions are managed automatically via `Mcp-Session-Id` header.

**Default (in-memory):**
```typescript
const mcpServer = new MCPServer(tools...);
// Sessions stored in Map
```

**Production (Redis):**
```typescript
class RedisMCPServer extends MCPServer {
  protected async getSessionState(context, sessionId) {
    const data = await context.env.REDIS.get(`mcp:${sessionId}`);
    return data ? JSON.parse(data) : {};
  }

  protected async setSessionState(context, sessionId, state) {
    await context.env.REDIS.set(
      `mcp:${sessionId}`,
      JSON.stringify(state),
      { EX: 3600 }
    );
  }

  protected async deleteSessionState(context, sessionId) {
    await context.env.REDIS.del(`mcp:${sessionId}`);
  }
}
```

## SSE Support

The framework supports both JSON-RPC and SSE response modes:

**JSON-RPC (default):**
```
POST /mcp
Content-Type: application/json

→ JSON response
```

**SSE per-request:**
```
POST /mcp
Accept: text/event-stream

→ SSE stream with single response event, then closes
```

**SSE persistent:**
```
GET /mcp
Accept: text/event-stream

→ SSE stream stays open for server notifications
```

## Testing

```bash
npm test
```

Tests cover:
- Session persistence across requests
- Session isolation between clients
- State mutations (counters, arrays)
- Backward compatibility (no session ID)
- Tool definitions with state
- Session cleanup
- Custom storage overrides

## Examples

See `platform/mcp-server` for a complete implementation with OAuth authentication.
