import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // TEMPORARY: env-guarded exit-hang census (no-op unless HANG_DEBUG=1). Revert
    // with src/__tests__/_hang-debug.setup.ts once the single-realm hang is found.
    setupFiles: ["./src/__tests__/_hang-debug.setup.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    include: ["src/**/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
