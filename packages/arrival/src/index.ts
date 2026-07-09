// These names are re-exported explicitly (not via `export * from "./stdlib.js"`) so every
// export is visible at the barrel — no opaque star laundering an unknown name set:
//   • box / patch_value / quote — value-representation leaves (reader/values-repr.ts)
//   • global_env / env          — the native root + interaction scope (env-roots.ts)
//   • eof                       — the EOF singleton (values/primitives/EOF.ts)
// `exec` is exported explicitly below from generator-exec — the canonical stack-safe path.
export { box, patch_value, quote } from "./reader/values-repr.js";
export { global_env, user_env as env } from "./env-roots.js";
export { eof } from "./values/primitives/EOF.js";
// The inference-plane base env — every cross-package consumer inherits from it
// (`sandboxedEnv.inherit(name)`) and types against it (`ReturnType<typeof sandboxedEnv.inherit>`).
// `sandboxedEnv` is not a security sandbox — the name predates the Graal sweep that
// deleted the host-reaching verbs; kept for the one name external code actually uses.
export { inferenceEnv as sandboxedEnv } from "./inference-env.js";
// Interop sealing — `@arrival.private` (+ `markInteropBoundary`) marks a class opaque to
// a Scheme member-read (`(@ x :internal)` → nil). `markSandboxPrivate`/`markAsSandboxBoundary`
// are deprecated aliases kept for cross-package consumers (arrival-chain).
export { arrival, markInteropPrivate, markInteropBoundary } from "./interop-access.js";
export {
  markInteropPrivate as markSandboxPrivate,
  markInteropBoundary as markAsSandboxBoundary,
} from "./interop-access.js";
export { schemeToJs, jsToScheme, createRosettaWrapper, type RosettaFunction } from "./rosetta.js";

// Runtime value hierarchy. Provenance algebra: docs/spec/arrival-chain.md §5.
export { type AKind, AValue, EMPTY_PROVENANCE, pointProvenance, unionProvenance } from "./values/primitives/AValue.js";

// A* aliases for arrival-chain compatibility — both spellings work until L4
// deletes the draft AValue there. Re-exports live here (not in AValue.ts) to
// preserve the no-subtype-imports invariant — see the cycle note in AValue.ts.
export {
  ABool,
  schemeFalse as AFalse,
  schemeFalse,
  schemeTrue as ATrue,
  schemeTrue,
} from "./values/primitives/ABool.js";
export { AJSObject as AObject } from "./values/primitives/AJSObject.js";
// `AChar` is the legacy alias kept for cross-package consumers; `ACharacter` is
// the canonical class name. Both spellings resolve to the same class.
export { ACharacter, ACharacter as AChar } from "./values/primitives/ACharacter.js";

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
// The ONE invocation seam for any JS site calling a scheme callable: dispatches a
// callable VALUE's apply term, else a bare fn with a defined `this`. External packages
// resolving a verb off an env (e.g. the env-loader's require registry calling `ext/*/resolve`)
// MUST route through this — a bound native is an ANativeProcedure value, not `typeof === "function"`.
// `is_callable_value` is its guard.
export { applyCallback, type ACallable } from "./values/primitives/ACallable.js";
export { is_callable_value } from "./values/value-guards.js";
export { CONSTANT_CTX, makeRunContext, type RunContext, type HeapMeter } from "./values/primitives/RunContext.js";
// `SchemeValue` — the honest union of every value the interpreter can hold; a cross-package
// AST-walking consumer (mcp-substrate's statement-facts.ts) names this type in its own
// signatures when walking a real parsed form, not a plain-object `Node` shape.
export type { SchemeValue } from "./values/types.js";
// `AList` — the non-recursive `APair | ANil` scheme-list-spine alias. Public because
// mcp-substrate and arrival-chain import `APair`/`ANil` externally and spell this union
// out themselves today.
export type { AList } from "./values/types.js";

// No eager bootstrap. The runtime base assembles lazily on the first `exec` (the
// realm-cached `ensureBaseAssembled`, exposed as `initBridge` below) — importing the
// package doesn't fire an async assembly. Callers wanting the base warm early can
// `await initBridge()`.

// Classes that may be needed for type checking or extension
export { EOF as EOF } from "./values/primitives/EOF.js";
// Environment is INTERNAL-ONLY — the concrete scope-node is not part of the public
// surface (consumers type against the structural `SchemeEnv` below).

// Invocation-context metadata registry (the rosetta-type side-table), held off the
// scope-node, keyed by env. `rosettaTypesOf` is the type-lens harvest seam — studio
// derives its lens roster from `[...rosettaTypesOf(env)]`. (The sibling `rosettaPureOf`
// purity registry is DELETED — write-only after Q2/Q3 moved the static classifier onto
// the declared `.provenanceRole`; see docs/working-proposals/rosetta-registry-dissolution.md.)
export { rosettaTypesOf } from "./env-registries.js";

