// These names are re-exported explicitly (not via `export * from "./stdlib.js"`) so every
// export is visible at the barrel — no opaque star laundering an unknown name set:
//   • box / patch_value / quote — value-representation leaves (values/values-repr.ts)
//   • eof                       — the EOF singleton (values/primitives/EOF.ts)
// `exec` is exported explicitly below from generator-exec — the canonical stack-safe path.
//
// STAGE C CUT 3b retired the realm-singleton native/interaction roots (`global_env`/
// `user_env`, env-roots.ts) and the inference-plane base env (`sandboxedEnv`,
// inference-env.ts) along with the ambient path — there is no realm-parented env at all
// anymore. The instance surface those roots once exposed (`.inherit` / `.set` /
// `.defineRosetta`) decomposes into the declared doors:
//   • host vocabulary            → `exec({ capabilities })`
//   • a program's declared param → `define/overridable` (its own capability + config bag)
//   • define accumulation        → `exec({ scope })` + `LexicalScope.fresh()`
export { box, patch_value, quote } from "./values/values-repr.js";
export { eof } from "./values/primitives/EOF.js";
// Interop sealing — `@arrival.private` (+ `markInteropBoundary`) marks a class opaque to
// a Scheme member-read (`(@ x :internal)` → nil). `markAsSandboxBoundary` is a deprecated
// alias kept for a cross-package consumer (arrival-chain) that could not be verified dead —
// left in place (unlike its `markSandboxPrivate` sibling, confirmed zero-consumer and removed).
export { arrival, markInteropPrivate, markInteropBoundary } from "./membrane/interop-access.js";
export { markInteropBoundary as markAsSandboxBoundary } from "./membrane/interop-access.js";
export {
  schemeToJs,
  schemeToJsUntyped,
  jsToScheme,
  createRosettaWrapper,
  type RosettaFunction,
} from "./membrane/rosetta.js";

// Runtime value hierarchy. Provenance algebra: docs/spec/arrival-chain.md.
export { type AKind, AValue, EMPTY_PROVENANCE, pointProvenance, unionProvenance } from "./values/primitives/AValue.js";

// A* aliases for arrival-chain compatibility — both spellings work while
// arrival-chain still carries its own draft AValue. Re-exports live here (not in
// AValue.ts) to preserve the no-subtype-imports invariant — see the cycle note in AValue.ts.
export {
  ABool,
  schemeFalse as AFalse,
  schemeFalse,
  schemeTrue as ATrue,
  schemeTrue,
} from "./values/primitives/ABool.js";
export { ACharacter } from "./values/primitives/ACharacter.js";

// Canonical core-type re-exports, surfaced from their real home modules (not a
// star-export) to keep the public API identical and every name barrel-visible.
export { nil, ANil } from "./values/primitives/ANil.js";
export { theVoid, AVoid } from "./values/primitives/AVoid.js";
export { characters } from "./values/primitives/ACharacter.js";
export { ASymbol } from "./values/primitives/ASymbol.js";
export { AString } from "./values/primitives/AString.js";
export { APair } from "./values/primitives/APair.js";
// `AVector` — a cross-package AST-walking consumer (mcp-substrate's statement-facts.ts)
// needs `instanceof AVector` to distinguish a `[...]` literal from an ordinary cons list,
// same as `APair`/`ANil`/`AString`/`ASymbol` are exported for.
export { AVector } from "./values/primitives/AVector.js";
// `ADict` — the native open-key map AND the `{...}` dict-literal NODE face. Same
// cross-package AST-walking need as `AVector` above (mcp-substrate's statement-facts.ts
// distinguishes a `{...}` literal via `instanceof ADict` + `literalForms`).
export { ADict, type DictLiteralNode } from "./values/primitives/ADict.js";
// The ONE invocation seam for any JS site calling a scheme callable: dispatches a
// callable VALUE's apply term, else a bare fn with a defined `this`. External packages
// resolving a verb off an env (e.g. the env-loader's require registry calling `ext/*/resolve`)
// MUST route through this — a bound native is an ANativeProcedure value, not `typeof === "function"`.
// `is_callable_value` is its guard.
export { applyCallback, type ACallable } from "./values/primitives/ACallable.js";
export { is_callable_value } from "./values/value-guards.js";
export { CONSTANT_CTX, RunContext, type HeapMeter } from "./run/RunContext.js";
// STAGE 2 — the explicit RunContext teardown path (docs/execution.md §HERMETIC): a REPL host
// that reused a RunContext across passes (`exec(code, { runCtx })`) calls this at session end
// to tear down whatever capability resources (`common/capability.ts`'s
// `onRunContextDispose`-registered `windDownAll`/free-form dispose) accrued against it. `await using`ing a `new RunContext(...)`-minted RunContext calls the SAME function
// via its `[Symbol.asyncDispose]`; a self-minted (non-reused) RunContext is disposed
// automatically by `exec()`'s own `finally` — this export is for the REUSE case only.
export { disposeRunContext } from "./run/run-lifecycle.js";
// The first-class run cache (R2, arrival-mcp-rework-over-phases.md §2.2): a run's durable
// twin is (program, cache); `exec(src, { cache })` threads it onto the run's RunContext and
// the baked rosetta membrane records/replays through it. `canonicalJson`/`runCacheKey` are
// the NORMATIVE content-keying algorithm (the session layer reuses them for configDigest).
export {
  MemoryRunCache,
  canonicalJson,
  runCacheKey,
  type RunCache,
  type RunCacheEntry,
} from "./run/run-cache.js";
// The effect log (W1, arrival-plexus-effect-burst.md §2.3) + the read
// guard (W2, §2.4): `exec(src, { effects, reads })` gathers sink penetrations instead of firing
// them and (with `reads` armed) checks the read-your-deferred-write invariant. A host building a
// confirm-manifest (arrival-mcp's confirm-manifest.ts, arrival-provenance-confirmation.md) reads
// `EffectEntry`/`MemoryEffectLog` off this public surface rather than a deep relative import.
export { MemoryEffectLog, burst, BurstDrainError, type EffectEntry, type EffectLog } from "./run/effect-log.js";
export {
  MemoryReadTracker,
  checkReadWriteGuard,
  ReadYourDeferredWriteError,
  type ReadEvent,
  type ReadTracker,
  type ReadGuard,
  type WriteSetResolver,
} from "./run/read-guard.js";
// `SchemeValue` — the honest union of every value the interpreter can hold; a cross-package
// AST-walking consumer (mcp-substrate's statement-facts.ts) names this type in its own
// signatures when walking a real parsed form, not a plain-object `Node` shape.
export type { SchemeValue } from "./values/types.js";
// `AList` — the non-recursive `APair | ANil` scheme-list-spine alias. Public because
// mcp-substrate and arrival-chain import `APair`/`ANil` externally and spell this union
// out themselves today.
export type { AList } from "./values/types.js";

