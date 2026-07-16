/** NAMING — the E1a census/allocation phase (engine plan §2 E1a), plus E1b's
 *  import materialization (engine plan §2 E1b — the dissolved `frame/` pass's
 *  replacement), E1c's asyncness materialization (engine plan §2 E1c —
 *  the dissolved `async-ify/` pass's replacement), and E2's shared-bindings
 *  materialization (engine plan §2 E2, second half — the dissolved
 *  `legibility/cse.ts` pass's replacement). See census.ts for the
 *  decision-bearing view, allocate.ts for the lexical-namer adapter,
 *  materialize.ts for the commit step walker/walk.ts drives internally,
 *  asyncness.ts for the asyncness view + its materializer (the real
 *  pipeline runs it one phase after the shared-bindings materializer),
 *  shared-bindings.ts for the CSE decision view + its materializer (the real
 *  pipeline runs it right after walk(), before the asyncness materializer —
 *  see that module's header for why), imports.ts for the RuntimeRef→Ref
 *  commit the real pipeline drives one phase after THAT (see imports.ts's
 *  header for why the ordering survives asyncIfy's dissolution). */
export { bindingCensusOf } from "./census.js";
export { allocateNames } from "./allocate.js";
export { materializeNames } from "./materialize.js";
export { materializeImports, MaterializeImportsDoorError, type MaterializeImportsOptions } from "./imports.js";
export {
  asyncnessOf,
  AsyncnessDoorError,
  materializeAsyncness,
  type AsyncnessFacts,
  type AsyncType,
  type FnDef,
} from "./asyncness.js";
export { materializeSharedBindings, sharedBindingsOf, type SharedBindingGroup, type SharedBindingsView } from "./shared-bindings.js";
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
