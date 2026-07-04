// @here.build/arrival/env/polyglot-rich-errors — the NAMED sub-capability that
// owns RICH ERRORS for well-known cross-dialect Lisp symbols. Two files, one
// concern (error intelligence, not implementation — `env/polyglot.ts` owns the
// real bindings):
//
//   ./stubs.ts    — the EnvCapability: well-known-but-unimplemented symbols,
//                   bound as `symbol.notImplemented` teaching doors. Registered
//                   in `base-packs.ts` (BASE_PACKS), same as any other pack.
//   ./registry.ts — the well-known-symbol DATA TABLE + `richErrorFor`, consumed
//                   directly by the arrival-side unbound-variable throw sites
//                   (`Environment.ts`, `eval/Resolver.ts`, `eval/evaluator.ts`) to
//                   enrich "Unbound variable" with a "did you mean `reduce`?"
//                   hint when the miss is a close typo of a famous symbol —
//                   whether that symbol is bound elsewhere, doored by `./stubs.ts`,
//                   or famous-but-genuinely-absent (e.g. SRFI-1's bare `fold`).
//
// This barrel is the STABLE import surface for external consumers (a later task
// wires the arrival-manifold's scope/tool door to `richErrorFor` + `WELL_KNOWN_SYMBOLS`
// too). `registry.ts` stays independently importable (zero deps, see its header) —
// the eval-layer throw sites import it directly, NOT through this barrel, to avoid
// pulling `./stubs.ts`'s `common/capability.js` → `eval/Macro.js` chain into a
// module that sits below `env/*` in the graph.

export { default } from "./stubs.js";
export { WELL_KNOWN_SYMBOLS, richErrorFor } from "./registry.js";
export type { WellKnownStatus, WellKnownSymbolEntry } from "./registry.js";