// The structural env contract cross-package packs/consumers type against (never the
// concrete `Environment` class) — re-surfaced from `./common/scheme-env.ts` (also
// reachable via the `@here.build/arrival/scheme-env` subpath) for barrel-style consumers.
export { type SchemeEnv, type RosettaSpec, type ResolverSpec } from "./common/scheme-env.js";

// Number system: AExact (rationals) and AInexact (floats/complex).
export { AExact } from "./values/primitives/AExact.js";
export { AInexact } from "./values/primitives/AInexact.js";
export { type ANumeric, parseNumber as parseNumber } from "./values/numbers.js";

// Former bridge.ts surface, re-exported from the real homes (bridge.ts — the
// LIPS-era monolith's last husk — is deleted; see env/r7rs/error-objects.ts's
// header for the lineage). `initBridge` stays the stable public name for
// "ensure the runtime base is assembled" (inhuman cli.ts and the smoke suites
// await it); it aliases the realm-cached `ensureBaseAssembled`.
export { coerceNumeric } from "./values/op-helpers.js";
export { wrappedOps } from "./env/r7rs/error-objects.js";
export { ensureBaseAssembled as initBridge } from "./eval/generator-exec.js";

// Generator-based evaluator: flat trampoline for stack safety and performance.
export {
  evaluate as evaluateGenerator,
  exec as execGenerator,
  ArrivalError,
  SchemePromise,
  is_scheme_promise,
  currentRunEnv,
  type EvalContext,
  type EvalGenerator,
  type EvalTap,
  type StackFrame,
} from "./eval/evaluator.js";
// `Invocation` moved to its own leaf (2026-07-09, the reverse-membrane migration's
// dynamic-call-site extraction — see `eval/dynamic-call-site.ts`'s header) so
// `rosetta.ts` can install one without importing the evaluator; re-exported from
// here unchanged for existing external importers of this package.
export type { Invocation } from "./eval/dynamic-call-site.js";

// Generator exec entry point (parser + generator evaluator) for string-to-value eval.
export {
  exec as execGeneratorFromString,
  parse as parseGenerator,
  execExpr as execGeneratorExpr,
  type ExecOptions,
} from "./eval/generator-exec.js";

// The lexical-binding scope handle, public for `exec({ scope })` — a caller holds a
// `LexicalScope.for(env)` across calls for REPL-style multi-step define accumulation.
export { LexicalScope } from "./eval/LexicalScope.js";

// The EnvCapability DECLARATION API — root-surfaced so a consumer declares a typed
// capability from ONE module specifier instead of fanning across `/capability` + `/env`
// + `/symbol` + `/scheme-zod`. Root-exposing the codecs alongside the `A*` classes they
// guard collapses both onto a single module graph — avoids the dual-package hazard where
// a subpath resolving to dist vs source makes `instanceof AString` reject cross-realm args.
// The `/symbol` + `/scheme-zod` subpaths stay (additive) for granular, tree-shaken imports.
//   • `EnvCapability` — the capability class (`exec({ capabilities })`, `assembleEnv` roots).
//   • `assembleEnv`   — the C3 kernel assembler that spins packs/capabilities onto a base env.
//   • `symbol`        — the typed-symbol factory ({ native, rosetta, tagless, … }).
//   • `z`             — the scheme-zod codec namespace, namespaced (not `export *`) so
//                       `z.symbol` (codec) stays distinct from the top-level `symbol` (factory).
export { EnvCapability } from "./common/capability.js";
export { assembleEnv } from "./common/kernel.js";
export { symbol } from "./common/symbol.js";
export type { RosettaSymbolDef } from "./common/symbol.js";
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
// ({env, dynamic_env, use_dynamic} shared, + signal/budgetMs/tap), so bare-`exec`
// callers gain a killable, bounded evaluator.
export { exec, parse, execState, type ExecState } from "./eval/generator-exec.js";

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
  stepKey,
  sameStep,
  countOpaqueNodes,
  CLASSIFIED_SPECIAL_FORMS,
  type LineageNode,
  type PathStep,
  type Bindings,
  type Classifier,
  type FieldResolution,
} from "./values/lineage.js";
export { classifierFromEnv } from "./values/lineage-classifier-from-env.js";
// Per-value auto-binding leaf-stamp (flag-gated, additive). Captures, per consumer
// invocation, the producer ids each read value carries, so the static carrier's leaf
// slots auto-bind to the right per-invocation producer without collapsing distinct
// invocations of one source name. Populated by EvalTrace.exit when attached.
export { AutoBindings, slotsOf } from "./values/lineage-auto-bindings.js";
// Deep provenance of a value — the union of `.provenance` over every reachable AValue
// (pair spine, vector, JS array elements). Containers are provenance-transparent, so this
// is THE read for "which points fed this packed value" (a pool of candidates, a list arg).
export { deepProvenance } from "./values/deep-provenance.js";
