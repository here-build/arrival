// @here.build/arrival/srfi — the unified SRFI palette.
//
// Every SRFI we ship as a scheme-bootstrap capability, importable from ONE subpath:
//   import { srfi1, srfi43, allSrfi } from "@here.build/arrival/srfi";
//
// Each is a module-singleton `EnvCapability` (prelude, baked `symbols`, or both).
// Assemble individually, pick a subset, or assemble the whole set via `allSrfi`.

import srfi1 from "./srfi-1.js";
import srfi2 from "./srfi-2.js";
import srfi8 from "./srfi-8.js";
import srfi13 from "./srfi-13.js";
import srfi26 from "./srfi-26.js";
import srfi28 from "./srfi-28.js";
import srfi43 from "./srfi-43.js";
import srfi128 from "./srfi-128.js";
import srfi95 from "./srfi-95.js";
import srfi151 from "./srfi-151.js";
import srfi189 from "./srfi-189.js";
import srfi235 from "./srfi-235.js";
import srfiStubs from "./srfi-stubs.js";

export { default as srfi1 } from "./srfi-1.js";
export { default as srfi2 } from "./srfi-2.js";
export { default as srfi8 } from "./srfi-8.js";
export { default as srfi13 } from "./srfi-13.js";
export { default as srfi26 } from "./srfi-26.js";
export { default as srfi28 } from "./srfi-28.js";
export { default as srfi43 } from "./srfi-43.js";
export { default as srfi128 } from "./srfi-128.js";
export { default as srfi95 } from "./srfi-95.js";
export { default as srfi151 } from "./srfi-151.js";
export { default as srfi189 } from "./srfi-189.js";
export { default as srfi235 } from "./srfi-235.js";
export { default as srfiStubs } from "./srfi-stubs.js";

/** The whole SRFI set — assemble all, or `.filter()` a capability-scoped subset. */
export const allSrfi = [srfi1, srfi2, srfi8, srfi13, srfi26, srfi28, srfi43, srfi95, srfi128, srfi151, srfi189, srfi235, srfiStubs] as const;
