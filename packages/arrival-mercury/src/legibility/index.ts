/** LEGIBILITY — the third-invention pass (constitution §3.5): implicit
 *  destruction + element-name singularization + pure-region CSE. See
 *  legibility.ts for the composed entry point and the pipeline-ordering
 *  rationale (a documented deviation from the constitution's high-level
 *  pipeline diagram). */
export { pureRegionCse } from "./cse.js";
export { destructureParams } from "./destructure.js";
export { legibility, type LegibilityOptions } from "./legibility.js";
export { elementNameOf } from "./names.js";
export { singularizeHofParams } from "./singularize.js";
