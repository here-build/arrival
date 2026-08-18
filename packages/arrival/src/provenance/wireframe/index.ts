// Prospective wireframe plane: designated nodes + pure wires as closed lambdas
// (`unevalWire`). Hash/path keying in `hash.ts`; loop interiors in `loops.ts`;
// struct-fact tags + count-demand routing in `builder.ts` / `loops.ts`.

export type {
  DefineTemplate,
  EmittedWire,
  Wire,
  WireConsumer,
  WireFact,
  WireFrame,
  WireFrameEntry,
  WireParam,
  WireSlot,
  WireframeGraph,
  WireframeNode,
  WireframeProgram,
} from "./types.js";
export { freeVars, type FreeVarsOptions } from "./free-vars.js";
export { buildWireframe, type WireframeBuildOptions } from "./builder.js";
export { hashGraph, siteHash, rootOrdinalPath, siteOf, MAIN_PROGRAM_SITE } from "./hash.js";
export {
  parseDoBindings,
  parseDoClause,
  reachableNodes,
  reachableNodesForDemand,
  EMPTY_DO_CLAUSE,
  type DoBinding,
  type DoClause,
  type DemandGrade,
} from "./loops.js";
