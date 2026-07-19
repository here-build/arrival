import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // TEST-RUNNER-ONLY: the serializer's `SerializeOpts.format` extension lives in
      // src but not yet in the built dist. Patching the alias into tests exercises the
      // REAL post-rebuild behavior; live runners + built artifact keep resolving dist.
      // Remove once the next serializer dist rebuild lands.
      "@inhuman.tools/arrival-serializer": fileURLToPath(
        new URL("../../foundations/arrival/arrival-serializer/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
    testTimeout: 10000,
    hookTimeout: 10000,
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
  },
});
