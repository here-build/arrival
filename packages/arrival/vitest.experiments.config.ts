import { defineConfig } from "vitest/config";

// `__experiments__/` — proof-of-concept spikes, opt-in (`pnpm experiments`), NEVER a
// CI gate. Current contents: the walking-driver
// emission-seam spike.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["src/__experiments__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
