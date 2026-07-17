// sdk-adapter — wire an array of tools (DiscoveryTool / ActionTool / anything `McpTool`-shaped) onto
// the OFFICIAL @modelcontextprotocol/sdk McpServer.
//
// The whole bridge is two handlers: `describe()` → tools/list, `call()` → tools/call. Because a tool
// is a plain value (not a subclass), tools are just an array you register — and the SAME describe/call
// surface backs any transport. The SDK's per-request AbortSignal (`extra.signal` — cancel / timeout /
// disconnect) is threaded straight into the eval's TICK check; the host supplies the rest of the
// dispatch ctx (session/user/record). Whatever `call` returns — a DiscoveryTool's `(string | Blob)[]`
// REPL output (core texts + R6's per-extra label strings and raw Blobs, §2.6) or an ActionTool's
// result object — is lowered by the one `serializeResult` (string→text, Blob→image/audio base64,
// object→JSON, `success:false`→isError), so both tiers register identically.
//
// R5 (§2.5): each tools/call is also wired to the per-statement event stream — `ToolCallCtx.onEvent`
// feeds the DUAL notification channel (progress tier + full-ReplEvent rich tier) riding the call's
// own SSE/stdio response stream; the aggregate CallToolResult stays byte-identical (additive
// observation, the ruled law).
//
// We drive `McpServer.server` (the low-level escape hatch) rather than `McpServer.registerTool`,
// because our catalog is DYNAMIC: `describe(clientInfo)` regenerates per `tools/list` (the
// dynamicDescription welcome, personalized by the client) — registerTool registers ONE static schema.
// Going through `.server` keeps that, and never names the deprecated `Server` symbol.

import type { ReplEvent, ReplStatementEvent } from "@inhuman.tools/mcp-substrate";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import type { ToolCallCtx } from "./DiscoveryTool.js";
import { serializeResult, type UserlandCallToolResult } from "./dispatch.js";

/** The rich-tier notification method (R5, §2.5): carries the full `ReplEvent`. Unknown-method
 *  notifications are droppable by spec, so a client that doesn't know it degrades to silence
 *  harmlessly; our own clients/custdev loops subscribe to it for the wireframe-then-record trace. */
export const ARRIVAL_EVENT_METHOD = "notifications/arrival/event";

/** A statement event's core text — the progress-tier `message` (text blocks only; binary extras
 *  ride the rich tier and the aggregate, never a progress message). */
function coreText(event: ReplStatementEvent): string {
  return event.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Wire one call's `onEvent` to `extra.sendNotification` — the DUAL channel (§2.5, ruled):
 *  `notifications/progress` when the client sent `_meta.progressToken` (spec-blessed interop
 *  tier: topology ⇒ progress 0/total, statement ⇒ index+1/total + core text), PLUS
 *  `ARRIVAL_EVENT_METHOD` carrying the full `ReplEvent` (rich tier). Sends are chained on one
 *  queue so frames ride the call's own SSE/stdio stream IN EVENT ORDER; a send failure is
 *  swallowed (notifications are additive observation — they must never fail the call). The
 *  returned `done` is awaited before the final result is lowered, so every event frame
 *  precedes the response frame on the stream. */
function notificationChannel(extra: {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>;
}): { onEvent: (event: ReplEvent) => void; done: () => Promise<void> } {
  const progressToken = extra._meta?.progressToken;
  let total = 0;
  let queue: Promise<void> = Promise.resolve();
  const send = (method: string, params: Record<string, unknown>): void => {
    queue = queue.then(() => extra.sendNotification({ method, params })).catch(() => undefined);
  };
  return {
    onEvent: (event) => {
      send(ARRIVAL_EVENT_METHOD, event);
      if (progressToken === undefined) return;
      if (event.kind === "topology") {
        total = event.total;
        // The "it's coming" signal any conforming client shows — the future trace exists.
        send("notifications/progress", { progressToken, progress: 0, total: event.total });
      } else if (event.kind === "statement") {
        send("notifications/progress", { progressToken, progress: event.index + 1, total, message: coreText(event) });
      }
    },
    done: () => queue,
  };
}

/** The transport contract both `DiscoveryTool` and `ActionTool` satisfy (structurally). `call`'s
 *  return is serialized by `serializeResult`, so a tier may return `string[]`, an object, or an array
 *  of objects — all lower uniformly. */
export interface McpTool {
  readonly name: string;
  describe(clientInfo?: Record<string, unknown>): Promise<Tool>;
  call(args: any, ctx?: ToolCallCtx): Promise<unknown>;
}

/** Map an incoming call to its dispatch-time ctx (session/user/record). The adapter adds the
 *  request's own `signal`, so the resolver never supplies it. Omit the resolver for an anonymous,
 *  session-less wiring (still cancellable via the transport signal). */
export type CtxResolver = (
  params: { name: string; arguments?: Record<string, unknown> },
  clientInfo?: Record<string, unknown>,
) => Omit<ToolCallCtx, "signal"> | Promise<Omit<ToolCallCtx, "signal">>;

/** Register the tools on `mcp` (an `McpServer`), driving its low-level `.server` for dynamic
 *  ListTools/CallTool. An unknown tool, an abort, or an infra fault surfaces as an `isError` result;
 *  a tool's own structured failure (`success:false`) becomes `isError` via `serializeResult`; a
 *  DiscoveryTool REPL crash is normal content (an `(error …)` form). Do not mix with
 *  `mcp.registerTool` — these custom handlers replace McpServer's own tool dispatch. */
export function registerTools(mcp: McpServer, tools: readonly McpTool[], resolveCtx?: CtxResolver): void {
  const server = mcp.server; // low-level escape hatch — custom, dynamic ListTools/CallTool
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  const clientInfo = () => server.getClientVersion() as Record<string, unknown> | undefined;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await Promise.all(tools.map((t) => t.describe(clientInfo()))),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name);
    if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };

    const base = (await resolveCtx?.(request.params, clientInfo())) ?? {};
    const args = request.params.arguments ?? {};
    // R5 dual channel: the adapter always wires the notification tiers; a host-resolved
    // `onEvent` (from `resolveCtx`) still observes every event — fan-out, never replacement.
    const channel = notificationChannel(extra);
    const hostOnEvent = base.onEvent;
    const onEvent = (event: ReplEvent): void => {
      hostOnEvent?.(event);
      channel.onEvent(event);
    };
    try {
      // `call` returns `string[]` (DiscoveryTool) or a result object (ActionTool) — both are
      // `UserlandCallToolResult`-shaped; the one serializer lowers either. The aggregate is
      // UNCHANGED by streaming (§2.5's law): events are additive observation, and a
      // non-streaming client sees the byte-identical full result.
      const result = (await tool.call(args, { ...base, signal: extra.signal, onEvent })) as
        | UserlandCallToolResult
        | UserlandCallToolResult[];
      await channel.done(); // every event frame precedes the response frame on the stream
      return await serializeResult(result);
    } catch (error) {
      await channel.done();
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });
}
