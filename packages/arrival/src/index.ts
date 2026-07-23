// `@inhuman.tools/arrival` — the package root. TWO TIERS (V's minimal-surface ruling,
// docs/plans/stage-c-corpse-deletion.md §"V's minimal-surface ruling" + §"Export restructure"):
//
//   1. THIS BARREL is the PUBLIC surface — small on purpose, closed to three concerns:
//        • EVAL — `exec`/`execState`/`parse` + their options/state types, scope continuity
//          (`LexicalScope`/`SessionScope`), run identity (`RunContext`/`disposeRunContext`), and
//          the membrane crossing (`schemeToJs`/`schemeToJsUntyped`/`jsToScheme`/`ANil`).
//        • CAPABILITY AUTHORING — `EnvCapability`/`symbol`/`z`/`SymbolDeclaration`/
//          `RosettaSymbolDef` — the one contract every palette pack (and every external
//          capability author) declares against.
//        • PROVENANCE AS DATA — `EvalTap`/`deepProvenance`/`EMPTY_PROVENANCE`: readings are
//          data (plain records + a tap subscription), never a class hierarchy or an analysis
//          function — see the arrival design theorem.
//        Plus `ArrivalError`/`SchemeValue`/`Invocation` — the error root and the two structural
//        types a capability author's own signatures need to name.
//        GROUNDING FACT: every consumer of this package today is a SIBLING PACKAGE — zero
//        end-user imports exist anywhere. The old, much wider barrel was an internal contract
//        wearing a public-API costume; this restructure is the correction.
//
//   2. `*-internals` SUBPATHS are SIBLING CONTRACTS, not this tier — the `-internals` NAME is
//      itself the no-stability-contract signal: `/reflect-internals` (the value-class
//      hierarchy, for tree-walking consumers), `/lsp-internals` (static analysis — tokenize,
//      validate, type, oracle), `/host-internals` (run observability, the mid-run assembly
//      kernel, the structural `SchemeEnv` contract, interop sealing). Each may change shape
//      whenever the machinery behind it does; importing one is an explicit "I depend on
//      arrival's internals" declaration, not an accident of barrel breadth.
//
// No eager bootstrap: importing this package fires no assembly at all. The self-hosted
// `Vocabulary` (env/vocabulary.ts) is built lazily, per capability-set tuple, memoized.

// ── EVAL ─────────────────────────────────────────────────────────────────────────────────────
// The generator-based evaluator: flat trampoline for stack safety and performance. `exec`/
// `parse`/`execState` are the canonical, stack-safe, budget-bounded path.
export { exec, parse, execState, type ExecState } from "./eval/generator-exec.js";
export { type ExecOptions } from "./eval/generator-exec.js";

// The lexical-binding scope handle, public for `exec({ scope })` — a caller holds a
// `LexicalScope.for(env)` across calls for REPL-style multi-step define accumulation.
// `SessionScope` is the refinement `LexicalScope.fresh()` mints (root frame carries the
// structural `SchemeEnv` write contract) — session products name it (arrival-run's
// `ArrivalSession.scope`, chain-env's `ChainEnv`).
export { LexicalScope, type SessionScope } from "./eval/LexicalScope.js";

// Run identity: `CONSTANT_CTX`/`HeapMeter` and the run cache/effect-log/read-guard families
// live on `/host-internals` now (host-integration machinery, not eval itself) — `RunContext`
// and its explicit teardown door stay here, since `exec({ runCtx })`'s REUSE case is an eval
// concern every host needs, not an internals sibling-contract.
export { RunContext } from "./run/RunContext.js";
export { disposeRunContext } from "./run/run-lifecycle.js";

// The membrane crossing — `exec`'s own return values are ALREADY crossed; these are for a host
// building its own JS↔Scheme bridge around a run (e.g. handing a JS value to `{ scope }`
// accumulation, or reading a crossed callback's result back out by hand).
export { schemeToJs, schemeToJsUntyped, jsToScheme } from "./membrane/rosetta.js";
// The membrane's null/absent leaf — crossed both ways, so it travels with the eval surface
// rather than the value-class reflection tier (`/reflect-internals`).
export { ANil } from "./values/primitives/ANil.js";

// ── CAPABILITY AUTHORING ─────────────────────────────────────────────────────────────────────
// `EnvCapability` — the capability class (`exec({ capabilities })` roots). `symbol` — the
// typed-symbol factory ({ native, rosetta, tagless, … }). `z` — the scheme-zod codec namespace,
// namespaced (not `export *`) so `z.symbol` (codec) stays distinct from the top-level `symbol`
// (factory).
export { EnvCapability } from "./common/capability.js";
export { symbol } from "./common/symbol.js";
export type { RosettaSymbolDef } from "./common/symbols/_bake.js";
export type { SymbolDeclaration } from "./common/capability.js";
export * as z from "./common/scheme-zod.js";

// ── PROVENANCE AS DATA ───────────────────────────────────────────────────────────────────────
// `EvalTap` — the tap subscription a host arms to observe a run's readings as they're produced.
export { type EvalTap } from "./eval/evaluator.js";
// Deep provenance of a value — the union of `.provenance` over every reachable `AValue` (pair
// spine, vector, JS array elements). Containers are provenance-transparent, so this is THE read
// for "which points fed this packed value".
export { deepProvenance } from "./provenance/deep-provenance.js";
export { EMPTY_PROVENANCE } from "./values/primitives/AValue.js";

// ── STRUCTURAL TYPES A CAPABILITY AUTHOR NAMES DIRECTLY ─────────────────────────────────────
// `SchemeValue` — the honest union of every value the interpreter can hold; a capability
// author's own signatures (and a cross-package AST-walking consumer) name this type directly
// rather than reaching into `/reflect-internals` for a union they can spell themselves.
export type { SchemeValue } from "./values/types.js";
// `Invocation` lives in its own leaf (`eval/dynamic-call-site.ts`) so `rosetta.ts` can install
// one without importing the evaluator; re-exported from here unchanged for existing importers.
export type { Invocation } from "./eval/dynamic-call-site.js";

// The error root — `ArrivalError` is the base every arrival error extends; a capability
// author's own error handling names it directly. `ErrorClass` (the `"arrival/error-category"`
// union every subclass must declare) is exported alongside it for the provenance
// analysis-stack relocation: `TraceArtifactVersionError` moved to arrival-provenance's
// `analysis/trace-artifact.ts` (its sole thrower) and, as an `ArrivalError` subclass
// defined outside this package, needs `ErrorClass` as a real cross-package type import
// instead of the in-package relative one every other subclass still uses.
export { ArrivalError, type ErrorClass } from "./errors.js";
