# @here.build/mcp-typescript-lsp

MCP (Model Context Protocol) server that wraps TypeScript Language Server, providing semantic code analysis with s-expression output format.

## Features

This MCP server gives LLMs access to TypeScript's deep code understanding:

- **Type Information** - Get exact types at any position
- **Go to Definition** - Find where symbols are defined
- **Find References** - Locate all uses of a symbol
- **Diagnostics** - Type errors and warnings
- **Code Completion** - IntelliSense suggestions
- **Symbol Search** - Find classes, functions, etc.
- **Call Hierarchy** - Trace function calls
- **Type Hierarchy** - Explore inheritance
- **Impact Analysis** - Analyze the impact of changes to types/interfaces

All results are returned as s-expressions for optimal LLM reasoning.

## Installation

```bash
npm install -g @here.build/mcp-typescript-lsp
```

## Usage

### As MCP Server

Add to your MCP client configuration:

```json
{
  "servers": {
    "typescript-lsp": {
      "command": "mcp-typescript-lsp"
    }
  }
}
```

### Single Unified Tool

The server provides a single `typescript-lsp` tool with different actions. The parameters depend on the action type:

#### Position-based actions (hover, definition, references, completions, call-hierarchy, type-hierarchy)
```json
{
  "action": "hover",
  "filePath": "/path/to/file.ts",
  "selector": "const service###"   // Preferred: text-based selector
  // OR use deprecated line/character:
  "line": 10,
  "character": 15
}
```

#### File-based actions (diagnostics, symbols)
```json
{
  "action": "diagnostics",
  "filePath": "/path/to/file.ts",
  "severity": "error"              // Optional filter
}
```

#### Search action (search-symbol)
```json
{
  "action": "search-symbol",
  "projectRoot": "/path/to/project",
  "query": "UserService",
  "kind": "class"                  // Optional filter
}
```

#### Impact Analysis action
```json
{
  "action": "impact-analysis",
  "target": "UserInterface",       // Name of type/interface to analyze
  "filePath": "/path/to/types.ts", // Optional: file containing the target
  "depth": 2,                      // Optional: recursion depth (default: 2, max: 5)
  "includeTests": false,           // Optional: include test files (default: true)
  "groupBy": "file"                // Optional: "file", "component", or "flat" (default: "file")
}
```

### Selector Format

Instead of line/character coordinates, use text-based selectors:

1. **Inline marker**: `"const service### = new"` - The ### marks the exact position
2. **Occurrence marker**: `"UserService#2"` - Points to the 2nd occurrence of "UserService"
3. **Simple text**: `"addUser"` - Points to the first occurrence

#### Important Notes on Selectors

- The selector must contain the **exact text** as it appears in the file
- Don't add extra quotes or characters that aren't in the actual code
- The ### marker is removed when searching, so the before + after must match exactly

#### Common Mistakes

❌ **Wrong** - Adding extra quotes:
```json
{ "selector": "export type Foo = {\"" }  // Extra quote at the end
```

✅ **Correct** - Exact text only:
```json
{ "selector": "export type Foo### =" }   // Just the actual code
```

❌ **Wrong** - Including quotes that aren't in the code:
```json
{ "selector": "import { \"Foo\"### }" }  // Unless the code has literal quotes
```

✅ **Correct** - Match the actual syntax:
```json
{ "selector": "import { Foo### }" }      // What's actually in the file
```

### Action Examples

#### Hover (with enhanced type information)
```json
{
  "action": "hover",
  "filePath": "/path/to/file.ts",
  "selector": "const service### = new UserService()"
}
```
Output:
```clojure
(hover "const service: UserService"
  :doc "Service for managing users"
  :full-type "UserService"
  :expanded-type "{ getUser(id: string): User; updateUser(user: User): void; }"
  :tags (("param" "id - User identifier")))
```

#### Definition
```json
{
  "action": "definition",
  "filePath": "/path/to/file.ts",
  "selector": "service.add###User(testUser)"
}
```
Output:
```clojure
(definition "add"
  :file "/path/to/math.ts"
  :line 5
  :char 7
  :kind "function")
```

