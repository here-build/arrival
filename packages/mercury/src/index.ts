/**
 * Mercury — compilation for humans: a faithful, deterministic projection of
 * arrival-chain scheme into a target language. Phase 1: JS (read-view).
 */
export { projectToJs, projectToJsRaw, type ProjectOptions } from "./project.js";
export { sliceToTypeScript } from "./slice-to-ts.js";
export { formatJs } from "./format.js";
export { cleanName, nameCandidates } from "./names.js";
export { getPromptBackend, PROMPT_BACKENDS, type PromptBackend, type PromptModule } from "./prompt.js";
export type { PromptDoc, PromptInput } from "./prompt-ir.js";
export { compileProject, type CompileTarget, type EmittedFile } from "./compile-project.js";
export { emitTypes, type EmitTypesResult, type EmitTypesOptions, type Mapping } from "./types-emit.js";
export {
  DEFAULT_STRATEGY,
  hasOpinion,
  type Opinion,
  type OpinionAxis,
  type OpinionId,
  type OpinionStatus,
  opinionsFor,
  resolveOpinion,
  type RuntimeOpinionId,
  RUNTIME_OPINIONS,
  type Strategy,
  STRATEGIES,
  strategyHash,
  TS_BASE_OPINIONS,
  type TsBaseOpinionId,
} from "./strategy/index.js";
