// The native root environments — created EMPTY here as a cycle-neutral leaf
// (this module imports ONLY AmbientRuntime; like boot.ts it has no arrival-internal
// cycle). Population is owned entirely by `ensureBaseAssembled`
// (eval/generator-exec.ts), lazily on first exec, realm-cached: no module-load
// side effects, so the package keeps `sideEffects: false`.
//
// WHY TWO ROOTS — the two-phase bootstrap:
//   phase 1: NATIVE_PACKS (TS-implemented builtins — numeric core, lists,
//            strings, equality, error-object predicates, …) assemble onto
//            `global_env` via assembleEnv;
//   phase 2: BASE_PACKS (the `.scm`-defined stdlib — core/macros/polyglot/
//            r7rs/srfi preludes) assemble onto `user_env`. Their preludes CALL
//            natives (`+`, `string-length`, …), which resolve child→parent
//            (`user_env → global_env`), so phase 1 must be live first.
// One root cannot host both: a `.scm` prelude evaluating onto the same frame
// its dependencies are still being assembled into would race the phase order.
//
// THE CONTRACT per root:
//   `global_env` — the native root. Write window: phase 1 only; nothing writes
//   here afterwards (no production `.set` on it exists outside assembly).
//   `user_env`  — the top of the DEFAULT capability base for bare `exec(code)`.
//   Write window: phase 2 (the BAKE) only. At the end of `ensureBaseAssembled`
//   the base SEALS into a frozen `CompiledResolutionChain` — the artifact every
//   default-path exec resolves builtins through; the sealed artifact has no
//   write surface, so the write window is a structural fact, not a convention.
//   Top-level user defines accumulate on the mutable SESSION FRAME above the
//   chain (generator-exec's realm-cached `defaultLexicalRoot` — REPL semantics
//   preserved exactly), never on this frame. Hermetic callers pass `{ env }`
//   (glass — live walk, unbaked by definition) or `{ capabilities }` (assembles
//   + seals a FRESH `mintFrame(user_env, ...)` child per call). The provenance
//   spec's hermetic replay envs likewise assemble fresh and never touch this
//   shared frame.
//
// The third root, `inferenceEnv` (exported as `sandboxedEnv`), lives in
// inference-env.ts: a structurally empty child of `user_env` giving the
// inference plane a stable identity boundary — model-authored definitions land
// in children of it, never on the shared interaction scope.
//
// Naming: snake_case `global_env`/`user_env` is LIPS heritage; the barrel
// re-exports `user_env as env` and keeps both spellings public — renaming is
// downstream churn with zero semantic gain, so the heritage names stay.
//
// Both roots are `ResolvingAmbient` — the baked-capability specialization that
// carries fallback resolvers (env-agnostic packs/kernel machinery register onto these
// two, never onto a plain lexical frame). Both are born through the module-internal
// minters (the monadic-birth ruling: no public constructor arm, no `inherit`) —
// `mintFrame`'s subtype-preserving dispatch makes `user_env` come out
// `ResolvingAmbient` too, with zero extra ceremony here.
import { mintFrame, mintResolvingFrame } from "./AmbientRuntime.js";

export const global_env = mintResolvingFrame("global");
export const user_env = mintFrame(global_env, "user-env");
