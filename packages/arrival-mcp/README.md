# @here.build/arrival-mcp

Build [Model Context Protocol](https://modelcontextprotocol.io) tools as **plain values** and register
them on the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
server. No bespoke server framework, no base classes to subclass — a tool is an object with `name`,
`describe()`, and `call()`.

Two tiers, two shapes:

- **`DiscoveryTool`** — the read tier. The actor sends a Scheme (Lisp) expression that runs in a
  sandboxed REPL over your capability's symbols. One round-trip explores arbitrarily deep — filter, map,
  compose — instead of N rigid getter calls.
- **`ActionTool`** — the mutation tier. The actor sends a *batch* of typed `[name, {props}]` actions that
  share one validated context scope and run sequentially, halting on the first failure with a **partial
  report**. Nothing is undone — there is no rollback; wrap the batch in your own transaction
  (`wrapBatch`) when the burst must be atomic.

`DiscoveryTool` derives its entire MCP surface (input schema, catalog, validation, eval) from one
**`McpEnvCapability`** — the verbs, their config, and the resources they read. `ActionTool` takes no
capability: it declares its own `context` + `actions` inline (mutation batches are typed field specs,
not a Scheme env).

## Install

```sh
pnpm add @here.build/arrival-mcp @modelcontextprotocol/sdk
```

## Discovery tool — a read sandbox

A capability declares **symbols** (the verbs), optional **configuration** (typed per-call args the actor
supplies), and optional **resources** (per-call host handles the verbs read). `DiscoveryTool` turns it
into a read-only Scheme REPL.

```ts
import { DiscoveryTool, McpEnvCapability } from "@here.build/arrival-mcp";

const capability = new McpEnvCapability("projects", {
  symbols: {
    user: {
      fn: () => db.currentUser(),
      description: "the current user",
      // Optional LIVE catalog text, resolved at tools/list — the per-session "welcome screen".
      dynamicDescription: async () => `the current user (${(await db.currentUser()).name})`,
    },
    projects: {
      fn: () => db.allProjects(),
      description: "every project the user can open",
    },
  },
});

const discovery = new DiscoveryTool("discover", capability, {
  description: "Read-only discovery sandbox.",
});

// A session is a plain { id, state } pair YOU keep across calls: `state` starts as {} and the
// tool stores the session's run log at state.__run__. Reuse the SAME object per session — that's
// what makes turn 2 see turn 1's defines. (A wrong shape — a bare id string, an object without
// `state` — is a teaching door naming this contract, not a deep TypeError.)
const session = { id: "s1", state: {} };

// The actor sends Scheme; each top-level form returns one message. Compose stdlib (filter / map /
// fold / lambda) over your verbs in a single call instead of N rigid getter round-trips.
await discovery.call({ expr: "(length (filter (lambda (p) #t) (projects)))" }, { session });
// → ["2"] — the result is an array of serialized s-expression strings, one per top-level form
```

The actor sees `user`, `projects` (plus the base Scheme stdlib) advertised in the tool's input schema,
and can compose them freely in one call. Resources auto-spawn on first touch and are read inside a verb
via `this.resources.<name>.live` (declare the verb with `function`, not an arrow, so `this` binds) —
authorization is simply a resource that refuses to spawn.

**Expressions the actor will actually write** — member access is the `(:key obj)` accessor (or
`(@ obj :key)`); there is no `get`:

```scheme
(:stage d)                                                      ; read one field
(map (lambda (p) (:name p)) (projects))                        ; project a field
(filter (lambda (p) (equal? (:stage p) "qualified")) (projects)) ; filter by field
(length (projects))                                             ; count
```

One honest scale note: a verb like `(projects)` **materializes its full result on the host** before
Scheme filters it — the composition saves round-trips, not host memory. For big tables, push the
predicate into the verb (`(projects-by-stage "qualified")`) instead of filtering a full pull.

And one honest security note: the sandbox is arrival's no-ambient-authority interpreter, and at
0.x the core package's Security Status applies — treat the REPL as a capability boundary, not a
hardened jail for hostile input.

Omit `session` entirely for a stateless one-shot call. The optional `intent` arg is free-text,
never validated — it's recorded on the `InteractionLog` and shown to collaborating users.

## Action tool — a batched mutation burst

Actions are declared with **`FieldSpec`** types (not bare zod), because a context/prop field may be a
**`Ref`** that resolves a UUID / name / instance against the *live* context (a `"Card"` → the actual
`Component`). zod `.transform()` can't see runtime context; refs can. The shared `context` is validated
**once per batch**, so N actions don't each re-declare it.

```ts
import { ActionTool, str, defineRef, uuidShape, nameShape } from "@here.build/arrival-mcp";

const componentRef = defineRef<Component, { site: Site }>({
  typeName: "Component",
  desc: "a component by uuid or name",
  shapes: [
    uuidShape((id, ctx) => ctx.site.componentByUuid(id)),
    nameShape((name, ctx) => ctx.site.componentByName(name)),
  ],
});

const editing = new ActionTool<{ projectId: string; component?: Component }, { site: Site }>("edit", {
  description: "Mutate the project.",
  context: { projectId: str("the project id"), component: componentRef },
  // Runs once per batch (after primitive ctx parses, before refs resolve). Returns an ENVELOPE:
  // { prep, cleanup? }. `prep`'s CONTENTS merge into the ctx every handler + ref sees — the key is
  // required, so `return { site }` bare merges nothing; `cleanup` (optional) always runs in
  // `finally`. Closes over your host infra — no separate services injection.
  prepare: async (ctx) => ({ prep: { site: await loadSite(ctx.projectId) } }),
  // Make the whole burst atomic (the canonical CRDT case: pause sync, run, flush once).
  wrapBatch: async (ctx, runBatch) => {
    await ctx.site.pauseSync();
    try {
      return await runBatch();
    } finally {
      await ctx.site.resumeSync();
    }
  },
  actions: (b) => [
    b.act({
      name: "rename",
      needs: ["component"], // narrows ctx.component to non-optional in the handler
      desc: "rename a component",
      props: { name: str("the new name") },
      handle: (ctx, _receiver, { name }) => ctx.component.rename(name),
    }),
  ],
});

// `session` is the same { id: string, state: {} } pair from the discovery example — one shape everywhere.
await editing.call(
  { intent: "tidy names", projectId: "p1", component: "Card", actions: [["rename", { name: "ProductCard" }]] },
  { session },
);
```

Extra power, all optional:

- **Clusters** (`defineCluster`) — author actions against a `Ctx` shape and compose groups: `clusters: [treeActions, styleActions, …]`.
- **Receiver-dispatch** — one action *name*, different handler per receiver class: `b.act({ name: "set", on: TplTag, … })` vs `on: TplComponent`. Dispatch is exact-class on `ctx[receiverKey]`.
- **`beforeDispatch`** — normalize ctx after refs resolve (e.g. default `element` to the component root).
- **`shapeResponse`** — customize the success envelope.
- **`timeouts` / `limits`** — per-phase deadlines + batch size caps.

A handler failure stops the batch and returns a partial report (`{ success: false, partial: true, executed, failedAction, … }`); a validation failure runs nothing. Actions already executed are **not** undone —
the report tells you exactly how far the batch got; atomicity is `wrapBatch`'s job (or a transaction you
own inside it).

