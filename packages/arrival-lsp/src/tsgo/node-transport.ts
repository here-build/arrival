// tsgo/node-transport — run the tsgo wasm build under Node as a child process
// (`node wasm_exec_node.js tsgo.wasm --api -async -callbacks …`) and expose its
// stdio as a TsgoTransport.
//
// The artifacts live in the package-root `.tsgo/` directory — gitignored,
// produced by `scripts/build-tsgo-wasm.mjs` from the PINNED typescript-go
// commit (`.tsgo/COMMIT`). The wasm_exec*.js runtimes are copied from the SAME
// Go toolchain that built the wasm (they are version-coupled). A child process
// (not in-process vm) keeps Go's wasm_exec globals (`globalThis.fs`,
// `process`-patching) out of the host's globals — the browser worker transport
// will own those shims instead.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TsgoTransport } from "./client.js";

// package root: src/tsgo/ and dist/tsgo/ are both two levels down.
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..", "..");
const tsgoDir = path.join(packageRoot, ".tsgo");

export const TSGO_WASM_PATH = path.join(tsgoDir, "tsgo.wasm");
const WASM_EXEC_NODE = path.join(tsgoDir, "wasm_exec_node.js");

/** The FS callbacks the lens serves (all of them — the project is virtual). */
export const TSGO_CALLBACKS = "readFile,fileExists,directoryExists,getAccessibleEntries,realpath";

/** Is the locally-built wasm artifact present? (Tests loud-skip when absent —
 *  build it with `node scripts/build-tsgo-wasm.mjs`.) */
export function tsgoWasmAvailable(): boolean {
  return existsSync(TSGO_WASM_PATH) && existsSync(WASM_EXEC_NODE);
}

/** Spawn `tsgo --api` (async JSON-RPC protocol) as a wasm child under Node. */
export function spawnTsgoNodeTransport(options?: { cwd?: string }): TsgoTransport {
  if (!tsgoWasmAvailable()) {
    throw new Error(
      `tsgo: wasm artifacts missing under ${tsgoDir} — run \`node scripts/build-tsgo-wasm.mjs\` (needs a Go toolchain)`,
    );
  }
  const child = spawn(
    process.execPath,
    [
      WASM_EXEC_NODE,
      TSGO_WASM_PATH,
      "--api",
      "-async",
      "-callbacks",
      TSGO_CALLBACKS,
      "-cwd",
      options?.cwd ?? "/virtual",
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  let exitCallback: ((reason: string) => void) | null = null;
  child.on("exit", (code, signal) => exitCallback?.(`code=${code} signal=${signal}`));
  child.on("error", (error) => exitCallback?.(String(error)));
  return {
    write: (data) => void child.stdin.write(data),
    onData: (callback) => void child.stdout.on("data", callback),
    onExit: (callback) => {
      exitCallback = callback;
    },
    close: () => void child.kill(),
  };
}
