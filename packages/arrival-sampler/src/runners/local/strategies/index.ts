// strategies/ — STRATEGY layer (policy over kernel + backend).
//
// Different policies for how the LLM's distribution is turned into a search within the feasible set.
// Greedy (baseline), rollback, passthrough, etc. 

export type {
  ChoicePoint,
  DecodeContext,
  DecodeResult,
  DecodeStrategy,
  DecodeTelemetry,
  DescentHooks,
  DescentResult,
  FeasibleCand,
  IdPolyDecodeStrategy,
} from "./common/types.js";
export { GreedyStrategy } from "./GreedyStrategy.js";
export { PassthroughStrategy } from "./PassthroughStrategy.js";
export { makeRollbackStrategy, type RollbackTelemetry } from "./RollbackStrategy.js";