## Registering on a server

`registerTools` wires any number of value tools onto an official `McpServer` — `describe()` → `tools/list`,
`call()` → `tools/call`, with results lowered by the one `serializeResult`. The catalog is dynamic
(re-`describe`d per `tools/list`, so the personalized welcome refreshes).

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "@here.build/arrival-mcp";

const server = new McpServer({ name: "my-app", version: "0.1.0" }, { capabilities: { tools: {} } });
registerTools(server, [discovery, editing], (params) => ({ session: resolveSession(params) }));
await server.connect(transport);
```

The optional resolver maps each call to its **`ToolCallCtx`** — `{ session, user, signal, record, store, onEvent }` —
which lives *above* the eval membrane, so a sandboxed run can't reach session identity or another call's
state. The transport's `AbortSignal` is threaded in automatically. Two honest notes on session identity:
the resolver receives the **raw MCP request params** — over stdio nothing populates a session id for you,
so a resolver that reads one from the params must fall back deliberately (a constant id collapses every
caller into one shared session; that may be exactly right for a single-user stdio server, and exactly
wrong multi-tenant). And without an injected `store`, session state lives in-memory on the `session.state`
object you supply — restart and it's gone; inject an `AsyncSessionStore` for durability.

## Surface

| Export | What it is |
|---|---|
| `McpEnvCapability` | The shared env: `symbols` (verbs), `configuration` (typed args), `resources`, `annotations`, its own `description`/`dynamicDescription`. |
| `DiscoveryTool` | `new DiscoveryTool(name, capability, { description?, budgetMs?, heapBudget?, statementCap?, attachmentQuota?, hostConfig?, exposableConfiguration? })` — the read REPL tier. `description` is a legacy override; omitted, the capability's own description wins. |
| `ActionTool` | `new ActionTool(name, { description, context, clusters?/actions?, prepare?, wrapBatch?, … })` — the batch mutation tier. |
| `tool` | Verb-authoring sugar over `symbol.rosetta`, tagged-template head (`` tool`name: doc` ``): bare `tool` (unclassified — always re-runs on replay), `tool.view` (cross-run cacheable boundary snapshot; demands a serializable output codec), `tool.pure` (deterministic from args — recovery is re-call, never persisted), `tool.effect` (mutation: `provenance: "sink"`, void result), `tool.risky` (`tool.effect` + `risky: true` metadata). |
| budgets | `DEFAULT_BUDGET_MS` (5 s wall-clock), `defaultHeapBudget()` (`ARRIVAL_HEAP_MAX`, 100 M cells), `defaultStatementCap()` (`MCP_SESSION_STATEMENT_CAP`, 512/session), `defaultAttachmentQuota()` (`MCP_ATTACHMENT_QUOTA`, 3/call). |
| session state | `SessionRunState` + `encodeSessionRunState`/`decodeSessionRunState`, `SessionRunCache`, `SESSION_SEMANTICS_EPOCH` — the session's durable twin (the thing living at `session.state.__run__`, or in your injected store). |
| the two stores | **Not interchangeable**: `ToolCallCtx.store` is an `AsyncSessionStore` (from `@here.build/mcp-substrate`) that persists the session's *run state*; `ArrivalSessionStore` / `InMemoryArrivalSessionStore` is the *interaction-record* store (who called what, phantom queries) fed by `ctx.record`. Wire "durable sessions" to the first, "audit what the agent did" to the second. |
| `defineCluster`, `Act`, `ActBuilder` | Compose action groups authored against a `Ctx` (`Act`/`ActBuilder` are type-only). |
| refs: `str` `num` `bool` `oneOf` `scalar` `stringRecord` `rawList` `optional` `defineRef` `uuidShape` `nameShape` `objectShape` `instanceShape` | The `FieldSpec` system backing action context + props (ctx-aware resolution). `uuidShape` is an *id*-shape: it matches any non-empty spaceless string (not RFC-4122) and falls through to `nameShape` on a resolve miss. |
| `registerTools`, `serializeResult` | Wire onto / lower for the official SDK server. |
| `MCPError`, `classifyError`, `withTimeout`, size limits | The typed error kernel used by dispatch (`classifyError` wraps any thrown value into a typed `MCPError` at egress). |

## Design

- **Tools are values, not subclasses.** A tool is `{ name, describe, call }`. Everything else (schema,
  catalog, eval) derives from the capability.
- **One faithful transport.** No custom wire protocol — the official SDK is the server; this package is
  the tool shape + the `registerTools` seam. Session state is not a protocol layer either: it's a plain
  value you own (`{ id, state }`), with the run log at `state.__run__` and optional durability through an
  injected `AsyncSessionStore` — the package never talks to the wire about it.
- **Intent over materialization.** Verbs wrap what the actor *means* (`rename`, `deploy`), never the
  plumbing underneath (sync pausing, z-index, release pins). The three host concerns enter at three
  distinct membrane times — eval (resources), dispatch (`ToolCallCtx`), describe (the welcome) — and never
  co-mingle.

## Develop

```sh
pnpm build       # tsc → dist
pnpm test        # vitest
pnpm typecheck
pnpm lint
```

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License; each version
converts to MIT two years after release. Same license and same plain-words boundary as
`@here.build/arrival` — see the core README's "What Competing Use means here" (your own
pipelines, agency work, and agents-as-users are always fair use). Questions: team@here.build
