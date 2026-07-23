// capability — EnvCapability: the ONE shape every palette pack uses. The IMPLEMENTATION of the
// capability contract:
//
//   `export default EnvCapability.define(name, { configuration, resources, prelude, symbols, deps })`
//
// The model — the five-key CLOSED taxonomy and the MODULE-SINGLETON rule — is
// docs/environments.md §CAPABILITY; this file is the enforcement site. STAGE C CUT 4
// (docs/plans/stage-c-corpse-deletion.md) retired `lower()`/`LoweredPack` — the
// per-capability EnvPack-lowering chain — along with it: a capability's `spec` is now consumed
// directly by `env/vocabulary.ts`'s `buildVocabulary` (the bootstrap bind loop lives there now,
// byte-equivalent dispatch, reusing this file's exported per-kind helpers below). The raw
// `new EnvCapability(name, spec)` constructor SURVIVES only as `EnvCapability.define`'s own
// internal call (via `DefinedEnvCapability`, below) — `EnvCapability.define` is the one
// sanctioned authoring path; every real pack in this package uses it.

import { z } from "zod";

import { type Ref, type Resource, ResourceCell, windDownAll } from "./resources.js";
import type {
  AEntity,
  BakeRuntimeOpts,
  Contract,
  DecodedArgsWithRest,
  DecodedReturn,
  DefineSymbolDef,
  DefineSyntaxSymbolDef,
  MacroSymbolDef,
  MaybePromise,
  MetadataRecord,
  RestSpec,
  VectorSpec,
} from "./symbol.js";
// The REAL `symbol` namespace + scheme-zod — `EnvCapability.define`'s injected `(symbol, z)`
// factory pair (Stage 1c, see the section ahead of the class). Value imports (not type-only):
// `makeSymbolFactory` casts the namespace ITSELF at the boundary, and `z` below (renamed from
// this module's OWN scoped `schemeZod` alias) is handed straight to a capability's `symbols`
// callback — no cycle: `./symbols/index.js` and `./scheme-zod.js` sit BELOW this file in the
// dependency direction already (capability.ts imports `./symbols/_bake.js`/`ACallable.js`,
// which these modules also reach; neither imports back up to `capability.ts`).
import * as symbolFactories from "./symbols/index.js";
import * as schemeZod from "./scheme-zod.js";
import { computeCapabilityExports } from "./symbols/define-bake.js";
import type { AliasSymbolDef } from "./symbols/alias.js";
import { AKernelKeyword } from "../values/AKernelKeyword.js";
import { ANativeProcedure, ARosettaProcedure, DoorProcedure } from "../values/primitives/ACallable.js";
import type { AmbientValue } from "../env/AmbientRuntime.js";
import { CallCtx, type Face } from "./symbols/_bake.js";
import type { RunContext } from "../run/RunContext.js";
import { onRunContextDispose } from "../run/run-lifecycle.js";
import { type DegradationInfo, type DegradedCapability, type DegradedNeed } from "./degradation.js";

type ZodMap = Record<string, z.ZodType>;
type InferCfg<C extends ZodMap> = { [K in keyof C]: z.infer<C[K]> };
type HandleOf<T> = T extends Resource<infer H> ? H : never;
type RefsOf<R extends Record<string, Resource<unknown>>> = { readonly [K in keyof R]: Ref<HandleOf<R[K]>> };

/** The per-env binding context a method's `this` sees: validated config + live resource Refs. */
export interface Activation<C extends ZodMap, R extends Record<string, Resource<unknown>>> {
  readonly configuration: InferCfg<C>;
  readonly resources: RefsOf<R>;
  /** Door-set degradation (`./degradation.js`'s `DegradationInfo`). Present on EVERY activation;
   *  informational to authors (the builder-form `symbols` that used to hand-mint doors off it
   *  is retired — config-gating a verb is `Contract.requiresConfig` now, whose auto-door calls
   *  this same `.door(...)` internally) — model in docs/environments.md §DEGRADATION. */
  readonly degradation: DegradationInfo;
}

type Fn = (...args: any[]) => unknown;

