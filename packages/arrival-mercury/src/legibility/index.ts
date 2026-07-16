/** LEGIBILITY — constitution §3.5's third-invention pass. As of E1a (engine
 *  plan §2 E1a), pure-region CSE is the only leg still living here —
 *  destructure/singularize dissolved into ../naming/ (census.ts's use-shape
 *  analysis + allocate.ts's naming policy; see legibility.ts's own header).
 *  `elementNameOf` stays exported: census.ts reuses it directly rather than
 *  duplicating the pluralize-backed singular-name derivation. */
export { pureRegionCse } from "./cse.js";
export { legibility, type LegibilityOptions } from "./legibility.js";
export { elementNameOf } from "./names.js";