// No eager bootstrap. Stage C Cut 3b retired the realm-cached ambient bootstrap
// (`ensureBaseAssembled`/`initBridge`) along with the ambient path itself — the self-hosted
// `Vocabulary` (env/vocabulary.ts) is built lazily, per tuple, memoized by capability-set
// identity; importing the package doesn't fire any assembly at all.

// Classes that may be needed for type checking or extension
export { EOF as EOF } from "./values/primitives/EOF.js";
// AmbientRuntime is INTERNAL-ONLY — the concrete scope-node is not part of the public
// surface (consumers type against the structural `SchemeEnv` below).

// Invocation-context metadata registry (the rosetta-type side-table), held off the
// scope-node, keyed by env. `rosettaTypesOf` is the type-lens harvest seam — studio
// derives its lens roster from `[...rosettaTypesOf(env)]`.
export { rosettaTypesOf } from "./env/env-registries.js";

// The structural env contract cross-package packs/consumers type against (never the
// concrete `AmbientRuntime` class) — re-surfaced from `./common/scheme-env.ts` (also
// reachable via the `@inhuman.tools/arrival/scheme-env` subpath) for barrel-style consumers.
export { type SchemeEnv, type RosettaSpec, type ResolverSpec } from "./common/scheme-env.js";

// Number system: AExact (rationals) and AInexact (floats/complex).
export { AExact } from "./values/primitives/AExact.js";
export { AInexact } from "./values/primitives/AInexact.js";
export { type ANumeric, parseNumber as parseNumber } from "./values/numbers.js";

// `coerceNumeric` / `wrappedOps` re-surface from their real homes.
export { coerceNumeric } from "./values/op-helpers.js";
export { wrappedOps } from "./env/r7rs/error-objects.js";

// OFFENDING_VALUE (errors.ts) — symbol-keyed metadata a collection-type-error (take/
// map/vector-ref/reduce/car/…) carries naming the value it refused because it wasn't a
// collection at all. `offendingValueOf` is the one supported read path (bounded `.cause`
// walk); root-surfaced so a downstream teaching door (e.g. arrival-manifold's
// stringly-collection hint) can read it without a private subpath into errors.ts.
export {
  ArrivalError,
  attachOffendingValue,
  offendingValueOf,
  OFFENDING_VALUE,
  type ErrorClass,
} from "./errors.js";

// Generator-based evaluator: flat trampoline for stack safety and performance.
export { currentRunEnv, type EvalContext, type EvalTap, type StackFrame } from "./eval/evaluator.js";
// `Invocation` lives in its own leaf (`eval/dynamic-call-site.ts`) so `rosetta.ts`
// can install one without importing the evaluator; re-exported from here unchanged
// for existing external importers of this package.
export type { Invocation } from "./eval/dynamic-call-site.js";

// Generator exec entry point (parser + generator evaluator) for string-to-value eval.
export { parse as parseGenerator, type ExecOptions } from "./eval/generator-exec.js";