/** A symbol is one of ONE family now (Stage C Cut 4 retired the last authoring alternative):
 *
 *  Stage A2 (2026-07-22): the symbol.* FACTORIES mint the runtime A-value directly —
 *  `symbol.native`/`sequence`/`tagless`/`tagless-guard` → `ANativeProcedure`, `rosetta` →
 *  `ARosettaProcedure`, `door`/`notImplemented` → `DoorProcedure`, `keyword` →
 *  `AKernelKeyword`, `value` → the boxed `AmbientValue` itself. Every one of these is
 *  already `instanceof AValue` (or a raw `AmbientValue` leaf for `value`'s bigint/
 *  Promise/binary passthrough cases) — `AmbientValue` alone covers the whole family, so
 *  it's the ONE arm below (dispatched by `instanceof` in apply(), not by a `kind` tag —
 *  see the per-kind cases). `symbol.define`/`symbol.defineSyntax` are the two-phase
 *  carve-out (their scheme body doesn't evaluate until Pass 2 runs) and `symbol.macro` hands
 *  over an already-built `Macro` — all THREE stay plain, `kind`-tagged declarative records,
 *  dispatched exactly as before.
 *
 *  STAGE C CUT 4 (docs/plans/stage-c-corpse-deletion.md): the LEGACY rosetta-config form
 *  (`{ fn, withContext, type, options }`, `fn` reading `this: Activation`) is DROPPED from
 *  this union — `lower()`, its sole BINDER, is retired. It is still load-bearing OUTSIDE
 *  arrival (`McpEnvCapability`'s whole inline-annotation design is built on it, and the
 *  here.build discovery servers author verbs this way) — but a TS-authored `symbols` record
 *  inside THIS package can no longer declare it; `isSymbolSpec`/`VocabularyLegacyCapabilityError`
 *  (env/vocabulary.ts) keep a RUNTIME refusal check for a capability that reaches the
 *  vocabulary path with this shape anyway (a stale dist build, an untyped JS author), teaching
 *  toward the postponed MCP rework rather than dead code.
 *
 *  Named `SymbolDeclaration`, not `SymbolDef`: the wider authoring shape a `symbols` record
 *  entry can literally BE, vs. `symbol.js`'s narrower `AEntity` (now a CONTRACT-data type only
 *  — it rides `.contract`/`.door` on a minted value, no longer a record traveling on its own).
 *
 *  `AliasSymbolDef` (`symbol.alias`) is a FOURTH arm: it never binds directly (see the
 *  apply-loop resolution below) — it only ever stands in for a sibling entry's already-baked
 *  value.
 *
 *  RETIREMENT PIN: `Exclude<AmbientValue, Fn>`, not bare `AmbientValue` — `AmbientValue`'s
 *  own `AProcedure` member (values/types.ts) is STRUCTURALLY a bare callable
 *  (`(this, ...args) => Result | …`), the exact shape the Stage-6 bare-`Fn` authoring arm
 *  retired (a capability declaring `symbols: { foo: someFn }` directly, bypassing the
 *  symbol.* factories). `symbol.value`'s factory itself never MINTS a bare function (see
 *  value.ts: `isSchemeValue` passthrough or `fromJS`, neither of which produces one) — this
 *  `Exclude` keeps that true at the TYPE level too, matching `capability.test-d.ts`'s
 *  retirement pin. The runtime fallback below doors loudly on the (should-be-unreachable)
 *  case a mis-authored capability hands one anyway. */
export type SymbolDeclaration =
  | Exclude<AmbientValue, Fn>
  | MacroSymbolDef
  | DefineSymbolDef
  | DefineSyntaxSymbolDef
  | AliasSymbolDef;

// ── LEGACY-form RUNTIME refusal guard (Stage C Cut 4): `{ fn }` is no longer a
// `SymbolDeclaration` union member (see the doc above) — `env/vocabulary.ts`'s
// `buildVocabulary` still calls this against a runtime-cast `SymbolDeclaration` record to
// refuse a legacy-shaped capability with `VocabularyLegacyCapabilityError` instead of
// silently mis-binding it (a stale-dist or untyped-JS producer can still hand one in, past
// the type system). Structural, not `SymbolDeclaration`-narrowing anymore — the predicate
// type below is deliberately wider than the (now `{fn}`-free) parameter type. */
export const isSymbolSpec = (m: SymbolDeclaration): m is SymbolDeclaration & { fn: Fn } =>
  typeof m === "object" && m !== null && "fn" in m;

/** `symbol.alias`'s marker — see `alias.ts`'s header for the full dissolution-semantics
 *  contract. Checked BEFORE every other dispatch in the apply loop (its `kind` — `"alias"` —
 *  is deliberately outside both the minted-value family and the three surviving declarative
 *  kinds, so it would otherwise fall through to the legacy `{ fn }`-guessing arm instead). */
export const isAliasDef = (m: SymbolDeclaration): m is AliasSymbolDef =>
  typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "alias";

/** The three SURVIVING declarative record kinds — `symbol.define`/`symbol.defineSyntax` (the
 *  two-phase carve-out) and `symbol.macro` (already hands over a real `Macro`, but stays a
 *  `{kind, name, macro}` record so `preludeOnly` routing has somewhere to live). Every OTHER
 *  kind mints its A-value directly now (see `SymbolDeclaration`'s doc), so a plain object
 *  carrying one of these three `kind` tags is unambiguous — none of the minted classes'
 *  OWN `.kind` field (`"procedure"`/`"keyword"`/an ordinary scheme-value kind) collides with
 *  `"define"`/`"define-syntax"`/`"macro"`. */
