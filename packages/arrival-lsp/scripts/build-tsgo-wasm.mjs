// build-tsgo-wasm — produce the .tsgo/ artifacts: typescript-go (TypeScript 7)
// compiled GOOS=js GOARCH=wasm, plus the matching Go wasm_exec runtimes.
//
// The upstream repo has NO official wasm target (explicitly Post-7.0,
// microsoft/typescript-go#3478) — but the source builds clean for js/wasm.
// We pin the exact commit (same one the @typescript/native-preview daily of
// the pin date was cut from) and build it ourselves: no third-party rebuild
// in the supply chain, reproducible by anyone with a Go toolchain.
//
// Outputs (gitignored — see the package .gitignore):
//   .tsgo/tsgo.wasm            the API/LSP/tsc server, libs embedded
//   .tsgo/wasm_exec.js         Go's js/wasm runtime glue (browser + node)
//   .tsgo/wasm_exec_node.js    the Node launcher shim
//   .tsgo/COMMIT               the pinned source commit (provenance)
//
// Usage: node scripts/build-tsgo-wasm.mjs  (requires git + Go ≥ the repo's go.mod)

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The pinned typescript-go commit — bump DELIBERATELY (the API protocol is
// unversioned upstream; a bump must re-run the tsgo-equivalence suite).
const PINNED_COMMIT = "cda7baffa96f0534d10f4cf4b909c0d06542cc0d";
const REPO = "https://github.com/microsoft/typescript-go";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "..", ".tsgo");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

const goroot = execFileSync("go", ["env", "GOROOT"]).toString().trim();

const work = mkdtempSync(path.join(tmpdir(), "tsgo-build-"));
try {
  console.log(`[build-tsgo-wasm] fetching ${REPO}@${PINNED_COMMIT}`);
  run("git", ["init", "-q", work]);
  run("git", ["-C", work, "remote", "add", "origin", REPO]);
  run("git", ["-C", work, "fetch", "-q", "--depth", "1", "origin", PINNED_COMMIT]);
  run("git", ["-C", work, "checkout", "-q", "FETCH_HEAD"]);

  console.log("[build-tsgo-wasm] go build (GOOS=js GOARCH=wasm) — takes a few minutes");
  mkdirSync(outDir, { recursive: true });
  run("go", ["build", "-o", path.join(outDir, "tsgo.wasm"), "./cmd/tsgo"], {
    cwd: work,
    env: { ...process.env, GOOS: "js", GOARCH: "wasm" },
  });

  for (const file of ["wasm_exec.js", "wasm_exec_node.js"]) {
    const src = path.join(goroot, "lib", "wasm", file);
    if (!existsSync(src)) throw new Error(`wasm_exec runtime not found at ${src} (Go ≥1.24 expected)`);
    copyFileSync(src, path.join(outDir, file));
  }
  writeFileSync(path.join(outDir, "COMMIT"), `${PINNED_COMMIT}\n`);
  console.log(`[build-tsgo-wasm] done → ${outDir}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
