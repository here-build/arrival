/**
 * @inhuman.tools/arrival-mercury — the mercury differential-oracle harness.
 * Public surface per oracle-harness.md §2 (frozen interfaces), plus the
 * corpus-row runner the tier-1 bug-cell test consumes (§4.3's three-way check).
 */
export { classifyCompiledError, classifyInterpreterError, type ErrorClass } from "./oracle/error-classifier.js";
export {
  agreementOf,
  cleanupOracleScratch,
  evalCompiled,
  evalInterpreter,
  openOracleSession,
  oracleEqual,
  type OracleSession,
  type OracleVerdict,
  type Outcome,
  runOracle,
  show,
} from "./oracle/harness.js";
export { type CorpusVerdict, type ExpectedOutcome, outcomeMatches, runCorpusCase } from "./oracle/expected.js";
