/** NAMING — the E1a census/allocation phase (engine plan §2 E1a). See
 *  census.ts for the decision-bearing view, allocate.ts for the lexical-namer
 *  adapter, materialize.ts for the commit step walker/walk.ts drives. */
export { bindingCensusOf } from "./census.js";
export { allocateNames } from "./allocate.js";
export { materializeNames } from "./materialize.js";
export { originOf, recordOrigin } from "./origin.js";
export type {
  BindingCensus,
  BindingOrigin,
  BindingSite,
  DestructureShape,
  EntityKind,
  NameAllocation,
  ScopeCensus,
} from "./types.js";
