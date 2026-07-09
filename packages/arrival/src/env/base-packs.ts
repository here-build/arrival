// BASE_PACKS — the scheme stdlib as a capability set, the pack-assembled base.
//
// These are the `scheme/*` capabilities. `initBridge` ASSEMBLES them onto user_env
// (assembleEnv) — this IS the scheme-stdlib load path. Each pack's prelude +
// symbols + resolvers become the LIVE source of the env's scheme surface.
//
// `scheme/core` is the precedence floor (constants, syntax-binding
// macros); everything else expands against it. The base preludes are verified
// mutually order-independent (no pack expands another's macro), so the C3
// application order is immaterial; explicit dep edges become necessary only once
// assembly targets a bare rawBase instead of the already-populated user_env.

import type { EnvCapability } from "../common/capability.js";
import core from "./core/core.js";
import polyglotStubs from "./polyglot-stubs.js";
import macros from "./macros.js";
import polyglot from "./polyglot.js";
import { allR7rs } from "./r7rs/index.js";
import { allSrfi } from "./srfi/index.js";

// `polyglotStubs` (env/polyglot-stubs.ts) is its OWN entry — NOT folded into
// `allSrfi` — because it is not a SRFI: it doors cross-dialect (Common Lisp /
// Racket / Clojure) symbols with no SRFI/R7RS lineage at all. See its header.
export const BASE_PACKS: readonly EnvCapability[] = [core, macros, polyglot, ...allR7rs, ...allSrfi, polyglotStubs];
