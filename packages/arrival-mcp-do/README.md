# @inhuman.tools/arrival-mcp-do

The Cloudflare Durable Object shell for [arrival-mcp](../arrival-mcp/) sessions: one DO per
session, hosting the MCP transport, replaying the handshake after hibernation, decomposing
`SessionRunState` over storage keys (the 128KB per-value limit is real), reaping idle
sessions on a TTL alarm, and serializing calls so a session never runs two programs at once.

This is packaging, not language. It carries no product semantics: a product extends the
abstract DO and supplies only its tool tier through the `buildTools` factory hook —
capabilities are closures armed at spin-up, never data at rest.

```ts
export class MyRunnerDO extends ArrivalMcpRunnerDO<MyEnv> {
  protected readonly serverInfo = { name: "my-mcp", version: "1.0.0" };
  protected readonly metaKey = "my-session-meta";
  protected buildTools(sessionId: string, sub: string, lifetime: AbortController) {
    return toolsOverCapabilities(myProjectCapability(this.env, sub), lifetime);
  }
}
```

See the [umbrella README](../../README.md) for where this sits in the arrival story.

Licensed FSL-1.1-MIT — see [LICENSE.md](./LICENSE.md) and the plain-words boundary in the
[arrival core README](../arrival/README.md).
