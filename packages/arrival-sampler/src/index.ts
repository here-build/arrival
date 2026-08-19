// @inhuman.tools/arrival-sampler — the substrate-free kernel (primitive 1).
//
// Exports the pure static constrained-decoding logic: structural + Σ gates, `isCandidateLive`,
// `selectConstrainedStep`, contracts, and supporting utilities.
//
// Masks a model's per-step choices with the arrival oracle so it cannot emit a malformed or
// unbound Scheme/MCP call. The headline guarantee: an UNBOUND OPERATOR is ungeneratable (Σ-live),
// and an unbalanced program is uncloseable (the EOS gate).
//
// The decode loop + GGUF/Metal runtime (primitive 2) live in the `./server` and `./decode` subpaths;
// this entry exports only the pure kernel + contracts that any backend can use.

export { compileMask, isCandidateLive } from "./mask-compiler.js";
export type { Tokenizer, TokenMask, ToolCallProfile } from "./mask-compiler.js";

export { forcedSymbol } from "./force-emit.js";
export type { ForcedSymbol } from "./force-emit.js";

export type { OracleScanner, OracleState, CursorPosition, FormKind } from "./oracle-types.js";

// The ONE per-step constrained decision the bounded top-K path and the node-llama-cpp prob-ranked loop
// share: collect live candidates up to keepN, widen, structural-fallback, EOS-if-closeable. The O(K)
// kernel (vs the eager O(vocab) compileMask) that makes constrained decoding real-time.
export { selectConstrainedStep } from "./select-constrained-step.js";
export type { SelectConstrainedStepArgs } from "./select-constrained-step.js";

export { narrowByTypeAsync } from "./typed-scanner-async.js";
export type { AsyncTypeLens, AsyncTypedScanner } from "./typed-scanner-async.js";

// The per-decode-step EXPLAIN data contract + the SHARED pure bucketer (substrate-free).
// The node llama server path (./server subpath) calls the SAME `buildStepExplain`, so the
// StepExplain wire shape is one. The browser `ExplainProcessor` path was retired; the current
// consumers are the llama decode loop + any explain UI.
export { buildStepExplain } from "./step-explain.js";
export type { StepExplain, OmittedToken, TokenPick, VetoReason } from "./step-explain.js";

// Isolation contract for this entry (primitive 1):
// - Must remain free of runtime dependencies on node, fs, llama, decode/, openai-server/.
// - All logic must be testable model-free (see src/__tests__/).
// - Consumers in primitive 2 supply the ranking + id↔string mapping.
