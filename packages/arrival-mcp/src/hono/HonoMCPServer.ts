import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { MCPServer } from "../MCPServer";

/**
 * Hono HTTP/SSE handler for MCPServer
 * Bridges HTTP requests to MCPServer protocol methods
 */
export class HonoMCPServer extends MCPServer {
  /**
   * Main request handler - supports both POST (JSON-RPC) and GET (SSE)
   */
  handler = async (c: Context) => {
    // Handle GET requests (persistent SSE for old clients)
    if (c.req.method === "GET") {
      const acceptHeader = c.req.header("accept");

      // Persistent SSE stream for server-initiated notifications
      if (acceptHeader?.includes("text/event-stream")) {
        console.log("[HonoMCPServer] Opening persistent SSE stream");

        return streamSSE(c, async (stream) => {
          console.log("[HonoMCPServer] Persistent SSE stream opened");

          // Send initial connection confirmation
          await stream.writeSSE({
            data: "",
            event: "endpoint",
            id: String(Date.now()),
          });

          // Keepalive ping every 30 seconds
          const keepaliveInterval = setInterval(async () => {
            try {
              await stream.writeln(": keepalive");
            } catch (error) {
              console.log("[HonoMCPServer] SSE keepalive failed:", error);
              clearInterval(keepaliveInterval);
            }
          }, 30_000);

          // Cleanup on abort
          stream.onAbort(() => {
            console.log("[HonoMCPServer] Persistent SSE stream closed");
            clearInterval(keepaliveInterval);
          });

          // Stream stays open until client closes or session deleted
        });
      }

      // Return basic server info for non-SSE GET
      return c.json({
        mcp: "1.0",
        name: "mcp-server",
        version: "0.1.0",
        capabilities: {
          tools: { list: true },
        },
      });
    }

    // Handle POST requests with JSON-RPC body
    const request = await c.req.json();
    console.log("[HonoMCPServer] Processing request:", request);

    const acceptHeader = c.req.header("accept");
    const wantsSSE = acceptHeader?.includes("text/event-stream");

    // Helper to process JSON-RPC request and get response
    const processRequest = async (): Promise<any> => {
      switch (request.method) {
        case "initialize": {
          const sessionId = crypto.randomUUID();
          c.header("Mcp-Session-Id", sessionId);
          console.log(`[HonoMCPServer] Created session: ${sessionId}`);

          return {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2025-03-26",
              serverInfo: {
                name: "mcp-server",
                version: "0.1.0",
              },
              capabilities: {
                tools: { list: true },
              },
            },
          };
        }

        case "tools/list":
          return {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              tools: await this.getToolDefinitions(c),
            },
          };

        case "tools/call":
          try {
            return {
              jsonrpc: "2.0",
              id: request.id,
              result: await this.callTool(c, request.params),
            };
          } catch (error) {
            console.error("[HonoMCPServer] Tool execution error:", error);
            return {
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32_603,
                message: "Tool execution failed",
                data: error instanceof Error ? error.message : error,
              },
            };
          }

        case "resources/list":
        case "resources/read":
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32_601,
              message: "Resources not implemented yet",
            },
          };

        case "prompts/list":
        case "prompts/get":
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32_601,
              message: "Prompts not implemented yet",
            },
          };

        case "logging/setLevel":
          const { level } = request.params;
          console.log(`[HonoMCPServer] Logging level set to: ${level}`);
          return {
            jsonrpc: "2.0",
            id: request.id,
            result: {},
          };

        case "completion/complete":
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32_601,
              message: "Completion not implemented",
            },
          };

        case "sampling/createMessage":
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32_601,
              message: "Sampling not implemented",
            },
          };

        case "ping":
          return {
            jsonrpc: "2.0",
            id: request.id,
            result: {},
          };

        default:
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32_601,
              message: `Method not found: ${request.method}`,
            },
          };
      }
    };

    // If client wants SSE for this POST request
    if (wantsSSE) {
      console.log("[HonoMCPServer] POST with SSE response requested");

      return streamSSE(c, async (stream) => {
        try {
          // Process request
          const response = await processRequest();

          // Send response as SSE event
          await stream.writeSSE({
            data: JSON.stringify(response),
            event: "message",
            id: String(request.id),
          });

          console.log("[HonoMCPServer] SSE response sent, closing stream");
        } catch (error) {
          console.error("[HonoMCPServer] Error in SSE response:", error);
          await stream.writeSSE({
            data: JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32_603,
                message: "Internal error",
                data: error instanceof Error ? error.message : String(error),
              },
            }),
            event: "message",
          });
        }
        // Stream closes automatically after sending
      });
    }

    // Default: return JSON response
    const response = await processRequest();
    return c.json(response);
  };

  /**
   * DELETE handler for session cleanup
   */
  deleteHandler = async (c: Context): Promise<Response> => {
    const sessionId = c.req.header("mcp-session-id");

    if (sessionId) {
      console.log(`[HonoMCPServer] Deleting session: ${sessionId}`);
      await this.deleteSession(c, sessionId);
    }

    return c.json({ success: true });
  };
}
