// `provenance/wireframe` — the PROSPECTIVE layer's builder core (Q8a). The template
// graph over a program's top-level defines + main expression: designated nodes per
// docs/PROVENANCE.md §1's vocabulary, wires as closed arrival lambdas emitted by
// `provenance/uneval.ts`'s `unevalWire`. Hash/path keying lands beside this at Q8b;
// loop interiors (binder backedges) land at Q8a′ (`loops.ts`); struct-fact wires at Q8c.
export type {
  DefineTemplate,
  EmittedWire,
  Wire,
  WireConsumer,
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
export {
  parseDoBindings,
  parseDoClause,
  reachableNodes,
  EMPTY_DO_CLAUSE,
  type DoBinding,
  type DoClause,
} from "./loops.js";