// The lexical-binding scope handle, public for `exec({ scope })` — a caller holds a
// `LexicalScope.for(env)` across calls for REPL-style multi-step define accumulation.
// `SessionScope` is the refinement `LexicalScope.fresh()` mints (root frame carries the
// structural `SchemeEnv` write contract) — session products name it (arrival-run's
// `ArrivalSession.scope`, chain-env's `ChainEnv`).
export { LexicalScope, type SessionScope } from "./eval/LexicalScope.js";

// The EnvCapability DECLARATION API — root-surfaced so a consumer declares a typed
// capability from ONE module specifier instead of fanning across `/capability` + `/env`
// + `/symbol` + `/scheme-zod`. Root-exposing the codecs alongside the `A*` classes they
// guard collapses both onto a single module graph — avoids the dual-package hazard where
// a subpath resolving to dist vs source makes `instanceof AString` reject cross-realm args.
// The `/symbol` + `/scheme-zod` subpaths stay (additive) for granular, tree-shaken imports.
//   • `EnvCapability` — the capability class (`exec({ capabilities })` roots). STAGE C CUT 4
//     retired `assembleEnv` (the bootstrap kernel assembler) — bootstrap assembly is
//     `buildVocabulary`/`assembleRun` now (`/env` subpath); `createRuntimeAssembler` (also
//     `/env`) survives for the MID-RUN `(require/extension :name)` path.
//   • `symbol`        — the typed-symbol factory ({ native, rosetta, tagless, … }).
//   • `z`             — the scheme-zod codec namespace, namespaced (not `export *`) so
//                       `z.symbol` (codec) stays distinct from the top-level `symbol` (factory).
export { EnvCapability } from "./common/capability.js";
export { symbol } from "./common/symbol.js";
export type { RosettaSymbolDef } from "./common/symbol.js";
export type { SymbolDeclaration } from "./common/capability.js";
export * as z from "./common/scheme-zod.js";

// Reader lexer entry. `tokenize(source, true)` lifts source into `{ token, col, offset, line }`
// meta-tokens off the real FSM lexer, so `#\(`, string literals, `#|…|#`, datum comments, and
// quote prefixes are counted correctly (a hand-scanner would miscount `#\(`). arrival-mcp's
// DiscoveryTool slices REPL top-level statements by token start-offsets — the reader is the one
// place that lexes Scheme faithfully, so it must consume the offsets rather than re-scan.
export { tokenize } from "./reader/tokenize.js";

// The public bare `exec`/`parse` resolve to the stack-safe, budget-bounded GENERATOR
// path — an explicit named export wins over a star-exported name of the same name.
// The generator `ExecOptions` is a strict superset of stdlib's exec options
// ({env} shared, + signal/budgetMs/tap), so bare-`exec` callers gain a killable,
// bounded evaluator.
export { exec, parse, execState, type ExecState } from "./eval/generator-exec.js";

// The STATIC VALIDATION PASS — the compiler's front door: parsed forms × a
// sealed-chain vocabulary → the COMPLETE eslint-style Diagnostic list (never
// crash-on-first). `exec({ staticValidation: "on" })` is the wired consumer;
// DiscoveryTool/MCP structured diagnostics and the codemirror LSP squiggles consume
// the same surface; mercury's roster mode can construct its own vocabulary from
// `EnvCapability.exports()`.
export { validateProgram, StaticValidationError, type Diagnostic } from "./static-validation/validate-program.js";
export {
  vocabularyFromChain,
  type ProgramVocabulary,
  type VocabularyEntry,
} from "./static-validation/vocabulary.js";

// Static lineage carrier — the STATIC analogue of the runtime provenance trace:
// `classify` builds a per-form lineage skeleton from the parsed AST (no eval); the
// cone/resolve queries answer the full-cone, the field-cone, and the field-point
// base+key that JOIN consumers read. Surfaced here so the consumer-equivalence
// shadow (above this package, alongside EvalTrace) can prove the static walk
// reproduces live field-points before the runtime mint is retired.
export {
  classify,
  fullCone,
  countCone,
  fieldCone,
  fieldResolve,
  countOpaqueNodes,
  CLASSIFIED_SPECIAL_FORMS,
  type LineageNode,
  type PathStep,
  type Bindings,
  type Classifier,
} from "./provenance/lineage.js";
export { classifierFromEnv } from "./provenance/lineage-classifier-from-env.js";
// Per-value auto-binding leaf-stamp (flag-gated, additive). Captures, per consumer
// invocation, the producer ids each read value carries, so the static carrier's leaf
// slots auto-bind to the right per-invocation producer without collapsing distinct
// invocations of one source name. Populated by EvalTrace.exit when attached.
export { AutoBindings, slotsOf } from "./provenance/lineage-auto-bindings.js";
// Deep provenance of a value — the union of `.provenance` over every reachable AValue
// (pair spine, vector, JS array elements). Containers are provenance-transparent, so this
// is THE read for "which points fed this packed value" (a pool of candidates, a list arg).
export { deepProvenance } from "./provenance/deep-provenance.js";

// The per-run model-facing note channel — a renderer (mcp-substrate) mints one and drains it.
export { createNoteSink, createDisplaySink, type NoteSink, type DisplaySink } from "./run/note-sink.js";
