import { defineConfig } from "vitest/config";

// SUNSET runner — the legacy suite, still the gate; retires per
// docs/test-suite-v2/REMOVAL-MANIFEST.md survivor rules.
//
// Whitelist, not exclude: the v2 law suites (src/__tests__/{laws,membrane,provenance,ledger,
// conformance,doors,agreement}/) live UNDER src/__tests__ too, so this config only whitelists
// the TOP-LEVEL files of src/__tests__ (never its subdirectories) plus every other package
// __tests__ dir, each of which stays flat (no subdirs) as of this split. See
// vitest.sunrise.config.ts for the v2 runner.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    include: [
      "src/__tests__/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/common/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/env/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/env/r7rs/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/env/srfi/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/type-layer/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/provenance/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
