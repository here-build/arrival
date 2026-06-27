// The native root environments, created EMPTY here as a cycle-neutral leaf.
//
// `global_env` is arrival's native root; `user_env` is the interaction scope
// (`global_env.inherit("user-env")`) where top-level `exec` runs by default. They
// live HERE — not in the stdlib monolith — so the evaluator entry
// (eval/generator-exec.ts) and the bridge can source the root WITHOUT importing
// stdlib. stdlib imports these back and POPULATES global_env with its native
// builtins at module load (`Object.assign` onto `__env__`); the bridge bootstrap
// (`initBridge`) then layers the assembled packs + wrapped numeric ops on top.
//
// Creation and population are split so the root's IDENTITY is a leaf while its
// binding set is unchanged — the constructor stores `__env__` and runs no logic,
// so an empty root + post-hoc `Object.assign` is byte-identical to the old
// `new Environment("global", {...})`. This module imports ONLY Environment; like
// boot.ts it is a true leaf with no arrival-internal cycle.
import { Environment } from "./Environment.js";

export const global_env = new Environment("global", {}, undefined);
export const user_env = global_env.inherit("user-env");
