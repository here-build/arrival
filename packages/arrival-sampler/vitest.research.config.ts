import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The __research__ category (see .claude/rules/tests.md): studies producing
// knowledge artifacts (logs/JSON in __research-output__/), opt-in via
// `pnpm research` — they download real models and run real inference.
//
// Same SOURCE alias to arrival-scheme as vitest.config.ts / vitest.custdev.config.ts: the package
// `exports` map does not publish the `/oracle` subpath and `makeOracle` is not re-exported from the
// root, so tests that build the Σ-live scanner resolve the REAL oracle + Environment via a source alias
// (the misprediction-metrics study needs `makeOracle(grantEnv)`).
// arrival-scheme moved to foundations/arrival/arrival in the OSS reshuffle (its package is
// `@inhuman.tools/arrival`); point the source alias at its real location.
const oracleSrc = fileURLToPath(new URL("../../../../arrival/packages/arrival/src/oracle/index.ts", import.meta.url));
const schemeSrc = fileURLToPath(new URL("../../../../arrival/packages/arrival/src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/research/**/*.test.ts", "tests/research/openai-server/**/*.test.ts"],
    // Generous bounds for the overnight run: loading an 8B q4f16 ONNX into onnxruntime-node, then slow
    // CPU greedy-constrained inference per task. Model weights are pre-fetched outside the loop, so the
    // hook only reads from the warm cache — but 8B is large; give it room.
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    // The study mutates a shared `rows` accumulator — single-file serial run.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@inhuman.tools/arrival/oracle": oracleSrc,
      "@inhuman.tools/arrival": schemeSrc,
    },
  },
});
