/**
 * LEGIBILITY — constitution §3.5's third-invention pass. Its three legs have
 * all now dissolved into VIEWS elsewhere, but this directory survives as the
 * shared structural substrate every dissolution kept reusing (never itself a
 * pass anymore):
 *  - destructure/singularize dissolved into ../naming/ at E1a (census.ts's
 *    use-shape analysis + allocate.ts's naming policy).
 *  - pure-region CSE (leg 3) dissolved into ../naming/shared-bindings.ts at
 *    E2 (engine plan §2 E2, second half) — a decision view
 *    (`sharedBindingsOf`) + its mechanical materializer
 *    (`materializeSharedBindings`), replacing the pass this file used to
 *    export as `pureRegionCse`/`legibility`.
 *
 * `tree.ts`'s `childrenOf`/`mapChildren`/`substituteBy`/`collectBoundNames`/
 * `mintFresh`/`mintReadable` and `names.ts`'s `elementNameOf` remain — every
 * dissolution above (naming/census.ts, naming/materialize.ts,
 * naming/imports.ts, naming/asyncness.ts, naming/shared-bindings.ts) imports
 * these directly rather than duplicating the `R`-children shape a fifth
 * time (tree.ts's own header). `elementNameOf` stays exported: census.ts
 * reuses it directly rather than duplicating the pluralize-backed
 * singular-name derivation.
 */
export { elementNameOf } from "./names.js";
