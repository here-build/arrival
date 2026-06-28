import { env as userEnv } from "./stdlib.js";

// The inference-plane base env: the totalic environment where models author and
// evaluate Scheme. NOT a security fence — the Graal-thesis sweep deleted every
// host-reaching verb (eval / load / set-obj! / set-special! / new / instanceof)
// at the source, so they no longer EXIST to be fenced. Non-existence is a stronger
// guarantee than a per-env block list. The only language-crossing door is the
// always-on polyglot membrane (`@` / `@?` / `@keys` + the interop member-access policy).
//
// This env INHERITS user_env (→ global_env), so the whole assembled base — the numeric
// core, the R7RS exception verbs, every native cluster (chars / strings / lists / …), and
// the polyglot `@`/`:key` membrane + the unbounded `c[ad]+r` family — is reachable live by
// inheritance (resolvers walk child→parent). No builtin copy, no allowlist projection:
// post-sweep the full env leaks nothing host-reaching, so the projection bought no safety,
// and inheritance has none of the load-order races a `SAFE_BUILTINS` snapshot did.
//
// The one binding the inference plane adds over the R7RS base — `nil` (the LIPS-dialect
// alias for `'()`) — is NO LONGER an inline `{ nil }` literal here. It is the `lips-compat`
// EnvCapability (env/lips-compat.ts), ASSEMBLED onto this env in the bootstrap chain
// (bridge.ts initBridge), the same `EnvCapability`/`assembleEnv` path the base stdlib uses.
// So the inference base = the assembled user_env base + the nil-compat capability — a
// declarative pack, not an imperative island.
export const inferenceEnv = userEnv.inherit("inference");
