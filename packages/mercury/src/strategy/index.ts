/**
 * The strategy registry, public surface — design doc §2 ("strategy = data").
 * See `opinions.ts` for the named-opinions census and `registry.ts` for the two
 * named strategies built from it.
 */
export {
  type Opinion,
  type OpinionAxis,
  type OpinionId,
  type OpinionStatus,
  type RuntimeOpinionId,
  RUNTIME_OPINIONS,
  TS_BASE_OPINIONS,
  type TsBaseOpinionId,
} from "./opinions.js";
export { DEFAULT_STRATEGY, hasOpinion, opinionsFor, resolveOpinion, type Strategy, STRATEGIES } from "./registry.js";
export { strategyHash } from "./hash.js";
