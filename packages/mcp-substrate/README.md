# @inhuman.tools/mcp-substrate

Session-scoped teaching apparatus for MCP Scheme REPL surfaces: it turns rejections into
structured, self-limiting lessons and tracks when an actor is going in circles.

## Concepts

- **Doors** — structured error enrichments (bare tool call, unknown tool, unbound name, scope
  confusion, futility, signature echo, …). Built at rejection time, rendered with per-shape
  first-occurrence verbosity so a repeated shape doesn't re-teach.
- **Runner** (`createDoorsRunner`) — the stateful orchestrator: executes statements, applies
  doors, keeps session history and futility state across calls.
- **Session history** — replayable record of successful top-level `define`s.
- **Futility tracking** — detects repeated identical (or shape-identical) tool results and
  emits advisory "stop digging" notes.
- **Type hints** (optional) — post-error delivery of relevant TS diagnostics lowered into the
  Scheme context.

## Usage

```ts
import { createDoorsRunner, KWARGS_STRATEGIES } from "@inhuman.tools/mcp-substrate";

const runner = createDoorsRunner({
  toolNaming: { toolName: "scheme", argName: "expr" },
  strategies: KWARGS_STRATEGIES,
  attachmentSink: mySink,
  // Inject shared `session` (DoorSession) / `tracker` (FutilityTracker) to make teaching
  // state survive host world-rebuilds; omitted, each runner uses a private instance.
});

const result = await runner.run({ expr, ambient, scope, tools });
```

The runner is ambient/scope-lifecycle-agnostic — it holds no reference to how the ambient or scope was assembled.
