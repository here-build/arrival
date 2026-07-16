import { defineConfig } from "vitest/config";

/**
 * Benchmarks config — opt-in. Default `pnpm test` does not run these; use
 * `pnpm benchmarks` (or `vitest run --config vitest.benchmarks.config.ts`).
 *
 * Per `.claude/rules/tests.md`: benchmarks live under `src/__benchmarks__/` and
 * are a first-class peer of `test`, not a variant of it. Mirrors
 * `inhuman/saas/mcp-worker/vitest.benchmarks.config.ts`.
 */
export default defineConfig({
  test: {
    include: ["src/__benchmarks__/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
