// `provenance/wireframe` — the PROSPECTIVE layer's builder core (Q8a). The template
// graph over a program's top-level defines + main expression: designated nodes per
// docs/PROVENANCE.md §1's vocabulary, wires as closed arrival lambdas emitted by
// `provenance/uneval.ts`'s `unevalWire`. Hash/path keying lands beside this at Q8b;
// loop interiors (binder backedges) land at Q8a′ (`loops.ts`); struct-fact wires +
// the count-demand router land at Q8c (`builder.ts`'s `factTagOf`, `loops.ts`'s
// `reachableNodesForDemand`).
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
// Q8b — hash/path keying (docs/PROVENANCE.md §5 D3; docs/PROVENANCE-PLAN.md Q8b).
export { hashGraph, siteHash, rootOrdinalPath, siteOf, MAIN_PROGRAM_SITE } from "./hash.js";
// Q8a′ — loop wireframing (docs/PROVENANCE.md §1/§2 `loop`; PROVENANCE-PLAN.md Q8a′).
// Q8c — the demand-graded variant (`reachableNodesForDemand`/`DemandGrade`) rides
// alongside it (same file, same V4 discipline).
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
