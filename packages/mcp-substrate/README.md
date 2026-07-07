# @here.build/mcp-substrate

Session-scoped teaching apparatus for MCP Scheme REPL surfaces.

## Core concepts

- **Doors**: structured error enrichments (bare tool calls, unknown tools, unbound names,
  scope confusion, futility, signature echoes, etc.). Built at rejection time, rendered
  with per-shape first-occurrence verbosity.
- **Runner** (`createDoorsRunner`): the stateful orchestrator. Executes statements, applies
  doors, maintains history and futility tracking.
- **Session history**: replayable record of successful top-level `define`s.
- **Futility tracking**: detects repeated identical (or shape-identical) tool results and
  emits advisory "stop digging" notes.
- **Type hints** (optional): post-error delivery of relevant TS diagnostics lowered into
  the Scheme context.

## Usage

```ts
import { createDoorsRunner, KWARGS_STRATEGIES } from "@here.build/mcp-substrate";

const runner = createDoorsRunner({
  toolNaming: { toolName: "scheme", argName: "expr" },
  strategies: KWARGS_STRATEGIES,
  attachmentSink: mySink,
  // session and tracker can be injected for cross-rebuild persistence
});

const result = await runner.run({ expr, env, tools });
```

The package is designed to be env-lifecycle-agnostic and to survive world rebuilds when
the host injects shared `DoorSession` / `FutilityTracker` instances.

