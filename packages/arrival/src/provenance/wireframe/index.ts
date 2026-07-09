// `provenance/wireframe` — the PROSPECTIVE layer's builder core (Q8a). The template
// graph over a program's top-level defines + main expression: designated nodes per
// docs/PROVENANCE.md §1's vocabulary, wires as closed arrival lambdas emitted by
// `provenance/uneval.ts`'s `unevalWire`. Hash/path keying lands beside this at Q8b;
// loop interiors (binder backedges) at Q8a′; struct-fact wires at Q8c.
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
