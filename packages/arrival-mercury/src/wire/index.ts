/** The static wire descriptor: the grammar (types.ts), the backward-walk deriver
 *  (derive.ts), and the seal's two structural checks (policy.ts). See derive.ts's
 *  header for the module's scope and docs/foundations/arrival-scheme/
 *  provenance-by-perturbation.md §3 for the design this implements. */
export { derive } from "./derive.js";
export {
  dataShaped,
  judgmentShaped,
  type LeafRole,
  verdictFor,
  type WireVerdict,
} from "./policy.js";
export type {
  Case,
  Hole,
  LeafDescriptor,
  LeafPath,
  LeafPathSegment,
  Literal,
  PVertice,
  WireArg,
  WireDescriptor,
  WireSource,
  WireStep,
} from "./types.js";
