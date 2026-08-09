/**
 * `@inhuman.tools/arrival-mercury/product` — the BROWSER-SAFE product-compile
 * surface (organ 1: `SchemeSemanticModel` → Residual → ts.factory emit).
 *
 * Exists for the same reason as the `/circuit` subpath: the root barrel
 * (`index.ts`) re-exports the oracle harness (`oracle/harness.ts` → `tsx/esm/api`)
 * and probe witness (`node:crypto`), both browser-poison — importing the root
 * under Vite hard-fails on `createRequire`/top-level `process.versions.node`.
 * `compile-source.ts` loads the harness LAZILY (only the no-registry default path
 * needs a node oracle), so this surface is transitively node-free: a browser
 * caller that injects a `registry` compiles here; one that omits it catches the
 * dynamic-import node failure. (env-quasi-packages.md: subpaths separate surfaces.)
 */
export {
  compileSource,
  type CompileRegister,
  type CompileSourceOptions,
  type CompileSourceResult,
} from "./compile-source.js";
