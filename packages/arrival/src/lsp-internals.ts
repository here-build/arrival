// `@inhuman.tools/arrival/lsp-internals` — the STATIC-analysis tier: everything an editor
// service (arrival-lsp, mcp-typescript-lsp) or a discovery/roster reader needs to lex, validate,
// and type a program WITHOUT evaluating it. The `-internals` name is the no-stability-contract
// signal (V's minimal-surface ruling, docs/plans/stage-c-corpse-deletion.md §"V's minimal-surface
// ruling") — a sibling contract between arrival core and its editor-tooling packages, never the
// capability-authoring public surface. ONE lsp tier for now (the type-layer/static-validation/
// oracle split could grow its own subpaths later; nothing today itches enough to justify it).

// The reader lexer entry — `tokenize(source, true)` lifts source into meta-tokens off the real
// FSM lexer (so `#\(`, string literals, `#|…|#`, and quote prefixes count correctly).
export { tokenize } from "./reader/tokenize.js";

// The static validation pass — parsed forms × a sealed-chain vocabulary → the complete
// eslint-style Diagnostic list (never crash-on-first).
export { validateProgram, StaticValidationError, type Diagnostic } from "./static-validation/validate-program.js";
export { vocabularyFromChain, type ProgramVocabulary, type VocabularyEntry } from "./static-validation/vocabulary.js";

// The exec-phases products — phase 1 (parse) and phase 2.5 (the pure resolution-soundness pass
// over a sealed chain), previously reachable via the now-killed `/env` subpath.
export { parseProgram, validateAgainstResolution, type ParsedProgram } from "./eval/exec-phases.js";

// The rosetta-type registry side-table's harvest seam — an editor derives its lens roster from
// `[...rosettaTypesOf(env)]`. Off the package root (export restructure); this is its new home.
export { rosettaTypesOf } from "./env/env-registries.js";

// Capability-introspection reads: the contract-view projection (`contractOf`) and the
// prelude/symbol-define serializers a type-lens's ambient scheme vocabulary walks — the
// actually-assembled capability set, never a hand-picked subset.
export { contractOf, collectPrelude, collectSymbolDefines } from "./common/capability-internals.js";

// type-layer keeps: the Σ∩T narrow's flatten (so a hand-rolled `declare const` prints identically
// to a harvested signature), the diagnose lens, and the harvested-prelude assembly-from-signatures
// path (also reachable via `/type-layer` — additive, granular import).
export { sTagToTsType } from "./type-layer/schema-to-ts.js";
export { createDiagnoseLens, type DiagnoseLens, type RawMappedDiagnostic } from "./type-layer/diagnose.js";
export { assemblePreludeFromSignatures, type HarvestedPrelude } from "./type-layer/prelude.js";

// Oracle doors — the constraint-kernel oracle's Layer-S structural reader (Track A,
// sift/docs/CONSTRAINT-KERNEL-SPEC.md), the `/oracle` kill's new home (docs/plans/
// stage-c-corpse-deletion.md §"the /oracle kill"). `scan`'s return type (`ScanResult`) was
// file-local while `scan` itself already returned it — fixed here, exported properly alongside it.
export { scan, type ScanResult } from "./oracle/scanner.js";
export { makeOracle } from "./oracle/index.js";
export type {
  CursorPosition,
  EvalResult,
  FormKind,
  OracleEnv,
  OracleScanner,
  OracleSession,
  OracleState,
  TokenClass,
  TypeTag,
} from "./oracle/contract.js";
