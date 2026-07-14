// emit/emit-rule — EmitRule/EmitCtx/EmitConfig: the compiler-facing rule surface a
// Contract may carry (`Contract.emit`, `_bake.ts`).
//
// Constitution: docs/working-proposals/arrival-ts-transpiler-design.md §4.1 (the field),
// §4.5 (layering — these are pure-data TYPES in arrival core; everything touching
// `typescript`/`ts.factory` lives in the compiler package, which READS contracts and
// interprets residuals). Component spec: docs/working-proposals/arrival-mercury/
// registry-emit.md §Owned interfaces.
//
// The Residual algebra `R` (proposal §3.4, owned by residual-renderer.md) has not landed
// in this package yet, so both interfaces are GENERIC over the residual type with an
// `unknown` default — `EmitRule` bare (as `Contract.emit` carries it) is the fully-opaque
// instantiation; the engine and rule-authoring sites instantiate `EmitRule<R>` once the
// residual module exists. Method (not property) signatures are deliberate: TS checks
// method parameters bivariantly, so a rule authored against the real `R` stays assignable
// to the opaque `EmitRule` a Contract stores.

import type { TypeFacts } from "./type-facts.js";

/** Value-position behavior for a symbol used as a VALUE (`(map car xss)`), not applied.
 *  - `"shim"` (DEFAULT): emit `RuntimeRef(sym)` — always a correct function value.
 *  - `"eta"`: opt-in for fact-driven-or-structural rules (car, cdr, accessors,
 *    predicates) — eta-expansion of `call` against the instantiated use-site signature
 *    (`TypeFacts.callable`); no instantiated signature ⇒ shim (Law F's value-position
 *    analog). Legal only under fixed arity (an unbounded variadic has no parameter
 *    list to eta-expand).
 *  - `"door"`: first-class use cannot be honest in v1 — a named compile error. */
export type RefPolicy = "eta" | "shim" | "door";

/** The compile's ambient knobs a rule may branch on — register, framework axis,
 *  opinions. NEVER asyncness (rules are async-blind — Law W owns awaits) and NEVER
 *  effects (the optimization gates read `provenance`/`cacheClass` at the engine level,
 *  not in rules). */
export interface EmitConfig {
  /** Which emitter register this compile targets (proposal §1): `"run"` = the executable
   *  artifact; `"read"` = the human-grade reading view. */
  readonly register: "run" | "read";
  /** Framework axis for capability rules that emit framework-specific residuals
   *  (`infer`'s vercel/langchain branch, §4.3). An OPEN string — the branch keys are
   *  each rule-owning component's vocabulary, not an enum owned here. */
  readonly framework?: string;
  /** Named compiler opinions (formatting/idiom toggles). Open bag by design — an opinion
   *  lands with its consuming rule/pass, never pre-enumerated here. */
  readonly opinions?: Readonly<Record<string, unknown>>;
}

/** Everything an emit rule may consult. Assembled by the engine per call site as a plain
 *  object literal (no masking constructor — `argAsync` and `buildEmitCtx` were deleted by
 *  the 2026-07-13 "async-ify by cascade on type data" ruling: a rule can no longer see,
 *  or branch on, asyncness in any form).
 *
 *  `R` = the Residual algebra (opaque here; see the module header). */
export interface EmitCtx<R = unknown> {
  /** Per-argument facts — Law F applies (absence ⇒ the rule's conservative branch). */
  argFacts: TypeFacts[];
  /** Contextual/expected type of the call's OWN result when known. Scoped to the call
   *  itself — never parent-node peeking: cross-node idioms live in named engine
   *  peepholes (Law C), not in rules inspecting what consumes them. */
  selfFacts?: TypeFacts;
  config: EmitConfig;
  /** Opaque origin handle for the CoreForm node this residual is produced FOR — zero
   *  type contract on this side (CoreForm's NodeId is compiler-package-local; typing it
   *  here would invert §4.5's dependency direction). Currently inert by design: origin
   *  spans thread via copy-forward in the pass that builds residuals; this handle exists
   *  for the one case copy-forward can't cover (a rule minting a node with no 1:1
   *  CoreForm origin). Consumers must treat it as optional. */
  originHint?: unknown;
  /** Hygienic temp via the namer's reservation pass. Returns the namer's opaque Binding
   *  handle — typed `unknown` deliberately (residual-renderer.md's own `Binding` is an
   *  opaque `unknown` alias; naming it here would pre-claim that module's export). */
  fresh(hint: string): unknown;
  /** Sugar for `RuntimeRef(symbol)` — the frame-as-query mechanism: FRAME scans the
   *  finished tree and materializes exactly the imports that occur. */
  runtime(symbol: string): R;
  /** Typed refusal — surfaces as a compile diagnostic, never a silent miscompile. */
  door(reason: string): never;
}

/** The idiomatic-residual rewrite a Contract may carry (`Contract.emit`). Absent ⇒ the
 *  fallback ladder's rung 3 (the RuntimeRef shim) — silence is impossible by
 *  construction (§4.2: rule → eta-ref → shim → door).
 *
 *  Rules are async-blind (Law W: never mint `Await`, never see asyncness — emit
 *  sync-shaped residuals; ASYNC-IFY's post-emit dataflow places every await) and
 *  effect-blind (provenance/cacheClass gate at the engine, not here). Rules must be
 *  STATIC data on the declaration — a builder-form capability whose rule shape depends
 *  on activation state is a harvest-time error (§4.5). */
export interface EmitRule<R = unknown> {
  /** Application position: `(sym a b …)` → residual. `args` are already-lowered
   *  residuals — a rule cannot inspect what its argument syntactically WAS (Law A:
   *  residual selection keys on argument FACTS, never on syntax or result types). */
  call(args: readonly R[], ctx: EmitCtx<R>): R;
  /** Value position (`(map sym xs)`). Rarely hand-written — see `RefPolicy`: the default
   *  is the engine-derived eta-expansion of `call` (under `"eta"`) or the RuntimeRef
   *  shim (under `"shim"`, the default). */
  ref?(ctx: EmitCtx<R>): R;
}