export const isDeclarativeDef = (
  m: SymbolDeclaration,
): m is MacroSymbolDef | DefineSymbolDef | DefineSyntaxSymbolDef =>
  typeof m === "object" &&
  m !== null &&
  "kind" in m &&
  ((m as { kind: unknown }).kind === "macro" ||
    (m as { kind: unknown }).kind === "define" ||
    (m as { kind: unknown }).kind === "define-syntax");

/** Stage A2 READ-SIDE seam: extract a `SymbolDeclaration` entry's `AEntity` CONTRACT view, for
 *  read-only introspection consumers (the describe/catalog roster in `eval/exec-phases.ts`, the
 *  type-lens harvest in `type-layer/prelude.ts`/`schema-to-ts.ts`, the mercury registry harvest)
 *  that used to walk a `symbols` record expecting each entry to BE its own `AEntity` record.
 *  Since the symbol.* factories now mint the runtime A-value directly (see `SymbolDeclaration`'s
 *  doc), those readers dispatch by `instanceof` here exactly like the bind loop above, pulling
 *  the SAME `.contract`/`.door` data the bind loop reads per-assembly — never invoking anything
 *  (a value is inert until applied; this is a pure, dry projection). `undefined` for an entry
 *  with no contract to show: `symbol.alias` (resolve the target first), the legacy `{ fn }` arm,
 *  and the narrow bigint-leaf gap `symbol.value`'s own factory documents (a JS primitive can't
 *  carry a hidden property to stamp).
 *
 *  gap-a ruling (2026-07-22): `symbol.value` stamps its OWN `{kind:"value",name,doc}` onto the
 *  minted/boxed value's `.contract` too (own, non-enumerable, define-once — see `value.ts`),
 *  the SAME slot every other kind rides — so the generic `"contract" in def` fallback below
 *  picks it up uniformly, with no per-kind special-casing here. */
export function contractOf(def: SymbolDeclaration): AEntity | undefined {
  if (def instanceof DoorProcedure) return def.door;
  if (def instanceof ANativeProcedure || def instanceof ARosettaProcedure) return def.contract as AEntity;
  if (def instanceof AKernelKeyword) return { kind: "keyword", name: def.name };
  if (isDeclarativeDef(def)) return def;
  if (typeof def === "object" && def !== null && "contract" in def) {
    return (def as { contract?: AEntity }).contract;
  }
  return undefined;
}

/** Stage 3 auto-derive gate (`Contract.requiresConfig`, `./symbols/_bake.js`): the declared
 *  keys ABSENT from this activation's validated `configuration` — `undefined` when the def
 *  declares no `requiresConfig` or every declared key is present (the zero-cost, overwhelming-
 *  majority path). Read UNCONDITIONALLY by the `native`/`rosetta` bind arms below — no
 *  builder-form, no `degradation:"doors"` gate; see the field's own doc for the D2 departure
 *  this closes (a bare-required config key used to fail-close at `schema.parse`, before any
 *  program graph existed to statically explain WHY). */
export const missingRequiresConfig = (
  requiresConfig: readonly (string | readonly string[])[] | undefined,
  configuration: Record<string, unknown>,
): readonly (string | readonly string[])[] | undefined => {
  if (requiresConfig === undefined || requiresConfig.length === 0) return undefined;
  // A group entry (`readonly string[]`) is ANY-OF: missing only when EVERY key is absent.
  const missing = requiresConfig.filter((entry) =>
    typeof entry === "string"
      ? configuration[entry] === undefined
      : entry.every((key) => configuration[key] === undefined),
  );
  return missing.length === 0 ? undefined : missing;
};

/** The keys a door's `cause.needs` carries for a missing set — group entries flattened
 *  (each key in an any-of group is a real enabling key; the either-of semantics live in the
 *  reason text, `cause.needs` stays the flat `configuration`-key list every reader expects). */
export const requiresConfigNeeds = (missing: readonly (string | readonly string[])[]): readonly string[] =>
  missing.flatMap((entry) => (typeof entry === "string" ? [entry] : [...entry]));

/** Auto-door misses surfaced for `Vocabulary.degraded`: `env/vocabulary.ts`'s bind loop mints
 *  `requiresConfig` doors as bound `DoorProcedure`s WITHOUT writing a `DoorSymbolDef` back
 *  into `symbolsRec`, so `collectDegraded`'s record scan (built for the builder-form
 *  `degradation.door(...)` path, which does write defs) can't see them — this sibling scan
 *  reads the same misses straight off the baked defs, and that bind loop merges the two
 *  views via {@link mergeDegraded}. */
