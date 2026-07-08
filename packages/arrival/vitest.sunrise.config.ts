import { defineConfig } from "vitest/config";

// SUNRISE runner — the v2 law suites (docs/test-suite-v2/DESIGN.md). Red is
// information here: gap rows are it.fails per the ledger; this runner is NOT
// the CI gate until cutover.
//
// Whitelist, not exclude: only the v2 family dirs under src/__tests__. `conformance/`,
// `doors/`, `agreement/` are named per DESIGN.md §2 but not yet populated — the glob
// pre-declares them so a new law file just has to land, no config edit required.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    include: [
      "src/__tests__/laws/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/__tests__/membrane/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/__tests__/provenance/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/__tests__/ledger/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/__tests__/conformance/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/__tests__/doors/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/__tests__/agreement/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
