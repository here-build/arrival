// index.ts — testable surface of the OpenAI-compatible server (part of primitive 2 minimal wiring).
// Everything except real-decode and cli (to avoid pulling the native addon in tests/harnesses).
// Provides the translation + shell so BFCL (primitive 3) can drive the constrained sampler.

export * from "./openai-types.js";
export { toolsToGrantEnv, type ToolGrant } from "./tool-env.js";
export { parseSchemeForms, parseSchemeCall, type ParsedArg, type ParsedCall } from "./scheme-parse.js";
export {
  schemeCallToToolCall,
  schemeCallsToToolCalls,
  makeCallIdMinter,
  type ToolShape,
} from "./scheme-translate.js";
export {
  renderToolPrompt,
  renderVerboseToolPrompt,
  renderCompactToolPrompt,
} from "./prompt-render.js";
export {
  handleChatCompletion,
  type DecodeFn,
  type DecodeArgs,
  type HandleOptions,
} from "./handler.js";
export { createOpenAIServer, type ServerOptions } from "./server.js";
export {
  ModelManager,
  type ModelManagerOptions,
  type ModelLease,
  type TimerScheduler,
} from "./model-manager.js";
export {
  resolveModelPath,
  listModelIds,
  presentGgufs,
  resolvableRosterModels,
  discoverModels,
  defaultSources,
  quantTierOf,
  resolveEnv,
  KNOWN_ROSTER,
  ROSTER_DIR,
  DEFAULT_LMSTUDIO_DIR,
  DEFAULT_OLLAMA_DIR,
  type QuantTier,
  type ResolveEnv,
  type ModelSource,
  type Source,
  type DiscoveredModel,
} from "./model-resolve.js";
export {
  selectPreloadSet,
  preloadBudgetBytes,
  type PreloadSelection,
} from "./preload.js";

// NOTE: `./real-decode.js` (the GPU path) and `./cli.js` (the runnable) are intentionally NOT re-exported —
// importing them pulls node-llama-cpp. Import them directly from their modules when wiring the real server.
