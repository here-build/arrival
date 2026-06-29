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
// `nil` (the LIPS-dialect alias for `'()`) — the one non-R7RS idiom the models reach for —
// is NOT added here. It lives in the polyglot base pack's prelude (env/polyglot.ts), assembled
// onto user_env with the rest of the base. This env is a user_env child, so it INHERITS `nil`
// (and every threading idiom, SRFI family, and native cluster) with no inference-only wiring at
// all. There is no `lips-compat` capability and no inference-plane assembly step — the inference
// base is simply `user_env.inherit`, the full assembled base reached by inheritance.
export const inferenceEnv = userEnv.inherit("inference");
