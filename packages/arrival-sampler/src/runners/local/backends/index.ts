// backends/ — the BACKEND layer (model+sequence substrate a strategy drives).
//
// LlamaDecodeBackend and ScriptedDecodeBackend. The tier strategies live here because they reach
// concrete llama sequence operations.

export type { DecodeBackend } from "./common/types.js";
export { LlamaDecodeBackend } from "./LlamaDecodeBackend.js";
export { ScriptedDecodeBackend, type ScriptEntry, type ScriptedBackendSpec } from "./ScriptedDecodeBackend.js";
export { makeBranchStrategy, makeLookaheadStrategy } from "./llama/tier-strategies.js";
