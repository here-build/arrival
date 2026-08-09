---
title: arrival resources
genre: proposal
status: deferred-indefinitely
tags: [arrival, mcp, resources, plexus, post-mortem]
created: 2026-05-12
updated: 2026-05-12
---

# Arrival Resources — Deferred (post-mortem)

**Status**: deferred indefinitely after day-3 spike failed
**Was**: hypothesis that MCP resources could expose Plexus entities as `@`-mentionable attachments in Claude Desktop
**Reason**: Anthropic's intentional design constraint — resources are application-controlled, no auto-injection. Verified empirically + via maintainer quotes. Not a "wait until clients catch up" situation.

## What we tried

Built a minimal MCP resources surface as a "supercharger" — additive read-only entity attachment for the cohort of clients that support `@`-mention. Two URI shapes (`entity/{uuid}` + `entity-by-name/{name}`), vendor MIME, project-scoped auth, naked JSON body via `Symbol.toSExpr` transform. ~85 LoC production + 3 tests + 1 framework hook + 1 substrate endpoint.

Per the spec's own day-3 gate ("if no client we care about actually consumes `resources/read` the way we expect, defer the whole proposal"), ran a stub server in Claude Desktop. Spike protocol at `foundations/arrival/arrival-mcp/src/__research__/resource-attach-stub/`.

## What we observed (2026-05-12)

