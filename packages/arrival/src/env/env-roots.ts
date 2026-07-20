// The native root environments — created EMPTY here as a cycle-neutral leaf
// (this module imports ONLY AmbientRuntime; like boot.ts it has no arrival-internal
// cycle). Population is owned entirely by `ensureBaseAssembled`
// (eval/generator-exec.ts), lazily on first exec, realm-cached: no module-load
// side effects, so the package keeps `sideEffects: false`.
//
// The two-root bootstrap is docs/environments.md §ASSEMBLY (why `global_env`'s
// NATIVE_PACKS must be live before `user_env`'s BASE_PACKS preludes evaluate — one
// root cannot host both) and §HERMETIC (each root seals into a frozen
// `CompiledResolutionChain`; the phase-1/phase-2 write windows). What is local to
// this site:
//
//   • `user_env` is the top of the DEFAULT capability base for bare `exec(code)`.
//     Top-level user defines land on the mutable SESSION FRAME above the sealed
//     chain (generator-exec's realm-cached `defaultLexicalRoot` — REPL semantics),
//     never on this frame. Hermetic callers pass `{ env }` (glass — live walk,
//     unbaked) or `{ capabilities }` (a FRESH `mintFrame(user_env, …)` child,
//     assembled + sealed per call); the provenance spec's hermetic replay envs
//     likewise assemble fresh and never touch this shared frame.
//   • The third root, `inferenceEnv` (exported as `sandboxedEnv`), lives in
//     inference-env.ts — a structurally empty child of `user_env`.
//   • Naming: snake_case `global_env`/`user_env` is LIPS heritage; the barrel
//     re-exports `user_env as env` and keeps both spellings public. The heritage
//     names stay — renaming is downstream churn with zero semantic gain.
//
// Both roots are `ResolvingAmbient` (the baked-capability specialization carrying
// fallback resolvers), born through the module-internal minters (§HERMETIC: no
// public constructor arm, no `inherit`); `mintFrame`'s subtype-preserving dispatch
// makes `user_env` come out `ResolvingAmbient` too, no ceremony here.
import { mintFrame, mintResolvingFrame } from "./AmbientRuntime.js";

export const global_env = mintResolvingFrame("global");
export const user_env = mintFrame(global_env, "user-env");
