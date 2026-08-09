// Demo of MCP TypeScript LSP with s-expression output
// This shows what the output looks like for LLMs

console.log("=== MCP TypeScript LSP - S-Expression Output Examples ===\n");

console.log("When an LLM calls typescript:hover on 'service' variable:");
console.log(`
(hover "const service: UserService"
  :doc "An instance of UserService class")
`);

console.log("When an LLM calls typescript:definition on 'addUser':");
console.log(`
(definition "addUser"
  :file "/path/to/file.ts"
  :line 16
  :char 2
  :kind "method")
`);

console.log("When an LLM calls typescript:references on 'User' interface:");
console.log(`
(list
  (reference
    :file "/path/to/file.ts"
    :line 10
    :char 20
    :length 4
    :write false
    :definition false)
  (reference
    :file "/path/to/file.ts"
    :line 16
    :char 15
    :length 4
    :write false
    :definition false)
  (reference
    :file "/path/to/file.ts"
    :line 25
    :char 25
    :length 4
    :write false
    :definition false))
`);

console.log("When an LLM calls typescript:diagnostics:");
console.log(`
(diagnostic error "Type 'string' is not assignable to type 'number'"
  :file "/path/to/file.ts"
  :line 42
  :char 8
  :code 2322
  :length 15)
`);

console.log("When an LLM calls typescript:symbols:");
console.log(`
(list
  (symbol "User"
    :kind "interface"
    :line 3)
  (symbol "UserService"
    :kind "class"
    :line 9)
  (symbol "addUser"
    :kind "method"
    :line 16
    :parent "UserService")
  (symbol "findUser"
    :kind "method"
    :line 25
    :parent "UserService"))
`);

console.log("When an LLM calls typescript:completions:");
console.log(`
(list
  (completion "addUser"
    :kind "method"
    :detail "(method) UserService.addUser(user: User): void")
  (completion "findUser"
    :kind "method"
    :detail "(method) UserService.findUser(id: number): User | undefined")
  (completion "users"
    :kind "property"
    :detail "(property) UserService.users: User[]"))
`);

console.log("\n=== Benefits of S-Expression Output ===");
console.log("1. Clean, hierarchical structure - easy for LLMs to parse");
console.log("2. No JSON parsing needed - direct semantic representation");
console.log("3. Keywords (:file, :line) clearly distinguish metadata");
console.log("4. Operators (hover, definition) are unquoted - clear intent");
console.log("5. Compact yet readable format");
console.log("\nThis MCP server gives LLMs deep TypeScript understanding!");