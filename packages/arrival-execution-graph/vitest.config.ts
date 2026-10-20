import { defineConfig } from "vitest/config";

// Whitelist, never an exclude list (.claude/rules/tests.md): the default gate runs exactly
// `src/__tests__/**/*.test.{ts,tsx}` (the GraphView render test is TSX), in jsdom.
export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
  },
});
