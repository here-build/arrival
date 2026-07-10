// `provenance/wireframe` — the PROSPECTIVE layer's builder core. The template
// graph over a program's top-level defines + main expression: designated nodes per
// the model's vocabulary, wires as closed arrival lambdas emitted by
// `provenance/uneval.ts`'s `unevalWire`. Hash/path keying lives beside this
// (`hash.ts`); loop interiors (binder backedges) live in `loops.ts`; struct-fact
// wires + the count-demand router live in `builder.ts`'s `factTagOf` and
// `loops.ts`'s `reachableNodesForDemand`.
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
// Hash/path keying.
export { hashGraph, siteHash, rootOrdinalPath, siteOf, MAIN_PROGRAM_SITE } from "./hash.js";
// Loop wireframing. The demand-graded variant (`reachableNodesForDemand`/
// `DemandGrade`) rides alongside it (same file, same visited-set discipline).
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
