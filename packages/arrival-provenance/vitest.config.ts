import { defineConfig } from "vitest/config";

// Whitelist, never an exclude list (.claude/rules/tests.md): the default gate runs
// exactly `src/__tests__/**/*.test.ts`. The index/analysis shims re-export core
// (tested in core CI); this package's own suite covers its real modules (verdict.ts).
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
  },
});
