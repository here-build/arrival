// prelude — assemble the virtual `.d.ts` file map the type-lens compilation needs.
//
// The lens type-checks emitted virtual TS against the SHARED PRE prelude
// (`prelude/types.d.ts`) plus every builtin leaf (`prelude/builtins/<slug>.d.ts`),
// declaration-merged into the single `interface ArrShape`. The `__tests__/`
// harnesses (builtins.test.ts / prelude.test.ts) already loaded these in-memory;
// this promotes that load into ONE reusable function so the language service, an
// MCP typecheck path, and a Volar plugin all build the same virtual file map.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the on-disk prelude under the shipped `src/` tree (tsc does not copy
// hand-written `.d.ts` into `dist/`). From `dist/prelude.js` that is `../src/
// prelude`; from `src/prelude.ts` (vitest/tsx) it is `./prelude`. Mirrors the
// path logic in `index.ts`.
const here = path.dirname(fileURLToPath(import.meta.url));
const isDist = here.endsWith("dist") || here.includes(`dist${path.sep}`);
const srcRoot = isDist ? path.join(here, "..", "src") : here;
const preludeDir = path.join(srcRoot, "prelude");
const builtinsDir = path.join(preludeDir, "builtins");

/** The virtual file name of the shared PRE prelude inside the lens file map. */
export const PRELUDE_FILE = "__pre.d.ts";

/** The virtual file name of the emitted program module inside the lens file map. */
export const PROGRAM_FILE = "__program.ts";

/**
 * Build the virtual `.d.ts` file map the lens compilation needs: the shared PRE
 * prelude under {@link PRELUDE_FILE}, plus every builtin leaf (`builtins/*.d.ts`,
 * excluding the `_TEMPLATE`/underscore-prefixed scaffolds) under a stable
 * `__leaf_<slug>.d.ts` key. Does NOT include the program module — the language
 * service adds the emitted `__program.ts` on top.
 *
 * Returns a fresh `Map` each call so a caller may mutate it (e.g. add the program
 * file) without affecting another compilation.
 */
export function getPreludeFiles(): Map<string, string> {
  const entries: [string, string][] = [[PRELUDE_FILE, readFileSync(path.join(preludeDir, "types.d.ts"), "utf8")]];
  for (const f of readdirSync(builtinsDir)) {
    if (!f.endsWith(".d.ts") || f.startsWith("_")) continue;
    entries.push([`__leaf_${f}`, readFileSync(path.join(builtinsDir, f), "utf8")]);
  }
  return new Map(entries);
}