#### References
```json
{
  "action": "references",
  "filePath": "/path/to/file.ts",
  "line": 5,
  "character": 10
}
```
Output:
```clojure
(list
  (reference
    :file "/path/to/usage.ts"
    :line 20
    :char 10
    :length 3
    :write false
    :definition false))
```

#### Diagnostics
```json
{
  "action": "diagnostics",
  "filePath": "/path/to/file.ts",
  "severity": "error"  // optional filter
}
```
Output:
```clojure
(list
  (diagnostic error "Type 'string' is not assignable to type 'number'"
    :file "/path/to/file.ts"
    :line 10
    :char 5
    :code 2322))
```

#### Document Symbols
```json
{
  "action": "symbols",
  "filePath": "/path/to/file.ts"
}
```
Output:
```clojure
(list
  (symbol "MyClass"
    :kind "class"
    :line 5)
  (symbol "myMethod"
    :kind "method"
    :line 12
    :parent "MyClass"))
```

#### Search Symbols
```json
{
  "action": "search-symbol",
  "projectRoot": "/path/to/project",
  "query": "User",
  "kind": "interface"  // optional
}
```
Output:
```clojure
(list
  (symbol "UserInterface"
    :kind "interface"
    :line 10)
  (symbol "UserService"
    :kind "class"
    :line 25))
```

#### Impact Analysis

Flat format (groupBy: "file"):
```json
{
  "action": "impact-analysis",
  "target": "UserInterface",
  "filePath": "/path/to/types.ts",
  "depth": 2,
  "includeTests": false,
  "groupBy": "file"
}
```
Output:
```clojure
(impact-analysis UserInterface
  (file "/path/to/components/UserProfile.tsx"
    (module UserProfile :line 1)
    (class UserProfileComponent :line 5)
    (method render :line 10))
  (file "/path/to/services/UserService.ts"
    (module UserService :line 1)
    (class UserService :line 8)
    (method updateUser :line 15)
    (method deleteUser :line 22)))
```

Nested format (groupBy: "nested") - shows dependency chains:
```json
{
  "action": "impact-analysis", 
  "target": "User",
  "filePath": "/path/to/types.ts",
  "depth": 3,
  "groupBy": "nested"
}
```
Output:
```clojure
(impact-analysis User
  (imports service :file "/path/to/service.ts")
  (impacted getUser :kind method :file "service.ts" :line 5
    (impacted handleGetUser :kind method :file "controller.ts" :line 8
      (impacted setupRoutes :kind function :file "router.ts" :line 3)))
  (impacted updateUser :kind method :file "service.ts" :line 9
    (impacted handleUpdateUser :kind method :file "controller.ts" :line 12)))
```

#### Find Implementations
```json
{
  "action": "find-implementations",
  "filePath": "/path/to/repository.ts",
  "selector": "interface UserRepository###"
}
```
Output:
```clojure
(implementations UserRepository
  (implementation MongoUserRepository 
    :file "/path/to/mongo-repo.ts" :line 5 :char 13)
  (implementation PostgresUserRepository 
    :file "/path/to/postgres-repo.ts" :line 8 :char 13)
  (abstract-implementation BaseRepository
    :file "/path/to/base-repo.ts" :line 3 :char 13))
```

## How It Works

1. **TypeScript Language Service** - Uses the official TS compiler API
2. **Project Discovery** - Automatically finds tsconfig.json
3. **Incremental Updates** - Efficient file watching and caching
4. **S-Expression Output** - Results use Symbol.toSymbolicExpression protocol

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally
npm start
```

## Use Cases

- **Code Understanding** - Help LLMs understand TypeScript codebases
- **Refactoring** - Find all places that need updating
- **Documentation** - Extract type information and docs
- **Code Review** - Check for type errors and issues
- **Navigation** - Jump to definitions and references
- **Impact Analysis** - Understand ripple effects before making changes

## License

MIT
