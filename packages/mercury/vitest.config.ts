import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the `@inhuman.tools/arrival-sugarcoat` lens to SOURCE in tests, so a freshly-added
// re-export (parseSexprs/Node) is picked up without rebuilding the package's dist.
// The lens is a runtime-free leaf (its own S-expr parser; only tiny-invariant), a
// directory sibling under arrival/packages/.
const sugarcoatSrc = fileURLToPath(new URL("../arrival-sugarcoat/src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@inhuman.tools/arrival-sugarcoat": sugarcoatSrc },
  },
});