- **Protocol layer**: works. Direct stdio JSON-RPC smoke test confirms `initialize` / `resources/list` / `resources/read` all respond with valid payloads.
- **Chat mode**: resource doesn't surface in the `@`-mention picker at all. (Some users on `typescript-sdk#686` report seeing them under Settings → Integrations as a configuration affordance, but they don't appear as attachable in the message composer.)
- **Cowork mode** (Claude Desktop's cloud-sandboxed agent mode): resource appears in picker. Clicking attaches it like a file. The agent then says "uploads directory appears empty" — runs `ls /sessions/.../mnt/uploads/`, finds nothing, asks user to re-upload.

The cowork failure mode is specifically the host-side bridge translating "attached resource" into "file in the VM's bindfs-mounted `/sessions/<name>/mnt/uploads/`" — and silently failing to materialize because the vendor MIME (`application/vnd.here-build.arrival.entity+json; v=1`) almost certainly isn't on the whitelist. Could potentially be unblocked by switching to `application/json`, but the cowork model is "file the agent reads via filesystem tools," not "content injected into prompt context." Different shape than the proposal needed.

## What we learned (the load-bearing finding)

From `modelcontextprotocol/python-sdk#1016`, Felix Weinberger (Anthropic MCP team):

> "Resources are intended to be application controlled — i.e. the host application decides whether and which resources to attach to a context window."

Multiple linked issues (TS SDK #686, Python SDK #1016, others) closed-as-designed across 12 months. **Anthropic's position on resource auto-injection is intentional and stable.** Banking on "client UX will eventually catch up" is banking against the maintainer's explicit direction.

VSCode Copilot and MCP Inspector do auto-read resources, but those aren't who arrival serves. Cursor removed MCP resource support entirely in March 2025. The cohort answer for "get content into context" across GitHub MCP, filesystem MCP, Postgres MCP, etc. is **expose data through tools, not resources** — resources are at most a metadata-browsing affordance.

Anthropic engineer recommendation from the same thread: *"refactor it to be a tool to make use of it automatically — naming it as a getter should be enough of a hint."*

## Idiomatic MCP alternative

**MCP has no model-level "inform on update" mechanism.** The protocol is pull-only at the LLM tier:

| Use case | Idiomatic mechanism |
|---|---|
| Read current state | Tool call; honest-REPL on fresh server state per call |
| Entity field changed since last read | Next tool call returns new value automatically (honest-REPL) |
| Entity created / renamed / deleted | If structural enough: surface as tool-catalog mutation + `notifications/tools/list_changed`. Otherwise: honest-REPL on next call. |
| Stale-since-last-read hint | Embed in next tool response body (`:changed-at` metadata) |
| Real-time UI reactivity | **Not an MCP use case.** That's the studio chrome's job (MobX), separate channel. |

The autoregressive turn-based nature of LLMs means there's no useful "wake me mid-turn" mechanic. Between turns, fresh state arrives on the next tool call. The notification machinery in the MCP spec exists for client-UI catalog refreshes (tools list, prompts list, resources list), not for prompt-context injection.

**For arrival specifically: the existing discovery + action surface already implements honest-REPL.** `(tree (Component "Card"))` returns current state every call. Action batch mutations happen in the LLM's turn (it knows what it did). Between-turn human edits surface on the next discovery call. No notification needed; no subscribe needed.

The "MobX reaction → MCP subscription" isomorphism the original proposal got excited about is structurally correct — same primitive at different scopes — but the cross-process scope has no consumer in current client architecture. The MobX side stays load-bearing for studio chrome reactivity.

## What we kept

**As dormant infrastructure** (works correctly, just unwired):

- `foundations/arrival/arrival-mcp/src/resources/` — framework-level `ResourceProvider` interface + MIME constant
- `foundations/arrival/arrival-mcp/src/ArrivalServer.ts` — `resourceProvider?` option + handlers + `asMcpError` mapping
- `saas/server/arrival/src/PlexusResourceProvider.ts` — Plexus-backed implementation
- `saas/server/arrival/src/__tests__/resources/` — 13 tests, still passing
- `foundations/arrival/arrival-mcp/src/__research__/resource-attach-stub/` — day-1 verification stub

Total kept: ~250 LoC + tests. Pulled from production but reachable if the cohort ever shifts.

**As independently valuable substrate work** (kept wired, not resources-specific):

- `saas/server/api/src/routes/projects/[projectId]/snapshot/get.ts` — HTTP endpoint exposing the Yjs DO's `getSnapshot()` RPC. Bypasses the y-websocket sync dance for any server-side caller that needs read-only state. Independently valuable for tools, batch operations, or any future request/response server endpoint.
- `public-packages/api/src/SharedApi.ts:getPlexusSnapshot()` — client method calling that endpoint.

## What we pulled

- `saas/server/mcp/src/mcp-server.ts` — `resourceProvider: createPlexusResourceProvider()` option removed. MCP server no longer advertises `resources` capability.
- `~/Library/Application Support/Claude/claude_desktop_config.json` — `arrival-spike` entry removed.

## Re-open triggers (now narrower)

The proposal is **deferred indefinitely**, not "deferred until clients catch up." Specifically watch for:

- Anthropic publicly changes position on auto-injection of resource content into Claude Desktop / Claude Code prompts. ([typescript-sdk#686](https://github.com/modelcontextprotocol/typescript-sdk/issues/686) or [python-sdk#1016](https://github.com/modelcontextprotocol/python-sdk/issues/1016) reopened.)
- A mainstream MCP client we care about (Claude Code, Cursor) ships auto-read of resources into context.
- Anthropic adds a non-resources mechanism for "server-side state pushed into prompt" — sampling-as-context or a new primitive.

None of these are speculative — they're the specific shifts that would change the design space. Until then, all "user-attachable state" work goes through the discovery tool surface as getter-style functions.

## Cost summary

- **Production**: zero — wiring pulled, no surface area carrying the proposal's name reaches users
- **Substrate gain**: HTTP `/snapshot` endpoint + `SharedApi.getPlexusSnapshot()` — reusable for any future server-side read pattern
- **Dormant code**: ~250 LoC + tests, all green, ready to re-wire if triggers fire
- **Memory captured**: 2 entries (no-local-cache, client-UX gap) — class-of-error reusable for future MCP proposals

## Earlier draft history

This file went through several iterations:
- v1: full surface (read + subscribe + ephemerals + synthetic URIs + auto-derived catalog) — rejected by 4-lens reviews as spec-completionism
- v2: layered minimal + extended — rejected as premature subscribe commitment
- v3 (single doc, supercharger framing): committed; ran day-1 spike
- v4 (this file): deferred indefinitely after spike result

Git history preserves the earlier versions for anyone re-opening the file when triggers fire.