export const collectRequiresConfigDegraded = (
  capabilityName: string,
  symbolsRec: Record<string, SymbolDeclaration>,
  configuration: Record<string, unknown>,
): DegradedCapability | undefined => {
  const seen = new Set<string>();
  const needs: DegradedNeed[] = [];
  for (const rawDef of Object.values(symbolsRec)) {
    // Stage A2: `requiresConfig` rides `.contract` on a minted native/rosetta value now
    // (never a top-level field on the value itself) — `contractOf` is the shared read-side
    // seam every describe/catalog/harvest reader already dispatches through.
    const entity = contractOf(rawDef);
    if (entity === undefined || !("requiresConfig" in entity)) continue;
    const missing = missingRequiresConfig(entity.requiresConfig, configuration);
    if (missing === undefined) continue;
    for (const key of requiresConfigNeeds(missing)) {
      if (seen.has(key)) continue;
      seen.add(key);
      needs.push({ kind: "configuration", key });
    }
  }
  return needs.length === 0 ? undefined : { capability: capabilityName, needs };
};

/** Merge the two degraded views (builder-door record scan + requiresConfig def scan),
 *  deduped by need key; `undefined` when both are. */
export const mergeDegraded = (
  a: DegradedCapability | undefined,
  b: DegradedCapability | undefined,
): DegradedCapability | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const seen = new Set(a.needs.map((need) => `${need.kind}:${need.key}`));
  return {
    capability: a.capability,
    needs: [...a.needs, ...b.needs.filter((need) => !seen.has(`${need.kind}:${need.key}`))],
  };
};

/** The auto-derived door's teaching reason — same "provide X to enable it" register
 *  `degradation.ts`'s hand-authored `.door(name, needs, reason)` callers write by hand, minted
 *  here mechanically from the declaring verb's OWN `doc` instead. An any-of group renders as
 *  "`fs` or `loader`" with a "one of them" pronoun, keeping the disjunction legible. */
export const requiresConfigReason = (missing: readonly (string | readonly string[])[], doc: string | undefined): string => {
  const keysClause = missing
    .map((entry) => (typeof entry === "string" ? `\`${entry}\`` : entry.map((key) => `\`${key}\``).join(" or ")))
    .join(", ");
  const pronoun = missing.length === 1 ? (typeof missing[0] === "string" ? "it" : "one of them") : "them";
  const docClause = doc === undefined ? "" : ` (${doc})`;
  return `requires configuration ${keysClause} — provide ${pronoun} to enable this verb.${docClause}`;
};

/** A `symbols` record. The BUILDER form (`(activation) => Record<…>`) is RETIRED (Stage-6
 *  cleanup): a config-bearing capability authors through `EnvCapability.define`, whose impls
 *  read `this.configuration`/`this.resources` at dispatch, and config-gates a verb via
 *  `Contract.requiresConfig` (the auto-door) instead of conditional enumeration. STAGE C CUT 4:
 *  the `ThisType<Activation>` overlay this type used to carry for the legacy `{fn}`-record arm
 *  is gone too — that arm is no longer part of `SymbolDeclaration` (see its own doc), and no
 *  surviving arm reads `this` off this record at all. */
export type SymbolsSpec<C extends ZodMap, R extends Record<string, Resource<unknown>>> = Record<
  string,
  SymbolDeclaration
>;

export interface CapabilitySpec<C extends ZodMap, R extends Record<string, Resource<unknown>>> {
  /** zod schemas for per-env config; values are supplied + validated when this capability's
   *  spec is consumed (`env/vocabulary.ts`'s `buildVocabulary`). */
  configuration?: C;
  /** the ports this capability OWNS — static, or a provider that reads the parsed config.
   *  Spawned per-RunContext, lazily, on first symbol touch (`["arrival/get-resources"]`,
   *  below — the RunContext.capabilityResources store's producer callback). */
  resources?: { [K in keyof R]: R[K] | ((cfg: InferCfg<C>) => R[K]) };
  /** scheme bootstrap (`define-macro` + `define`s), eval'd into env on apply. */
  prelude?: string;
  /** DAG edges = capability grants. */
  deps?: readonly EnvCapability[];
  /** the verbs this capability exposes — baked `symbol.native`/`symbol.rosetta`/… declarations,
   *  the ONE authoring form every pack in the arrival packages uses (Stage C Cut 4 dropped the
   *  legacy `{fn}`-record arm from `SymbolDeclaration` — see that type's own doc). A
   *  config-bearing capability authors through `EnvCapability.define` (impls read
   *  `this.configuration` at dispatch; the retired builder form `(activation) => ({...})` is
   *  no longer part of this type). */
  symbols?: SymbolsSpec<C, R>;
}

/** Every `.spec.prelude` reachable from `caps`, DAG order (a dep's prelude precedes its
 *  dependent's — matching `env/vocabulary.ts`'s `buildVocabulary` deps-first bind order, so a
 *  dependent's prelude may reference names its dep's prelude defined), deduplicated by
 *  capability IDENTITY (a
 *  diamond-shaped dep graph must not double-emit a shared dep's prelude).
 *
 *  For an EDITOR/type-lens's ambient scheme vocabulary: walk the actually-assembled capability
 *  set, never a hand-picked subset — a hand-picked list silently drifts the moment a
 *  capability's prelude changes or a new capability joins the root-set. */
