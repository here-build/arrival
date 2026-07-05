// The historical `export * from "./stdlib.js"` is dissolved — stdlib.ts is no longer a
// re-export hub, just the native-root population side-effect (`Object.assign(global_env…)`,
// owned by `ensureBaseAssembled`). The names that rode that star are re-surfaced HERE,
// each traced in one hop to its real home, so the public surface is byte-identical AND
// every export is visible at the barrel (no opaque star laundering an unknown name set).
//   • box / patch_value / quote — value-representation leaves (reader/values-repr.ts)
//   • unpromise                 — promise util (utils/promises.ts)
//   • global_env / env          — the native root + interaction scope (env-roots.ts)
//   • eof                       — the EOF singleton (values/primitives/EOF.ts)
// (`exec` also rode the star; it is re-exported explicitly below from generator-exec, the
// canonical stack-safe path — that explicit export already shadowed the stdlib `exec`.)
export { box, patch_value, quote } from "./reader/values-repr.js";
export { unpromise } from "./utils/promises.js";
export { global_env, user_env as env } from "./env-roots.js";
export { eof } from "./values/primitives/EOF.js";
// The inference-plane base env — the assembled totalic env every cross-package
// consumer inherits from (`sandboxedEnv.inherit(name)`) and types against
// (`ReturnType<typeof sandboxedEnv.inherit>`). `sandboxedEnv` is the public name
// (it was never a security sandbox — the name predates the Graal sweep that deleted
// the host-reaching verbs). The `inferenceEnv` spelling was an internal-only alias
// with zero external importers; it is gone from the public surface, leaving the one
// name external code actually uses.
export { inferenceEnv as sandboxedEnv } from "./inference-env.js";
// Interop sealing — `@arrival.private` (+ the underlying `markInteropBoundary`), the correct,
// exported way to mark a class opaque to a Scheme member-read (`(@ x :internal)` → nil). The
// `markSandboxPrivate`/`markAsSandboxBoundary` spellings are deprecated pre-rename aliases kept
// for cross-package consumers (arrival-chain); they retarget to the interop-access names.
export { arrival, markInteropPrivate, markInteropBoundary } from "./interop-access.js";
export {
  markInteropPrivate as markSandboxPrivate,
  markInteropBoundary as markAsSandboxBoundary,
} from "./interop-access.js";
export {
  schemeToJs,
  jsToScheme,
  createRosettaWrapper,
  type RosettaFunction,
} from "./rosetta.js";

// Runtime value hierarchy. Provenance algebra: docs/spec/arrival-chain.md §5.
export {
  type AKind,
  AValue,
  EMPTY_PROVENANCE,
  pointProvenance,
  unionProvenance,
} from "./values/primitives/AValue.js";

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

// Canonical core-type re-exports. These used to ride the `export * from
// "./stdlib.js"` barrel via a re-export block at the bottom of lips.ts; that
// block was removed (barrel-ectomy) so these names are re-surfaced from their
// real home modules to keep the public API identical.
export { nil, ANil } from "./values/primitives/ANil.js";
export { theVoid, AVoid } from "./values/primitives/AVoid.js";
export { characters } from "./values/primitives/ACharacter.js";
export { ASymbol } from "./values/primitives/ASymbol.js";
export { AString } from "./values/primitives/AString.js";
export { APair } from "./values/primitives/APair.js";
// `AVector` — legitimate, additive public API: a cross-package consumer that walks a real
// parsed AST (mcp-substrate's statement-facts.ts, replacing its former reliance on the
// arrival-sweet spike parser) needs `instanceof AVector` to distinguish a `[...]` literal
// from an ordinary cons list, the same way `APair`/`ANil`/`AString`/`ASymbol` are already
// exported for that purpose.
export { AVector } from "./values/primitives/AVector.js";
export { CONSTANT_CTX, makeRunContext, type RunContext } from "./values/primitives/RunContext.js";
// `SchemeValue` — the honest union of every value the interpreter can hold. A cross-package
// AST-walking consumer (mcp-substrate's statement-facts.ts) needs to name this type for its
// own function signatures (walking a real parsed form, not a plain-object `Node` shape).
export type { SchemeValue } from "./values/types.js";

// No eager bootstrap kick. The runtime base assembles lazily on the first `exec`
// (the realm-cached `ensureBaseAssembled`, exposed as `initBridge` below), so there is
// no module-load ceremony — importing the package no longer fires an async assembly.
// Callers that want the base warm before their first exec can still `await initBridge()`.

// Classes that may be needed for type checking or extension
export { EOF as EOF } from "./values/primitives/EOF.js";
// Environment is INTERNAL-ONLY — the concrete scope-node is not part of the public
// surface (consumers type against the structural `SchemeEnv` below). `KEYWORD_ACCESSOR_FIELD`
// stays exported: arrival-chain's `dict` (project.ts) reads the same registered symbol.
export { KEYWORD_ACCESSOR_FIELD } from "./Environment.js";

// Invocation-context metadata registries (the docs / rosetta-type / rosetta-purity
// side-tables that used to be fields on the concrete `Environment`, now held OFF the
// scope-node, keyed by env). `rosettaTypesOf` is the type-lens harvest seam — studio
// derives its lens roster from `[...rosettaTypesOf(env)]` (was `[...env.__rosettaTypes__]`).
// `rosettaPureOf` rounds out the pair for external readers.
export { rosettaTypesOf, rosettaPureOf } from "./env-registries.js";

// The structural env contract cross-package packs/consumers type against (never the
// concrete `Environment` class). Re-surfaced on the barrel from its real home
// (`./common/scheme-env.ts`, also reachable via the `@here.build/arrival/scheme-env`
// subpath) so barrel-style consumers (arrival-chain, arrival-mcp) name the interface.
export {
  type SchemeEnv,
  type RosettaSpec,
  type ResolverSpec,
} from "./common/scheme-env.js";

