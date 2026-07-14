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

// ── the new pipeline's front end (copy-as-chunk, constitution §4.5) + CoreForm IR ──
export { desugar } from "./front/desugar.js";
export {
  type Atom,
  head,
  isAtom,
  isBool,
  isKeyword,
  isList,
  isNil,
  isNumber,
  keywordName,
  type ListNode,
  type Node,
} from "./front/nodes.js";
export { parseSexprs } from "./front/parse.js";

// ── the TYPE pass — Law T + the §5.3 narrowing-form grammar (type-emit-lawt.md) ──
export {
  emitTypes,
  type EmitTypesOptions,
  type EmitTypesResult,
  type Mapping,
  narrowsMembersOf,
} from "./type-emit/index.js";

// ── the TYPEFACTS extraction — the tsc→facts membrane (typefacts-extraction.md;
//    constitution §3.3/§5.3). `TypeFacts` re-exports @here.build/arrival/emit's
//    canonical vocabulary — one type, two readers, no adaptation layer. ──
export {
  type ClassifiedSource,
  type DeriveContext,
  deriveFacts,
  extractFacts,
  type ExtractFactsOptions,
  type FactsExtraction,
  hasFacts,
  type HoleReason,
  litFacts,
  quoteFacts,
  type TypeFacts,
} from "./typefacts/index.js";

// ── the engine walker (engine-walker.md; constitution §3.5/§4.2/§5.2) ──
export { runtimeRefsOf, walk, WalkDoorError, type WalkOptions } from "./walker/index.js";
export { render } from "./residual/render.js";
export type { CompilationUnit } from "./residual/types.js";

// ── the Contract.emit registry harvest (constitution §4.1/§4.5; registry-emit.md) ──
export {
  assertNarrowsWitnessed,
  dryActivation,
  type EmitRegistry,
  type EmitRegistryRow,
  emitRegistryOf,
} from "./registry/index.js";
export {
  type And,
  type App,
  type Base,
  type Begin,
  type Binding,
  classify,
  type ClassifyResult,
  type CoreForm,
  type Define,
  type DefineFn,
  type Dict,
  type Door,
  type DoorCategory,
  type If,
  type KwEntry,
  type Lambda,
  type Let,
  type LetKind,
  type Lit,
  type LitValue,
  type NamedLet,
  type NodeId,
  type Or,
  type Param,
  type Quote,
  type QuoteDatum,
  type Ref,
  type Require,
  type ScalarLit,
  type Span,
} from "./coreform/index.js";
