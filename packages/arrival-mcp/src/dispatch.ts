import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import invariant from "tiny-invariant";
import type { Constructor } from "type-fest";

import type { ToolInteraction, MCPClientInfo, UserlandCallToolResult } from "./ToolInteraction";

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Serialize userland results (string | object | Blob) to MCP CallToolResult format.
 */
export async function serializeResult(
  callToolResult: UserlandCallToolResult | UserlandCallToolResult[],
): Promise<CallToolResult> {
  const isError =
    callToolResult != null &&
    typeof callToolResult === "object" &&
    !Array.isArray(callToolResult) &&
    "success" in callToolResult &&
    callToolResult.success === false;

  return {
    content: await Promise.all(
      asArray(callToolResult).map(
        async (result): Promise<CallToolResult["content"][number]> => {
          switch (true) {
            case typeof result === "string":
              return { type: "text", text: result };
            case result instanceof Blob && result.type.startsWith("image/"):
            case result instanceof Blob && result.type.startsWith("audio/"): {
              let binary = "";
              const bytes = new Uint8Array(await result.arrayBuffer());
              const length_ = bytes.byteLength;
              for (let index = 0; index < length_; index++) {
                binary += String.fromCodePoint(bytes[index]);
              }
              return {
                type: result.type.split("/")[0] as "image" | "audio",
                data: btoa(binary),
                mimeType: result.type,
              };
            }
            default:
              return { type: "text", text: JSON.stringify(result) };
          }
        },
      ),
    ),
    isError,
  };
}

/**
 * Dispatch a tool call: find the tool class, instantiate, execute, serialize result.
 * Pure logic — no transport, no protocol, no session management.
 */
export async function dispatchTool(
  tools: Constructor<ToolInteraction<any>>[],
  context: Context,
  state: Record<string, any>,
  request: { name: string; arguments?: Record<string, unknown> },
  clientInfo?: MCPClientInfo,
): Promise<CallToolResult> {
  const ToolClass = tools.find(({ name }) => name === request.name);
  invariant(ToolClass, `Unknown tool: ${request.name}`);

  const tool = new ToolClass(context, state, request.arguments);
  console.log("calling MCP", request.name, request.arguments);
  const result = await tool.executeTool(clientInfo);
  return serializeResult(result);
}

/**
 * Get tool definitions from all registered tool classes.
 * Pure logic — no transport, no protocol.
 */
export async function getToolDefinitions(
  tools: Constructor<ToolInteraction<any>>[],
  context: Context,
  state: Record<string, any>,
  clientInfo?: MCPClientInfo,
): Promise<ListToolsResult["tools"]> {
  const definitions: ListToolsResult["tools"] = [];
  for (const ToolClass of tools) {
    try {
      const tool = new ToolClass(context, state);
      definitions.push(await tool.getToolDescription(clientInfo));
    } catch (error) {
      console.warn(`Failed to get definition for ${ToolClass.name}:`, error);
    }
  }
  return definitions;
}