// Number system - SchemeExact (rationals) and SchemeInexact (floats/complex)
export { AExact } from "./values/primitives/AExact.js";
export { AInexact } from "./values/primitives/AInexact.js";
export { type ANumeric, parseNumber as parseNumber } from "./values/numbers.js";

// Bridge (numeric coercion re-export + the R7RS exception verbs + bootstrap). The
// numeric core (the former Operator/Codec stack + the operator instances) is carved
// into the `scheme/numeric` pack and is no longer part of the public surface.
export {
  coerceNumeric,
  wrappedOps as wrappedOps,
  initBridge as initBridge,
} from "./bridge.js";

// Generator-based Evaluator (alternative to main evaluate function)
// Uses flat trampoline for true stack safety and better performance
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
  type Invocation,
  type StackFrame,
} from "./eval/evaluator.js";

// Generator Exec Entry Point (LIPS parser + generator evaluator)
// Use this for string-to-value evaluation with the generator evaluator
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
// capability from ONE module specifier (`@here.build/arrival`) instead of fanning across
// `/capability` + `/env` + `/symbol` + `/scheme-zod`. The split mattered: when a consumer's
// test resolved the root to source but a subpath to dist, the typed codecs' `instanceof
// AString` rejected cross-realm args (the dual-package hazard). Root-exposing the codecs
// alongside the `A*` classes they guard collapses both onto a single module graph, so
// `instanceof` holds and no per-consumer vitest alias is needed. The `/symbol` + `/scheme-zod`
// subpaths stay (additive) for callers that prefer granular, tree-shaken imports.
//   • `EnvCapability` — the capability class (`exec({ capabilities })`, `assembleEnv` roots).
//   • `assembleEnv`   — the C3 kernel assembler that spins packs/capabilities onto a base env.
//   • `symbol`        — the typed-symbol factory ({ native, rosetta, tagless, … }) from common/symbol.
//   • `z`             — the scheme-zod codec namespace (`z.string`/`z.number`/… JS↔Scheme membrane
//                       codecs + the re-exported zod surface). Namespaced (not `export *`) so the
//                       `z.symbol` CODEC stays distinct from the top-level `symbol` FACTORY.
export { EnvCapability } from "./common/capability.js";
export { assembleEnv } from "./common/kernel.js";
export { symbol } from "./common/symbol.js";
export * as z from "./common/scheme-zod.js";

// Reader lexer entry. `tokenize(source, true)` lifts source into `{ token, col, offset, line }`
// meta-tokens off the real FSM lexer, so `#\(`, string literals, `#|…|#`, datum comments, and
// quote prefixes are counted correctly (a hand-scanner would miscount `#\(`). arrival-mcp's
// DiscoveryTool slices REPL top-level statements by token start-offsets — the reader is the one
// place that lexes Scheme faithfully, so it must consume the offsets rather than re-scan.
export { tokenize } from "./reader/tokenize.js";

// The ONE way to make an env allocation-bounded — every eval loop that owns an env (Project.run, the
// studio kernel) installs the meter through this, so "bounded" is a single named act, not ad-hoc.
export { installHeapMeter, findHeapMeter, type HeapMeter } from "./heap-budget.js";

// LX (audit Action 4): the PUBLIC bare `exec`/`parse` resolve to the stack-safe,
// budget-bounded GENERATOR path. These explicit named re-exports shadow the
// `exec`/`parse` that ride `export * from "./stdlib.js"` (ESM: an explicit export
// wins over a star-exported name of the same name). The generator `ExecOptions` is
// a strict superset of stdlib's exec options ({env, dynamic_env, use_dynamic}
// shared, + signal/budgetMs/tap), so bare-`exec` callers gain a killable, bounded
// evaluator. The legacy `evaluate` is DELETED — stdlib.ts's own `exec` now also
// delegates to the generator, so the two paths agree.
export { exec, parse } from "./eval/generator-exec.js";

// Static lineage carrier (provenance-static-lineage-v0.x). The STATIC analogue of
// the runtime provenance trace: `classify` builds a per-form lineage skeleton from the
// parsed AST (no eval), and the cone/resolve queries answer the teleological full-cone,
// the demand-as-projection field-cone, and (v0.2) the field-point base+key the JOIN
// consumers read. Surfaced on the package boundary so the consumer-equivalence SHADOW
// (which lives above this package, alongside EvalTrace) can prove the static walk
// reproduces the live field-points before the runtime mint is retired.
export {
  classify,
  fullCone,
  countCone,
  fieldCone,
  fieldResolve,
  stepKey,
  sameStep,
  CLASSIFIED_SPECIAL_FORMS,
  type LineageNode,
  type PathStep,
  type Bindings,
  type Classifier,
  type FieldResolution,
} from "./values/lineage.js";
export { classifierFromEnv } from "./values/lineage-classifier-from-env.js";
// v02-G0 SPIKE — the per-value AUTO-BINDING leaf-stamp (flag-gated, additive). Captures,
// per consumer invocation, the producer ids each read value carries, so the static
// carrier's leaf slots auto-bind to the right per-invocation producer (replacing the
// manual `{ infer: ids }` global map the v02-G1 shadow uses) without collapsing distinct
// invocations of one source name. Populated by EvalTrace.exit when attached.
export { AutoBindings, slotsOf } from "./values/lineage-auto-bindings.js";
// Deep provenance of a value — the union of `.provenance` over every reachable AValue
// (pair spine, vector, JS array elements). Containers are provenance-transparent, so this
// is THE read for "which points fed this packed value" (a pool of candidates, a list arg).
export { deepProvenance } from "./values/deep-provenance.js";
