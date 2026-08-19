import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// __custdev__ — the LLM-as-user materialize matrix (opt-in, per .claude/rules/tests.md). Same
// source-alias to arrival-scheme as vitest.config.ts (the package `exports` map does not publish the
// `/oracle` subpath and `makeOracle` is not re-exported from the root; tests resolve the REAL oracle +
// runner via a SOURCE alias). This config whitelists ONLY src/__custdev__ and gives the real-model
// cells a long hook/test timeout (downloads + CPU inference).
// arrival-scheme moved to foundations/arrival/arrival in the OSS reshuffle (package `@inhuman.tools/arrival`);
// point the source alias at its real location.
const oracleSrc = fileURLToPath(new URL("../../../../arrival/packages/arrival/src/oracle/index.ts", import.meta.url));
const schemeSrc = fileURLToPath(new URL("../../../../arrival/packages/arrival/src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/custdev/**/*.test.ts"],
    // Real-model cells download + run on CPU; matrix-wide hooks load a model. Generous bounds.
    testTimeout: 120_000,
    hookTimeout: 600_000,
    // One process — models load once per row; parallel forks would re-download per worker.
    fileParallelism: false,
    // Live progress: a long real-model sweep must stream console.* to the terminal as it runs, not buffer
    // it behind the worker pool until the suite ends (the roster smoke's progress() relies on this).
    disableConsoleIntercept: true,
  },
  resolve: {
    alias: {
      "@inhuman.tools/arrival/oracle": oracleSrc,
      "@inhuman.tools/arrival": schemeSrc,
    },
  },
});
