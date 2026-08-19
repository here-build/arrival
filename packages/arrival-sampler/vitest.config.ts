import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// arrival-scheme exposes the oracle at src/oracle/index.ts, but its package `exports` map does not
// publish that subpath and `makeOracle` is not re-exported from the root. We must NOT edit
// arrival-scheme to wire this. So tests resolve the REAL `makeOracle` (and `Environment`, for the
// Σ-live grant env) via a SOURCE alias — the same source-alias pattern used for `@inhuman.tools/arrival-sugarcoat`
// directly. This is test-only; the runtime package depends on a structural OracleScanner type
// and an injected scanner value (see src/oracle-types.ts).
// arrival-scheme moved to foundations/arrival/arrival in the OSS reshuffle (package `@inhuman.tools/arrival`).
const oracleSrc = fileURLToPath(new URL("../../../../arrival/packages/arrival/src/oracle/index.ts", import.meta.url));
const schemeSrc = fileURLToPath(new URL("../../../../arrival/packages/arrival/src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/kernel/**/*.test.ts", "tests/runners/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@inhuman.tools/arrival/oracle": oracleSrc,
      "@inhuman.tools/arrival": schemeSrc,
    },
  },
});
