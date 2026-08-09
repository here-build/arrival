#!/usr/bin/env node

// bin entry (`mcp-typescript-lsp`): boot the stdio MCP server; exit nonzero if startup throws.
import { TypeScriptLSPServer } from "./index.js";

async function main() {
  try {
    const server = new TypeScriptLSPServer();
    await server.start();
  } catch (error) {
    console.error("Failed to start TypeScript LSP MCP server:", error);
    process.exit(1);
  }
}

main().catch(console.error);
