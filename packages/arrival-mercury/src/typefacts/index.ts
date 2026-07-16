/**
 * typefacts — the tsc→facts membrane (typefacts-extraction.md; constitution
 * §3.3/§5.3). `TypeFacts` itself is re-exported from `@here.build/arrival/emit`
 * (the canonical, dependency-free vocabulary emit rules consume) — this
 * component owns the EXTRACTION: the HoleReason taxonomy, the span→NodeId join,
 * the derivation rules, and the instantiated-signature probe.
 */
export { deriveFacts, litFacts, quoteFacts, type DeriveContext } from "./derive.js";
export { extractFacts, queryFacts } from "./extract.js";
export {
  type ClassifiedSource,
  type ExtractFactsOptions,
  type FactsExtraction,
  hasFacts,
  type HoleReason,
  type TypeFacts,
} from "./facts.js";
export { createFactsProgram, type FactsProgram, PRELUDE_FILE, PROGRAM_FILE } from "./lens-program.js";
