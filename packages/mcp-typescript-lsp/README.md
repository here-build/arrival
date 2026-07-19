# @inhuman.tools/mcp-typescript-lsp

MCP (Model Context Protocol) server wrapping the TypeScript Language Service, giving LLMs
semantic code intelligence — type inference, cross-file references, implementations, impact
analysis — that grep cannot provide. All results are s-expressions, for LLM reasoning.

Built as an [arrival-mcp](../arrival-mcp) **value-shaped tool** (`McpTool`: `name` /
`describe()` / `call()`) and registered via `registerTools` — the same path as
`DiscoveryTool` and `ActionTool`, not a hand-rolled server.

## Install

```bash
npm install -g @inhuman.tools/mcp-typescript-lsp   # global CLI
pnpm add @inhuman.tools/mcp-typescript-lsp          # or as a library
```

## Use as an MCP server (stdio)

```json
{ "servers": { "typescript-lsp": { "command": "mcp-typescript-lsp" } } }
```

## Use as a library (compose with other arrival-mcp tools)

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "@inhuman.tools/arrival-mcp";
import { TypeScriptIntelTool } from "@inhuman.tools/mcp-typescript-lsp";

const server = new McpServer({ name: "my-app", version: "0.1.0" }, { capabilities: { tools: {} } });
registerTools(server, [new TypeScriptIntelTool() /* , discovery, editing, … */]);
```

## The `typescript-intel` tool

One tool, dispatched by `action`. Parameters depend on the action's shape:

| shape | actions | key params |
|---|---|---|
| position | `hover`, `definition`, `references`, `completions`, `call-hierarchy`, `type-hierarchy`, `find-implementations` | `filePath` + `selector` (preferred) or `line`/`character` |
| file | `diagnostics`, `symbols` | `filePath`, optional `severity` |
| search | `search-symbol` | `projectRoot`, `query`, optional `kind` |
| impact | `impact-analysis` | `target`, optional `filePath`, `depth` (default 2, max 5), `includeTests`, `groupBy` (`file`/`component`/`flat`/`nested`) |

### Selectors

A `selector` locates a position by **exact source text** rather than line/character:

1. **Inline marker** — `"const service### = new"`: `###` marks the position.
2. **Occurrence** — `"UserService#2"`: the 2nd occurrence of `UserService`.
3. **Plain text** — `"addUser"`: the first occurrence.

The `###` marker is stripped before matching, so the text before + after it must match the
file verbatim. Add no quotes or characters that are not literally in the code:

```json
{ "selector": "export type Foo### =" }   // ✅ exact source
{ "selector": "export type Foo = {\"" }  // ❌ trailing quote not in the code
```

### Output shapes

Every action returns an s-expression. The shapes:

```clojure
(hover "const service: UserService"
  :doc "Service for managing users"
  :full-type "UserService"
  :expanded-type "{ getUser(id: string): User; updateUser(user: User): void; }"
  :tags (("param" "id - User identifier")))

(definition "add" :file "/path/to/math.ts" :line 5 :char 7 :kind "function")

(list (reference :file "/path/to/usage.ts" :line 20 :char 10 :length 3 :write false :definition false))

(list (diagnostic error "Type 'string' is not assignable to type 'number'"
  :file "/path/to/file.ts" :line 10 :char 5 :code 2322))

(list (symbol "MyClass" :kind "class" :line 5)
      (symbol "myMethod" :kind "method" :line 12 :parent "MyClass"))

(implementations UserRepository
  (implementation MongoUserRepository :file "/path/to/mongo-repo.ts" :line 5 :char 13)
  (abstract-implementation BaseRepository :file "/path/to/base-repo.ts" :line 3 :char 13))
```

`impact-analysis` groups by file (`groupBy: "file"`) or as dependency chains (`groupBy: "nested"`):

```clojure
(impact-analysis UserInterface
  (file "/path/to/services/UserService.ts"
    (class UserService :line 8) (method updateUser :line 15) (method deleteUser :line 22)))

(impact-analysis User
  (impacted getUser :kind method :file "service.ts" :line 5
    (impacted handleGetUser :kind method :file "controller.ts" :line 8
      (impacted setupRoutes :kind function :file "router.ts" :line 3))))
```

## Why not `DiscoveryTool` / `ActionTool`?

- **Not `DiscoveryTool`** — position/selector-based intel doesn't compose as env symbols, so
  the Scheme-REPL read tier is the wrong fit.
- **Not `ActionTool`** — that is the write tier (shared context, `["name", props]` bursts,
  partial-failure reports). This is pure read intel with a flat `{action, …}` surface; routing
  it through ActionTool would add batch/intent ceremony for no gain.
- **`McpTool` is the contract** — arrival-mcp's surface is structural: any value with
  `describe`/`call` registers identically.

## How it works

Uses the official TypeScript compiler API (`TSLanguageServiceWrapper`), auto-discovering
`tsconfig.json`. `TypeScriptIntelTool` is the `McpTool`; `TypeScriptLSPServer` is a thin stdio
shell over `McpServer` + `registerTools`. Output is lowered by `@inhuman.tools/arrival-serializer`.

## Develop

```bash
pnpm install
pnpm --filter @inhuman.tools/mcp-typescript-lsp build
pnpm --filter @inhuman.tools/mcp-typescript-lsp test
```

## License

[Functional Source License, Version 1.1, MIT Future License](./LICENSE.md).