export function collectPrelude(caps: readonly EnvCapability[], seen: Set<EnvCapability> = new Set()): string {
  const parts: string[] = [];
  for (const cap of caps) {
    if (seen.has(cap)) continue;
    seen.add(cap);
    if (cap.spec.deps !== undefined) {
      const depsPrelude = collectPrelude(cap.spec.deps, seen);
      if (depsPrelude !== "") parts.push(depsPrelude);
    }
    if (cap.spec.prelude !== undefined) parts.push(cap.spec.prelude);
  }
  return parts.join("\n");
}

/** Serialize a capability DAG's scheme-bodied `symbol.define`s as `(define <verb> <body>)`
 *  source — the type-lens compile-path counterpart to {@link collectPrelude}'s `prelude:`
 *  strings. A `symbol.define`'s `body` is its RHS EXPRESSION (`(lambda () "string")` for
 *  `s/string`), bound at runtime under its own record key (see `env/vocabulary.ts`'s
 *  `processCapability` Pass-2 loop, the successor of this file's retired `lower().apply()`).
 *  Emitting the SAME `(define verb body)` lets a type-lens infer each symbol's type FROM ITS
 *  OWN BODY, so the runtime binding and the editor type derive from one source — no
 *  hand-authored `.d.ts`, no editorial subset (the drift trap {@link collectPrelude} warns of,
 *  same reasoning). Deps FIRST (a dependent body may reference a base define — `s/field/string`
 *  calls `s/field`), deduped by the shared `seen` set exactly like `collectPrelude`.
 *
 *  Only `kind: "define"` entries emit; every other kind (rosetta/native/door/…) is either a
 *  JS impl with no scheme body or a keyword/macro the lens models elsewhere.
 *
 *  NOT for runtime prelude eval: `env/vocabulary.ts`'s bind loop already binds these via
 *  `bindCapabilityDefines`; re-running them as a prelude would double-bind. This output feeds
 *  a type-lens `schemePrelude` (the editor's compiled scheme vocabulary), never the runtime
 *  env. */
