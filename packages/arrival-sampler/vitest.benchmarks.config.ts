import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The __benchmarks__ category (see .claude/rules/tests.md): perf/scale measurements (the llama.cpp-Metal
// vs onnx-CPU runner benchmark), opt-in via `pnpm benchmarks` — downloads a real GGUF and runs real
// inference on the GPU. Never in default CI.
//
// arrival's oracle (`makeOracle`) and root (`exec`/`Environment`/`LexicalScope`/`capabilities`)
// are resolved to SOURCE via aliases — the package is not built. Since the move to
// `foundations/arrival/arrival-sampler`, the interpreter is the sibling `../arrival`.
const arrivalRoot = "../../../../arrival/packages/arrival/src";
const oracleSrc = fileURLToPath(new URL(`${arrivalRoot}/oracle/index.ts`, import.meta.url));
const schemeSrc = fileURLToPath(new URL(`${arrivalRoot}/index.ts`, import.meta.url));

export default defineConfig({
  // Pulling arrival's SOURCE through the alias makes esbuild try to read arrival's own tsconfig.json,
  // whose `extends` chain (`@here.build/tsconfig/env/browser`) is not installed in arrival's nm tree in
  // this worktree. We transpile with an inline empty tsconfig so esbuild never walks that chain.
  esbuild: { tsconfigRaw: "{}" },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/benchmarks/**/*.test.ts"],
    testTimeout: 1_200_000,
    hookTimeout: 1_200_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@inhuman.tools/arrival/oracle": oracleSrc,
      "@inhuman.tools/arrival": schemeSrc,
    },
  },
});
