// tsgo/node-transport — run the tsgo wasm build under Node as a child process
// (`node wasm_exec_node.js tsgo.wasm --api -async -callbacks …`) and expose its
// stdio as a TsgoTransport.
//
// ARTIFACT RESOLUTION (first hit wins):
//   1. $TSGO_WASM — explicit override (benching a candidate artifact);
//   2. <package>/.tsgo/tsgo.wasm — the from-source build (gitignored;
//      `scripts/build-tsgo-wasm.mjs`, pinned commit in .tsgo/COMMIT) — the
//      verification path: no third party in the chain;
//   3. the `tsgo-wasm` npm package (sxzz's daily rebuild of UNMODIFIED
//      official source, SLSA-provenance-attested, no install scripts; its
//      package.json `main` IS the .wasm, so require.resolve gives the path).
// Builds are NOT byte-reproducible across Go toolchains (different size/hash
// for the same commit) — equivalence between 2 and 3 is BEHAVIORAL: the
// tsgo-equivalence suite is the gate, run it against both.
//
// The wasm_exec*.js runtimes are VENDORED at src/tsgo/runtime/ (committed —
// the npm-artifact path must work without a Go toolchain). They are
// version-coupled to the Go that BUILT the wasm only loosely (the JS ABI is
// stable across recent Go); the equivalence suite catches a real mismatch.
// A child process (not in-process vm) keeps wasm_exec's globals
// (`globalThis.fs`, `process`-patching) out of the host's globals — the
// browser worker transport owns those shims instead (browser-transport.ts).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TsgoTransport } from "./client.js";

// package root: src/tsgo/ and dist/tsgo/ are both two levels down. The
// vendored runtimes live under src/ (tsc copies only .ts into dist/) — the
// same dist→src hop prelude.ts uses for the .d.ts leaves.
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..", "..");
const isDist = here.endsWith(`${path.sep}dist${path.sep}tsgo`);
const runtimeDir = path.join(isDist ? path.join(packageRoot, "src") : path.join(here, ".."), "tsgo", "runtime");

const WASM_EXEC_NODE = path.join(runtimeDir, "wasm_exec_node.js");
const LOCAL_BUILD_WASM = path.join(packageRoot, ".tsgo", "tsgo.wasm");

/** The FS callbacks the lens serves (all of them — the project is virtual). */
export const TSGO_CALLBACKS = "readFile,fileExists,directoryExists,getAccessibleEntries,realpath";

/** Resolve the tsgo.wasm to run: $TSGO_WASM → local from-source build →
 *  the `tsgo-wasm` npm package. Null when none is available. */
export function resolveTsgoWasm(): string | null {
  const override = process.env["TSGO_WASM"];
  if (override !== undefined && override !== "") return existsSync(override) ? override : null;
  if (existsSync(LOCAL_BUILD_WASM)) return LOCAL_BUILD_WASM;
  try {
    // tsgo-wasm's package `main` is the .wasm itself.
    return createRequire(import.meta.url).resolve("tsgo-wasm");
  } catch {
    return null;
  }
}

/** Is a runnable wasm artifact present? (Tests loud-skip when absent.) */
export function tsgoWasmAvailable(): boolean {
  return resolveTsgoWasm() !== null && existsSync(WASM_EXEC_NODE);
}

/** Spawn `tsgo --api` (async JSON-RPC protocol) as a wasm child under Node. */
export function spawnTsgoNodeTransport(options?: { cwd?: string }): TsgoTransport {
  const wasm = resolveTsgoWasm();
  if (wasm === null) {
    throw new Error(
      "tsgo: no wasm artifact — install the `tsgo-wasm` package, run `node scripts/build-tsgo-wasm.mjs` (needs Go), or set $TSGO_WASM",
    );
  }
  const child = spawn(
    process.execPath,
    [WASM_EXEC_NODE, wasm, "--api", "-async", "-callbacks", TSGO_CALLBACKS, "-cwd", options?.cwd ?? "/virtual"],
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
