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

// ── Language service surface ──────────────────────────────────────────────────
// The "Scheme LSP with the TS LSP API" — the keystone consumable a CodeMirror
// extension, an MCP typecheck tool, or a Volar plugin builds on. The prelude
// assembler + the bidirectional position `Mapper` are exported too so a consumer
// can build its own compilation or remap coordinates directly.
export {
  createSchemeLanguageService,
  createSchemeLanguageServiceCore,
  type ServiceEnvironment,
  type SchemeLanguageService,
  type SchemeLanguageServiceOptions,
  type SchemeDiagnostic,
  type SchemeQuickInfo,
  type SchemeClassifiedSpan,
  type SchemeCompletionEntry,
  type SchemeDefinition,
} from "./language-service.js";
// Browser/fs-less runtimes: import `@here.build/arrival-type-lens/browser` —
// same service over build-time-generated bundles (prelude + TS default libs).
export { getPreludeFiles, PRELUDE_FILE, PROGRAM_FILE } from "./prelude.js";
export { Mapper, type Mapping, type Span, type LineCol } from "./span-map.js";
// The Σ∩T bridge — wrap a structural+Σ OracleScanner so its validSymbols() is type-narrowed by
// the lens. The node-side runner composes `narrowByType(sigmaScanner, ls)`; the sampler is unchanged.
export { narrowByType, type Scanner, type ScannerState, type TypeLens } from "./typed-scanner.js";
// The single-source seam — assemble the `host` option from a rosetta type registry
// (`[...env.__rosettaTypes__]`) so injected tools narrow both the candidate and slot sides.
export { assembleHostPrelude, type HostPrelude, type AssembleHostPreludeOptions } from "./host-prelude.js";
