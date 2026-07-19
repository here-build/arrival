import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve under shipped `src/` (tsc does not copy .d.ts into dist/).
const here = path.dirname(fileURLToPath(import.meta.url));
const isDist = here.endsWith("dist") || here.includes(`${path.sep}dist${path.sep}`);
const srcRoot = isDist ? path.join(here, "..", "src") : here;

export const preludeDir = path.join(srcRoot, "prelude");
export const preludeTypesPath = path.join(preludeDir, "types.d.ts");
export const builtinsDir = path.join(preludeDir, "builtins");
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
  type SchemeRichCompletion,
  type SchemeCompletionContext,
  type SchemeDefinition,
} from "./language-service.js";

export { getPreludeFiles, PRELUDE_FILE, PROGRAM_FILE } from "./prelude.js";
export { Mapper, type Mapping, type Span, type LineCol } from "./span-map.js";
export { narrowByType, type Scanner, type ScannerState, type TypeLens } from "./typed-scanner.js";
export { assembleHostPrelude, type HostPrelude, type AssembleHostPreludeOptions } from "./host-prelude.js";
export { scanRequires, type RequireRef } from "./service-core.js";