export function collectSymbolDefines(caps: readonly EnvCapability[], seen: Set<EnvCapability> = new Set()): string {
  const parts: string[] = [];
  for (const cap of caps) {
    if (seen.has(cap)) continue;
    seen.add(cap);
    if (cap.spec.deps !== undefined) {
      const depDefines = collectSymbolDefines(cap.spec.deps, seen);
      if (depDefines !== "") parts.push(depDefines);
    }
    const symbols = cap.spec.symbols;
    if (symbols === undefined) continue;
    for (const [key, def] of Object.entries(symbols)) {
      if (def !== null && typeof def === "object" && "kind" in def && def.kind === "define") {
        parts.push(`(define ${key} ${(def as DefineSymbolDef).body})`);
      }
    }
  }
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// EnvCapability.define — Stage 1c (docs/execution.md §CALLCTX): the FLIPPED authoring API, THE
// authoring path (the Stage-6 cleanup migrated every real pack; `new EnvCapability(name, spec)`
// below remains for its own internal use by `DefinedEnvCapability`, a raw-ctor
// per-key-`ResourceCell` authoring style some tests still exercise directly (see
// `run-scoped-resources.test.ts`), and — outside arrival — McpEnvCapability's `{fn}`-record
// downstream population, until the postponed MCP rework moves it onto baked-symbol splicing).
//
// The RETIRED `symbols` builder-form closed an `activation` BUILDER-ARG (`(activation) =>
// ({...})`) over each verb's impl; the impl then read config/resources from THAT CLOSURE, never
// `this` (a baked rosetta/native's `this` is the per-call INVOCATION, not the activation — see
// `CapabilitySpec.symbols`'s own doc above). The FLIPPED shape inverts this: `symbols` receives
// an injected `(symbol, z)` factory pair — the SAME `symbol.rosetta`/`native`/… namespace
// (`./symbols/index.js`) + scheme-zod — typed so each impl's `this.configuration`/
// `this.resources` are the DECLARED `Config`/`Resources`, not `unknown`, and reads them off
// `this` at REAL DISPATCH, riding the Stage 1b `associateActivation`/`CallCtx` channel every
// baked def (native/rosetta/sequence) already carries. `symbols` is invoked EAGERLY, ONCE, at
// `define()` time — the record it returns doesn't depend on any per-env config, exactly like
// the OLD literal-record form; only an IMPL BODY'S runtime read of `this.configuration`/
// `.resources` is per-dispatch.
//
// Resources: `spec.resources` here is ONE factory over the validated config
// (`(config) => Resources`), not the OLD per-key `Record<string, Resource<H>>` map
// (`resources: { shout: shoutResource }`) `new EnvCapability(...)` still uses — a simpler,
// NOT lifecycle-managed bag (no acquire/wind-down/resume). A `define()`-authored capability
// declares NO old-style `spec.resources`; instead `DefinedEnvCapability` overrides
// `["arrival/get-resources"]` (1d, RunContext-keyed) to produce its single arbitrary bag from
// `resourcesFactory(config)` directly, and flips `producesRunResources`/
// `nativeReadsRunResources` to `true` so its baked native/rosetta symbols read `this.resources`
// from the run store. See `DefinedEnvCapability` below.
// ─────────────────────────────────────────────────────────────────────────────

/** The `this` every impl declared through {@link EnvCapability.define}'s injected `symbol`
 *  factory is invoked with — `CallCtx` (run/CallCtx.ts) narrowed so `configuration`/
 *  `resources` (Stage 1b: `unknown`, optional, on the runtime carrier) are the capability's
 *  OWN declared `Config`/`Resources`, not `unknown`. An AUTHORING-LAYER type overlay ONLY —
 *  the runtime `CallCtx` fields stay `unknown`; this narrowing is applied ONCE, at the
 *  `SymbolFactory` boundary (`makeSymbolFactory`'s cast below) — the one sanctioned narrowing
 *  for this channel, mirroring the membrane's own single-cast boundary. */
export type ImplThis<Config, Resources> = CallCtx & {
  readonly configuration: Config;
  readonly resources: Resources;
};

/** `Impl` (`./symbols/_bake.js`) with its `this` parameterized instead of pinned to `CallCtx` —
 *  same decoded-args/return shape (`DecodedArgsWithRest`/`DecodedReturn`, the SAME face
 *  projection every baked impl already type-checks against), so a `symbol.rosetta`/`native`
 *  impl authored through the injected factory infers BYTE-IDENTICAL arg/return types to the
 *  module-singleton factories — only `this` differs. */
type ImplWithThis<I extends VectorSpec, O extends VectorSpec, Rest extends RestSpec, F extends Face, This> = (
  this: This,
  ...args: DecodedArgsWithRest<I, Rest, F>
) => MaybePromise<DecodedReturn<O, F>>;

/** The injected `symbol.rosetta` — byte-identical to the module-singleton `rosetta()` factory
 *  (`./symbols/rosetta.js`) except the impl's `this` is {@link ImplThis}`<Config,Resources>`
 *  instead of the bare `CallCtx` every OTHER call site sees. */
export interface RosettaTag<Config, Resources> {
  (
    tpl: TemplateStringsArray,
    ...sub: (string | number)[]
  ): <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: Contract<I, O, Rest>,
    impl: ImplWithThis<I, O, Rest, "js", ImplThis<Config, Resources>>,
    opts?: BakeRuntimeOpts,
  ) => ARosettaProcedure;
}

/** The injected `symbol.native` — same relationship to `native()` (`./symbols/native.js`) as
 *  {@link RosettaTag} bears to `rosetta()`; projects the SCHEME face (`"scheme"`), matching
 *  `native()`'s own `Impl<…, "scheme">`. */
export interface NativeTag<Config, Resources> {
  (
    tpl: TemplateStringsArray,
    ...sub: unknown[]
  ): <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: Contract<I, O, Rest>,
    impl: ImplWithThis<I, O, Rest, "scheme", ImplThis<Config, Resources>>,
    opts?: { metadata?: MetadataRecord },
  ) => ANativeProcedure;
}

/** The factory `EnvCapability.define`'s `symbols` callback is invoked with. `rosetta`/`native`
 *  carry the `Config`/`Resources`-typed `this` overlay ({@link RosettaTag}/{@link NativeTag});
 *  every other tag is byte-identical to its module-singleton (`./symbols/index.js`) — none of
 *  `sequence`/`tagless`/`taglessGuard`/`notImplemented`/`keyword`/`macro`/`alias`/`define`/
 *  `defineSyntax` read config/resources off `this` (sequence's impl takes `(args, runCtx)`
 *  positionally; `define`/`defineSyntax` carry a two-phase scheme body, not a JS `this`-reading
 *  impl; the rest carry no author impl at all), so they need no overlay. */
export interface SymbolFactory<Config, Resources> {
  readonly rosetta: RosettaTag<Config, Resources>;
  readonly native: NativeTag<Config, Resources>;
  readonly sequence: typeof symbolFactories.sequence;
  readonly tagless: typeof symbolFactories.tagless;
  readonly taglessGuard: typeof symbolFactories.taglessGuard;
  readonly notImplemented: typeof symbolFactories.notImplemented;
  readonly keyword: typeof symbolFactories.keyword;
  readonly macro: typeof symbolFactories.macro;
  readonly alias: typeof symbolFactories.alias;
  readonly define: typeof symbolFactories.define;
  readonly defineSyntax: typeof symbolFactories.defineSyntax;
  readonly value: typeof symbolFactories.value;
}

