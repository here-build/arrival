/**
 * @inhuman.tools/arrival-mercury-oracle — the differential-oracle harness for
 * arrival-mercury: `interpreter ≡ compiled` agreement (compile → tsx-import → run),
 * the corpus-row runner, and the shared error classifier.
 *
 * Node/CI only — this package owns the `tsx` runtime dependency (the compiled
 * artifact is imported through a tsx ESM loader to run it). The compiler
 * (`@inhuman.tools/arrival-mercury`) never depends on this package; the session-
 * assembly seam and value utilities it shares live DOWN in the compiler and are
 * re-exported here for a single oracle-side import surface.
 */
export { classifyCompiledError, classifyInterpreterError, type ErrorClass } from "./error-classifier.js";
export {
  agreementOf,
  assertProgramFace,
  cleanupOracleScratch,
  compileGreenfield,
  evalCompiled,
  type EvalCompiledOptions,
  evalInterpreter,
  greenfieldRegistryFor,
  openOracleSession,
  oracleEqual,
  OracleImportHangError,
  type OracleSession,
  type OracleSubject,
  type OracleVerdict,
  type Outcome,
  runOracle,
  show,
} from "./harness.js";
export { type CorpusVerdict, type ExpectedOutcome, outcomeMatches, runCorpusCase } from "./expected.js";
