import { defineConfig } from "vitest/config";

// This package is now a thin re-export shim over `@here.build/arrival`'s
// `/provenance` subpath (REWORK-DAG.md node C0) — every test that used to
// live here moved to core's `src/provenance/__tests__/`. `passWithNoTests`
// keeps `pnpm test` green for a package that legitimately has zero tests of
// its own (a pure re-export barrel has nothing to unit-test) rather than
// failing the turbo pipeline on "no test files found".
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
});
