// @here.build/arrival-type-lens — Wave A foundation entry.
//
// The substance of this package in Wave A is the ambient `.d.ts` prelude under
// `src/prelude/` (consumed as text by the lens and merged across the 34 leaf
// files), not a runtime surface. This module exposes the on-disk locations of the
// prelude so downstream waves (COMPOSE, the Volar language plugin, the MCP
// typecheck path) can read + concatenate them without re-deriving paths.

import path from "node:path";
import { fileURLToPath } from "node:url";

// The `.d.ts` prelude is ambient SOURCE (tsc does not copy hand-written `.d.ts`
// into `dist/`), so resolve it under the shipped `src/` tree. From `dist/index.js`
// that is `../src/prelude`; from `src/index.ts` (vitest/tsx) it is `./prelude`.
const here = path.dirname(fileURLToPath(import.meta.url));
const isDist = here.endsWith("dist") || here.includes(`dist${path.sep}`);
const srcRoot = isDist ? path.join(here, "..", "src") : here;

/** Directory holding the PRE prelude and its `builtins/` leaves. */
export const preludeDir: string = path.join(srcRoot, "prelude");

/** Absolute path to the shared PRE prelude (`types.d.ts`). */
export const preludeTypesPath: string = path.join(preludeDir, "types.d.ts");

/** Absolute path to the `builtins/` directory of merge-leaves. */
export const builtinsDir: string = path.join(preludeDir, "builtins");