/** Build the injected `symbol` factory for one `define()` call: the REAL `./symbols/index.js`
 *  namespace, cast ONCE to the `Config`/`Resources`-typed {@link SymbolFactory} — the sanctioned
 *  narrowing {@link ImplThis}'s doc points at. No wrapping at runtime: `rosetta`/`native` are the
 *  SAME functions every hand-authored capability calls; only the TYPE seen by the `symbols`
 *  callback's impls differs. */
function makeSymbolFactory<Config, Resources>(): SymbolFactory<Config, Resources> {
  return symbolFactories as unknown as SymbolFactory<Config, Resources>;
}

/** `EnvCapability.define`'s spec — the flipped shape. See the section header above for the
 *  full model; `configuration`/`prelude`/`deps` are byte-identical to `CapabilitySpec`'s own
 *  fields (reused, not re-declared). */
export interface DefineCapabilitySpec<Shape extends ZodMap, Resources> {
  readonly configuration?: Shape;
  /** ONE factory over the validated config — see the section header's Resources note. */
  readonly resources?: (config: InferCfg<Shape>) => Resources;
  readonly prelude?: string;
  readonly deps?: readonly EnvCapability[];
  /** Invoked EAGERLY, ONCE, at `define()` time — see the section header. */
  readonly symbols: (
    symbol: SymbolFactory<InferCfg<Shape>, Resources>,
    z: typeof schemeZod,
  ) => Record<string, SymbolDeclaration>;
}

/** A configured, lowerable env capability. The default export of every palette pack. */

export class EnvCapability<C extends ZodMap = any, R extends Record<string, Resource<unknown>> = any> {
  constructor(
    readonly name: string,
    readonly spec: CapabilitySpec<C, R>,
  ) {}

  /** Structural DAG-node view — Stage B1's `dag-linearize.ts` shared C3 core (env/
   *  vocabulary.ts's `buildVocabulary`) walks `{name, deps}` generically; a capability's OWN
   *  dep edges live at `spec.deps` (the authoring field), never at this top level, so this
   *  getter is the ONE place they surface there too. Delegates, never duplicates — `spec.deps`
   *  stays the single source; nothing else should read `.deps` off a capability instead of
   *  `.spec.deps` (this exists only to satisfy the generic `DagNode` shape structurally AND
   *  at runtime). */
  get deps(): readonly EnvCapability<any, any>[] | undefined {
    return this.spec.deps;
  }

  /** 1d: this capability's PER-RUN resource producer — the run's `capabilityResources` store
   *  (RunContext.ts) calls it at most once per `RunContext` (the DefaultedWeakMap semaphore),
   *  keyed on this capability object. Returns the resource bag for THIS run — the base form's
   *  bag is a fresh `ResourceCell` record built from `spec.resources` (config-resolved),
   *  UNSPAWNED: a `.get()`-reading impl lazy-spawns per cell (a `.live` read needs a prior spawn
   *  — arrival-mcp's shape, migrated in Stage 6). Disposal registers on THIS RunContext, so the
   *  bag's cells wind down at run teardown. `undefined` when the capability declares no resources
   *  (the store never asks — those verbs bind `readsResources: false`). MaybePromise by contract
   *  (a future capability may acquire its whole bag asynchronously); the base form is synchronous. */
  ["arrival/get-resources"](runCtx: RunContext, configuration: unknown): MaybePromise<unknown> | undefined {
    const descriptors = Object.entries(this.spec.resources ?? {});
    if (descriptors.length === 0) return undefined;
    const cells: Record<string, ResourceCell<unknown>> = {};
    for (const [key, def] of descriptors) {
      const resource = (typeof def === "function" ? def(configuration as InferCfg<C>) : def) as Resource<unknown>;
      cells[key] = new ResourceCell(resource);
    }
    onRunContextDispose(runCtx, () => windDownAll(Object.values(cells)));
    return cells;
  }

  /** 1d: does this capability produce a per-run resource bag (gating a verb's `readsResources`)?
   *  Base: it declares `spec.resources`. `native` verbs bind `false` regardless (see
   *  `nativeReadsRunResources`). */
  producesRunResources(): boolean {
    return Object.keys(this.spec.resources ?? {}).length > 0;
  }

  /** 1d: does a `native` verb of this capability read `this.resources` from the run store? Base:
   *  NO — the base-ctor path is the LEGACY arm (the `{fn}`-record shape + its subject-tests;
   *  every production native now authors through `.define`, the loader included since its
   *  Stage-6 migration), and a legacy native never reads `this.resources` — triggering the
   *  store here would double-spawn. `EnvCapability.define`'s form overrides this to `true`
   *  (its injected `native` factory's whole point is a `this.resources`-reading impl). */
  nativeReadsRunResources(): boolean {
    return false;
  }

