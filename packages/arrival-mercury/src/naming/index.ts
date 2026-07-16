/** NAMING — the E1a census/allocation phase (engine plan §2 E1a), plus E1b's
 *  import materialization (engine plan §2 E1b — the dissolved `frame/` pass's
 *  replacement). See census.ts for the decision-bearing view, allocate.ts for
 *  the lexical-namer adapter, materialize.ts for the commit step
 *  walker/walk.ts drives internally, imports.ts for the RuntimeRef→Ref commit
 *  the real pipeline drives one phase later (after LEGIBILITY/ASYNC-IFY —
 *  see imports.ts's header for why). */
export { bindingCensusOf } from "./census.js";
export { allocateNames } from "./allocate.js";
export { materializeNames } from "./materialize.js";
export { materializeImports, MaterializeImportsDoorError, type MaterializeImportsOptions } from "./imports.js";
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
