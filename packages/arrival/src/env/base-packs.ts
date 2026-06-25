// BASE_PACKS — the scheme stdlib as a capability set, the pack-assembled base.
//
// These are the `scheme/*` + `arrival/core-extensions` capabilities. `initBridge`
// ASSEMBLES them onto user_env (assembleEnv) — this IS the scheme-stdlib load path
// (it replaced the legacy hand-concatenated prelude string). Each pack's prelude +
// symbols + resolvers become the LIVE source of the env's scheme surface.
//
// `scheme/core` is the precedence floor (constants, purity doors, syntax-binding
// macros); everything else expands against it. The base preludes are verified
// mutually order-independent (no pack expands another's macro), so the C3
// application order is immaterial; explicit dep edges become necessary only once
// assembly targets a bare rawBase instead of the already-populated user_env.

import type { EnvCapability } from "../common/capability.js";
import core from "./core.js";
import polyglot from "./polyglot.js";
import { allR7rs } from "./r7rs/index.js";
import arrivalExtensions from "./arrival-extensions.js";
import { allSrfi } from "./srfi/index.js";

export const BASE_PACKS: readonly EnvCapability[] = [core, polyglot, ...allR7rs, arrivalExtensions, ...allSrfi];
