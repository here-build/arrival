// The interaction scope, sourced from its true home (env-roots) — not laundered through
// stdlib.ts. `inherit` is purely structural (no eager builtin read); native-root population
// is owned by `ensureBaseAssembled`, so this module doesn't need to drag stdlib into the
// import graph to be correct.
import { user_env as userEnv } from "./env-roots.js";

// The inference-plane base env: the totalic environment where models author and evaluate
// Scheme. NOT a security fence — the Graal-thesis sweep deleted every host-reaching verb
// (eval / load / set-obj! / set-special! / new / instanceof) at the source, so non-existence
// fences them, not a per-env block list. The only language-crossing door is the always-on
// polyglot membrane (`@` / `@?` / `@keys` + the interop member-access policy).
//
// This env INHERITS user_env (→ global_env), so the whole assembled base — numeric core,
// R7RS exception verbs, every native cluster, the polyglot membrane, `nil` (the LIPS `'()`
// alias, added in the polyglot base pack's prelude) — is reachable live by inheritance
// (resolvers walk child→parent). No builtin copy, no allowlist projection needed: the full
// env leaks nothing host-reaching post-sweep, and inheritance has none of the load-order
// races a snapshot-based allowlist would.
export const inferenceEnv = userEnv.inherit("inference");