  /** The flipped authoring entry point — see the section immediately above this class for the
   *  full model. Builds the SAME `CapabilitySpec` shape the constructor above consumes (a
   *  plain literal `symbols` record — `env/vocabulary.ts`'s bind loop cannot tell the two
   *  authoring paths apart, and never needs to). Returns a {@link DefinedEnvCapability} (a
   *  thin, internal subclass) so its OWN `["arrival/get-resources"]` override can produce
   *  this capability's per-run resource bag — see that class's doc. */
  static define<Shape extends ZodMap = Record<string, never>, Resources = Record<string, never>>(
    name: string,
    defSpec: DefineCapabilitySpec<Shape, Resources>,
  ): EnvCapability<Shape, Record<string, never>> {
    const symbolFactory = makeSymbolFactory<InferCfg<Shape>, Resources>();
    const symbolsRec = defSpec.symbols(symbolFactory, schemeZod);
    return new DefinedEnvCapability<Shape, Resources>(
      name,
      {
        configuration: defSpec.configuration,
        prelude: defSpec.prelude,
        deps: defSpec.deps,
        symbols: symbolsRec,
      },
      defSpec.resources,
    );
  }

  private _exportsPromise?: Promise<ReadonlySet<string>>;

  /** `EnvCapability.exports` — DERIVED, memoized: every statically-enumerable name
   *  this capability contributes to a shared env — prefixed `spec.symbols` keys
   *  (always statically enumerable now: the builder-form `symbols` arm, the one
   *  non-enumerable shape, is retired) ∪ macro-aware `define`/`define-macro`/`define-syntax` names
   *  parsed from `spec.prelude` (the migration-interim arm, shrinking toward nothing
   *  as capabilities move their `prelude` text blob to declared `symbol.define`s,
   *  pack by pack). Consumed by `symbol.define`'s bake-time FV law
   *  (`define-bake.ts`'s `bindCapabilityDefines`) to resolve what a CROSS-capability
   *  reference needs. Async (not a real getter — parsing is inherently async) and
   *  memoized per capability INSTANCE, not per `buildVocabulary` build: a module-singleton
   *  capability's export set never changes across assemblies. */
  exports(): Promise<ReadonlySet<string>> {
    this._exportsPromise ??= computeCapabilityExports(this.spec);
    return this._exportsPromise;
  }
}

/** The runtime half of `EnvCapability.define` (Stage 1c) — see the section immediately above
 *  the class, and `define()`'s own doc, for the full model. A THIN subclass: the base class's
 *  bind loop (now `env/vocabulary.ts`'s `processCapability`, post Stage-C-Cut-4) `associateCapability`s
 *  each symbol to THIS instance, so the run's `capabilityResources` store reaches this
 *  capability's `["arrival/get-resources"]` override below — no per-proc rewrap. The only
 *  per-form specialization is the three virtual hooks:
 *   - `["arrival/get-resources"]` produces this capability's single arbitrary `Resources` bag
 *     from `resourcesFactory(config)` (vs the base form's `spec.resources` `ResourceCell` record);
 *   - `producesRunResources`/`nativeReadsRunResources` flip to `true` so this capability's baked
 *     symbols (native + rosetta — the injected `symbol.*` factory's whole point is a
 *     `this.resources`-reading impl) bind `readsResources: true`.
 *  Internal: never exported; constructed only by `EnvCapability.define`. */
class DefinedEnvCapability<Shape extends ZodMap, Resources> extends EnvCapability<Shape, Record<string, never>> {
  constructor(
    name: string,
    spec: CapabilitySpec<Shape, Record<string, never>>,
    private readonly resourcesFactory: ((config: InferCfg<Shape>) => Resources) | undefined,
  ) {
    super(name, spec);
  }

  override ["arrival/get-resources"](runCtx: RunContext, configuration: unknown): MaybePromise<unknown> | undefined {
    const { resourcesFactory } = this;
    if (resourcesFactory === undefined) return undefined;
    // `resourcesFactory` is SYNCHRONOUS by contract (`DefineCapabilitySpec.resources`:
    // `(config) => Resources`, never a Promise) — so the bag is a plain value the store caches
    // as-is (no promise to collapse). An optional `[Symbol.asyncDispose]` on the bag runs once,
    // at THIS RunContext's teardown.
    const bag = resourcesFactory(configuration as InferCfg<Shape>);
    const disposable = bag as { [Symbol.asyncDispose]?: () => PromiseLike<void> | void };
    if (disposable[Symbol.asyncDispose] !== undefined) {
      onRunContextDispose(runCtx, async () => {
        await disposable[Symbol.asyncDispose]!();
      });
    }
    return bag;
  }

  override producesRunResources(): boolean {
    return this.resourcesFactory !== undefined;
  }

  override nativeReadsRunResources(): boolean {
    return this.resourcesFactory !== undefined;
  }
}
