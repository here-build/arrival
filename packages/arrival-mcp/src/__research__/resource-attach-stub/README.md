# Day -1 attach verification spike

Purpose: verify Claude Desktop actually injects MCP resource content into the
prompt context when a human attaches via `@`-mention. Result determines whether
to proceed with `docs/proposals/in-flight/arrival-resources.md` or defer it.

## Run

### 1. Build the stub

From the repo root:

```bash
pnpm --filter @here.build/arrival-mcp build
```

The compiled stub will be at:

```
foundations/arrival/arrival-mcp/dist/__research__/resource-attach-stub/server.js
```

### 2. Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).
Add this server entry under `mcpServers`:

```json
{
  "mcpServers": {
    "arrival-spike": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/dappsnap/foundations/arrival/arrival-mcp/dist/__research__/resource-attach-stub/server.js"
      ]
    }
  }
}
```

Replace `/ABSOLUTE/PATH/TO/dappsnap` with the actual repo path on your machine.

Restart Claude Desktop. Look for the MCP server connection indicator (paperclip
or hammer icon, depending on UI version). The server should show as connected.

### 3. Verify the resource appears

In a new conversation, open the `@`-mention picker (or attach menu). Look for:

- A resource named "Card (spike test resource)" under the `arrival-spike` server
- It should be attachable with one click

### 4. Send a message and verify injection

Attach the resource. Send a simple message like:

```
What's in the resource I attached?
```

**Pass criterion**: Claude's response demonstrably references the JSON content
(mentions `"Card"`, `"TplComponent"`, the `tplTree`, etc.). This proves the
resource bytes landed in the prompt.

**Fail criterion**: Any of:

- Resource doesn't appear in the picker
- Attachment fails silently
- Claude responds as if nothing was attached
- Claude says it can't see resource content
- Error in Claude Desktop's MCP server log

## Pass = proceed

If pass, the proposal's load-bearing client-behavior assumption is verified.
Proceed to implement `arrival-resources.md` (~85 LoC + 3 tests).

## Fail = defer entire proposal

If fail, do NOT write the production code. Update the proposal's "Day -1
verification spike" section with what failed. Resource-attach is not yet a
real client feature; revisit when client behavior changes.

## Also try (cheap signal-multipliers)

- **Same spike in Claude Code (CLI)**: same config, different UI path. Establishes
  whether multiple Anthropic surfaces actually consume resources or only one.
- **Same spike in Cursor**: edit `~/Library/Application Support/Cursor/...`
  (or wherever Cursor's MCP config lives). Cursor is reported as partial; this
  tests how partial.
- **MCP Inspector** (`npx @modelcontextprotocol/inspector node /path/to/server.js`):
  proves the wire protocol works regardless of client behavior. Useful sanity
  check before blaming the spike for a Claude Desktop issue.

## Cleanup

After verification, remove the `arrival-spike` entry from
`claude_desktop_config.json` and restart Claude Desktop. The stub code itself
stays in the repo under `__research__/` as a regression reference — same way
other research probes live alongside `__tests__/`.
