// capability — EnvCapability: the ONE shape every palette pack uses. The IMPLEMENTATION of the
// capability contract:
//
//   `export default new EnvCapability(name, { configuration, resources, prelude, symbols, deps })`
//
// The model — the five-key CLOSED taxonomy, the MODULE-SINGLETON rule, the
// module-singleton → `EnvPack` → assembled-env lowering chain, and "dependencies point down, only
// down" — is docs/environments.md §CAPABILITY; this file is the enforcement site.
//
// Local to this file: the `symbols` record (and the legacy `this`-reading arms) carry
// `ThisType<Activation<C,R>>`, so `this.configuration.<k>` is `z.infer`'d and `this.resources.<k>`
// is the typed `Ref` with ZERO annotations — bound to the per-env activation at wire time, no
// per-env closure churn. Lowering wires each symbol (membrane-wrapped) + evals the prelude;
// resources become ref-counted `ResourceCell`s on the activation (`this.resources`).

import { z } from "zod";

import type { EnvPack, PackContext, PreludeBindTarget } from "./kernel.js";
import { type Ref, type Resource, ResourceCell, spinUpAll, windDownAll } from "./resources.js";
import type { EvalSchemeInto, RosettaSpec, SchemeEnv } from "./scheme-env.js";
import type {
  AEntity,
  BakeRuntimeOpts,
  Contract,
  DecodedArgsWithRest,
  DecodedReturn,
  DefineSymbolDef,
  DefineSyntaxSymbolDef,
  DoorSymbolDef,
  MaybePromise,
  MetadataRecord,
  NativeSymbolDef,
  RestSpec,
  RosettaSymbolDef,
  VectorSpec,
} from "./symbol.js";
// The REAL `symbol` namespace + scheme-zod — `EnvCapability.define`'s injected `(symbol, z)`
// factory pair (Stage 1c, see the section ahead of the class). Value imports (not type-only):
// `makeSymbolFactory` casts the namespace ITSELF at the boundary, and `z` below (renamed from
// this module's OWN scoped `schemeZod` alias) is handed straight to a capability's `symbols`
// callback — no cycle: `./symbols/index.js` and `./scheme-zod.js` sit BELOW this file in the
// dependency direction already (capability.ts imports `./symbols/_bake.js`/`ACallable.js`,
// which these modules also reach; neither imports back up to `capability.ts`).
import invariant from "tiny-invariant";
import * as symbolFactories from "./symbols/index.js";
import * as schemeZod from "./scheme-zod.js";
import { bindCapabilityDefines, computeCapabilityExports } from "./symbols/define-bake.js";
import type { AliasSymbolDef } from "./symbols/alias.js";
import { AKernelKeyword } from "../values/AKernelKeyword.js";
import {
  ANativeProcedure,
  ARosettaProcedure,
  DoorProcedure,
  type CallableImpl,
} from "../values/primitives/ACallable.js";
import type { RosettaFunction } from "../membrane/rosetta.js";
// `bindRosetta`: the internal rosetta wiring (its retirement ledger lives in AmbientRuntime.ts).
// Two producers only — this legacy `SymbolDeclaration` bind arm and `provenance/replay.ts`'s
// playback frame; a third would be suspect.
import { bindRosetta, bindValue, AmbientRuntime, type AmbientValue, isAmbientRuntime } from "../env/AmbientRuntime.js";
import {
  associateCapability,
  CallCtx,
  type CacheClass,
  type CallbackRoles,
  type Face,
  type ProvenanceRole,
} from "./symbols/_bake.js";
import type { RunContext } from "../run/RunContext.js";
import { onRunContextDispose } from "../run/run-lifecycle.js";
import { type SchemeValue } from "../values/types.js";
import { AliasTargetError, AmbientShapeError, PreludeArmingError } from "../errors.js";
import {
  buildDegradationInfo,
  collectDegraded,
  missingOptionalKeys,
  type DegradationInfo,
  type DegradationMode,
  type DegradedCapability,
  type DegradedNeed,
} from "./degradation.js";

/** An `EnvPack` that also carries its resource lifecycle (wind-down = pause; resume
 *  = re-spawn). The kernel uses the EnvPack face; a lifecycle owner calls these. */
export type LoweredPack = EnvPack<SchemeEnv> & {
  /** Release every resource (reverse-DAG), keep wiring. Next touch/resume re-spawns. */
  windDown(): Promise<void>;
  /** Eagerly re-acquire every resource. */
  resume(signal?: AbortSignal): Promise<void>;
  /** The per-env binding context this lower() armed (validated config + resource cells +
   *  degradation) — EXPOSURE, not construction: the binder adapters already close over it.
   *  The phase-2 read channel: `assembleEnv`
   *  folds these into `AssembledEnv.activations`, and describe-time metadata resolution
   *  (`resolveMetadata`) reads dynamic fields against exactly this object. */
  readonly activation: Activation<any, any>;
};

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

/** A symbol is one of TWO families (collapsing toward ONE — `AEntity`):
 *
 *  • the BAKED `AEntity` from the symbol.* API (`{ kind: "native" | "rosetta" | "door" | … }`)
 *    — dispatched by `kind` in apply(). The ONLY form every pack in the arrival packages
 *    declares, and the union's target: every other arm is scheduled to dissolve into it.
 *  • the LEGACY rosetta-config form (`{ fn, withContext, type, options }`) — `fn` reads
 *    `this: Activation` (bound at wire time). Load-bearing OUTSIDE arrival:
 *    `McpEnvCapability`'s whole inline-annotation design (MCP `description`/`inputSchema`
 *    spliced onto the same object as `fn`) is built on it, and the here.build discovery
 *    servers author verbs this way. Deleting it needs McpEnvCapability's annotation-lifting
 *    to move to baked-symbol splicing first (the postponed MCP rework) — NOT dead code.
 *
 *  RETIRED arms (Stage-6 collapse, 2026-07-22): the bare-`Fn` shorthand (was the ThisType
 *  method channel — author `{ fn }` explicitly instead) and the raw `{ value }` binding
 *  (was the loader-resolver escape hatch — a resolver is an ordinary `symbol.native` verb;
 *  `applyCallback` dispatches its apply term exactly as it called the bare fn).
 *
 *  Named `SymbolDeclaration`, not `SymbolDef`, to stay distinct from `symbol.js`'s `AEntity` —
 *  the wider authoring shape vs. the narrower baked/discriminated result (`AEntity` is one arm
 *  of this union, not a synonym for it).
 *
 *  `AliasSymbolDef` (`symbol.alias`) is a FOURTH arm, distinct from `AEntity`: it never binds
 *  directly (see the apply-loop resolution below) — it only ever stands in for a sibling
 *  entry's already-baked def. */
export type SymbolDeclaration =
  | AEntity
  | (Omit<RosettaSpec, "fn"> & { fn: Fn })
  | AliasSymbolDef;

/** A baked symbol.* def carries a literal `kind` discriminant — the cut that separates the
 *  target form from every legacy shape. */
const isBakedDef = (m: SymbolDeclaration): m is AEntity =>
  typeof m === "object" &&
  m !== null &&
  "kind" in m &&
  ((m as { kind: unknown }).kind === "native" ||
    (m as { kind: unknown }).kind === "rosetta" ||
    (m as { kind: unknown }).kind === "tagless" ||
    (m as { kind: unknown }).kind === "tagless-guard" ||
    (m as { kind: unknown }).kind === "sequence" ||
    (m as { kind: unknown }).kind === "door" ||
    (m as { kind: unknown }).kind === "keyword" ||
    (m as { kind: unknown }).kind === "macro" ||
    (m as { kind: unknown }).kind === "define" ||
    (m as { kind: unknown }).kind === "define-syntax" ||
    (m as { kind: unknown }).kind === "value");

// ── LEGACY-form guard — see `SymbolDeclaration`'s doc for why this one stays ─────────────
const isSymbolSpec = (m: SymbolDeclaration): m is Omit<RosettaSpec, "fn"> & { fn: Fn } =>
  typeof m === "object" && m !== null && "fn" in m;

/** `symbol.alias`'s marker — see `alias.ts`'s header for the full dissolution-semantics
 *  contract. Checked BEFORE `isBakedDef` in the apply loop (its `kind` — `"alias"` — is
 *  deliberately outside `AEntity`'s discriminant set, so `isBakedDef` alone would never
 *  recognize it and it would fall through to the legacy `{ fn }`-guessing arm instead). */
const isAliasDef = (m: SymbolDeclaration): m is AliasSymbolDef =>
  typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "alias";

/** Stage 3 auto-derive gate (`Contract.requiresConfig`, `./symbols/_bake.js`): the declared
 *  keys ABSENT from this activation's validated `configuration` — `undefined` when the def
 *  declares no `requiresConfig` or every declared key is present (the zero-cost, overwhelming-
 *  majority path). Read UNCONDITIONALLY by the `native`/`rosetta` bind arms below — no
 *  builder-form, no `degradation:"doors"` gate; see the field's own doc for the D2 departure
 *  this closes (a bare-required config key used to fail-close at `schema.parse`, before any
 *  program graph existed to statically explain WHY). */
const missingRequiresConfig = (
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
const requiresConfigNeeds = (missing: readonly (string | readonly string[])[]): readonly string[] =>
  missing.flatMap((entry) => (typeof entry === "string" ? [entry] : [...entry]));

/** Auto-door misses surfaced for `AssembledEnv.degraded`: the bind loop below mints
 *  `requiresConfig` doors as bound `DoorProcedure`s WITHOUT writing a `DoorSymbolDef` back
 *  into `symbolsRec`, so `collectDegraded`'s record scan (built for the builder-form
 *  `degradation.door(...)` path, which does write defs) can't see them — this sibling scan
 *  reads the same misses straight off the baked defs, and `lower()` merges the two views. */
const collectRequiresConfigDegraded = (
  capabilityName: string,
  symbolsRec: Record<string, unknown>,
  configuration: Record<string, unknown>,
): DegradedCapability | undefined => {
  const seen = new Set<string>();
  const needs: DegradedNeed[] = [];
  for (const def of Object.values(symbolsRec)) {
    if (typeof def !== "object" || def === null) continue;
    const rc = (def as { requiresConfig?: readonly (string | readonly string[])[] }).requiresConfig;
    const missing = missingRequiresConfig(rc, configuration);
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
const mergeDegraded = (
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
const requiresConfigReason = (missing: readonly (string | readonly string[])[], doc: string | undefined): string => {
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
 *  `Contract.requiresConfig` (the auto-door) instead of conditional enumeration. The
 *  `ThisType<Activation>` overlay remains for the legacy `{fn}`-record arm
 *  (`McpEnvCapability`'s downstream population — see `SymbolDeclaration`'s doc). */
export type SymbolsSpec<C extends ZodMap, R extends Record<string, Resource<unknown>>> = Record<
  string,
  SymbolDeclaration
> &
  ThisType<Activation<C, R>>;

export interface CapabilitySpec<C extends ZodMap, R extends Record<string, Resource<unknown>>> {
  /** zod schemas for per-env config; values are supplied + validated at `lower()`. */
  configuration?: C;
  /** the ports this capability OWNS — static, or a provider that reads the parsed config.
   *  Spawned by the activation middleware on first symbol touch (see lower()). */
  resources?: { [K in keyof R]: R[K] | ((cfg: InferCfg<C>) => R[K]) };
  /** scheme bootstrap (`define-macro` + `define`s), eval'd into env on apply. */
  prelude?: string;
  /** an optional namespace prepended to every `symbols` KEY at apply time, so a
   *  subject-scoped pack registers BARE names (`pslist`, `netscan`) and declares its
   *  namespace ONCE here (`"process/"`). The prefix is the capability's identity made
   *  legible in the binding name — it does not touch the prelude (which addresses its own
   *  defines). Does NOT apply to deps (each declares its own). */
  symbolPrefix?: string;
  /** DAG edges = capability grants. */
  deps?: readonly EnvCapability[];
  /** the verbs this capability exposes — baked `symbol.native`/`symbol.rosetta`/… declarations
   *  (the target form every pack in the arrival packages now uses), or (legacy shape,
   *  still load-bearing for `McpEnvCapability`'s downstream population — see
   *  `SymbolDeclaration`'s doc) a `Record<name, RosettaConfig>` whose `fn` reads `this`
   *  (`this.configuration.*` / `this.resources.*.live`), with `this` typed as `Activation<C,R>`
   *  (ThisType, inferred). A config-bearing BAKED capability authors through
   *  `EnvCapability.define` (impls read `this.configuration` at dispatch; the retired
   *  builder form `(activation) => ({...})` is no longer part of this type). */
  symbols?: SymbolsSpec<C, R>;
}

/** Every `.spec.prelude` reachable from `caps`, DAG order (a dep's prelude precedes its
 *  dependent's — matching `lower()`'s own `apply()` evaluation order, so a dependent's prelude
 *  may reference names its dep's prelude defined), deduplicated by capability IDENTITY (a
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
 *  `s/string`), bound at runtime under `symbolPrefix + key` (see `apply()`'s Pass-2 loop).
 *  Emitting the SAME `(define verb body)` lets a type-lens infer each symbol's type FROM ITS
 *  OWN BODY, so the runtime binding and the editor type derive from one source — no
 *  hand-authored `.d.ts`, no editorial subset (the drift trap {@link collectPrelude} warns of,
 *  same reasoning). Deps FIRST (a dependent body may reference a base define — `s/field/string`
 *  calls `s/field`), deduped by the shared `seen` set exactly like `collectPrelude`.
 *
 *  Builder-function `symbols` (need a live `Activation` to enumerate) are skipped — a
 *  statically-enumerable record is the norm for define-bearing packs, and a type-lens needs no
 *  activation-specific symbols. Only `kind: "define"` entries emit; every other kind
 *  (rosetta/native/door/…) is either a JS impl with no scheme body or a keyword/macro the lens
 *  models elsewhere.
 *
 *  NOT for runtime prelude eval: `apply()` already binds these via `bindCapabilityDefines`;
 *  re-running them as a prelude would double-bind. This output feeds a type-lens `schemePrelude`
 *  (the editor's compiled scheme vocabulary), never the runtime env. */
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
    const prefix = cap.spec.symbolPrefix ?? "";
    for (const [key, def] of Object.entries(symbols)) {
      if (def !== null && typeof def === "object" && "kind" in def && def.kind === "define") {
        parts.push(`(define ${prefix + key} ${(def as DefineSymbolDef).body})`);
      }
    }
  }
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// EnvCapability.define — Stage 1c (docs/execution.md §CALLCTX): the FLIPPED authoring API, THE
// authoring path (the Stage-6 cleanup migrated every site; `new EnvCapability(name, spec)`
// below remains only for the legacy `{fn}`-record arm — McpEnvCapability's downstream
// population — and its subclass).
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
// NOT lifecycle-managed bag (no acquire/wind-down/resume), computed once per `lower()` call.
// `lower()` ITSELF stays completely untouched (this migration's own bound) — its
// `cells`/`ResourceCell` production, degradation, and def→value binding are exactly as they
// are for `new EnvCapability(...)`. A `define()`-authored capability declares NO old-style
// `spec.resources` (so `lower()` produces empty cells for it) and instead RE-STAMPS
// `associateActivation` on its own already-bound procs right after `apply()` runs — reading
// them back through the `SchemeEnv` accessor (`env.get`, the same read-face every OTHER
// consumer uses), never poking `lower()`'s internals. See `DefinedEnvCapability` below.
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
  ) => RosettaSymbolDef;
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
  ) => NativeSymbolDef;
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
 *  full model; `configuration`/`prelude`/`symbolPrefix`/`deps` are byte-identical to
 *  `CapabilitySpec`'s own fields (reused, not re-declared). */
export interface DefineCapabilitySpec<Shape extends ZodMap, Resources> {
  readonly configuration?: Shape;
  /** ONE factory over the validated config — see the section header's Resources note. */
  readonly resources?: (config: InferCfg<Shape>) => Resources;
  readonly prelude?: string;
  readonly symbolPrefix?: string;
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
  protected producesRunResources(): boolean {
    return Object.keys(this.spec.resources ?? {}).length > 0;
  }

  /** 1d: does a `native` verb of this capability read `this.resources` from the run store? Base:
   *  NO — the base-ctor path is the LEGACY arm (the `{fn}`-record shape + its subject-tests;
   *  every production native now authors through `.define`, the loader included since its
   *  Stage-6 migration), and a legacy native never reads `this.resources` — triggering the
   *  store here would double-spawn. `EnvCapability.define`'s form overrides this to `true`
   *  (its injected `native` factory's whole point is a `this.resources`-reading impl). */
  protected nativeReadsRunResources(): boolean {
    return false;
  }

  /** The flipped authoring entry point — see the section immediately above this class for the
   *  full model. Builds the SAME `CapabilitySpec` shape the constructor above consumes (a
   *  plain literal `symbols` record — `lower()` cannot tell the two paths apart, and never
   *  changes), so `lower()` itself needs no edits. Returns a {@link DefinedEnvCapability} (a
   *  thin, internal subclass) so its OWN `resources` factory can re-stamp
   *  `associateActivation` after `apply()` — see that class's doc. */
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
        symbolPrefix: defSpec.symbolPrefix,
        deps: defSpec.deps,
        symbols: symbolsRec,
      },
      defSpec.resources,
    );
  }

  /** Lower to a kernel `EnvPack`. `evalScheme` runs the prelude (required iff a prelude
   *  exists); `config` is validated against the `configuration` schemas.
   *
   *  `degradation`: `"forbid"` (the default — host/provisioning posture) or `"doors"`
   *  (program-scoped callers opt in). Threaded to every dep's own `lower()` call, same as
   *  `evalScheme`/`config`, so a degraded dep and a degraded root see the SAME mode. The mode
   *  changes nothing by itself (docs/environments.md §DEGRADATION); see `./degradation.js`. */
  lower(
    opts: { evalScheme?: EvalSchemeInto; config?: Partial<InferCfg<C>>; degradation?: DegradationMode } = {},
  ): LoweredPack {
    const { spec, name } = this;
    // The capability itself — captured here because `apply()` below is a METHOD (its `this` is the
    // returned pack, not the capability). The bind loop's `associateCapability` keys each bound
    // value to THIS object, which makeCallCtx later calls `["arrival/get-resources"]` on.
    const ownerCapability = this;
    // A SEPARATE alias for `apply()`'s door-bind arm: the per-symbol loop below rebinds
    // `name` to each entry's OWN key (`for (const [name, def] of Object.entries(...))`),
    // shadowing this capability-level `name` for the rest of that block — reading `name`
    // from inside the "door" case would stamp the SYMBOL's name as the cause owner, not
    // the capability's.
    const capabilityName = name;

    const schema = spec.configuration ? z.object(spec.configuration as ZodMap) : z.object({});
    const configuration = schema.parse(opts.config ?? {}) as InferCfg<C>;

    // Door-set degradation: computed from the RAW config bag (pre-`schema.parse`, which already ran
    // above and would have thrown for a present-but-invalid or a genuinely-required-and-absent key —
    // this scan only ever looks at declared-OPTIONAL keys, so it never masks either of those two
    // throw paths). Under `"forbid"` (unset) `missingKeys` is purely informational (docs/environments.md
    // §DEGRADATION).
    const degradationMode: DegradationMode = opts.degradation ?? "forbid";
    const missingKeys = missingOptionalKeys(
      spec.configuration as Record<string, z.ZodTypeAny> | undefined,
      opts.config as Record<string, unknown> | undefined,
    );
    const degradation = buildDegradationInfo(capabilityName, degradationMode, missingKeys);

    // Resource DESCRIPTORS — stateless (config-derived, no acquired handle yet), computed
    // ONCE regardless of how many RunContexts ever touch this lower()'d pack.
    const resourceDescriptors = {} as Record<string, Resource<unknown>>;
    for (const [key, def] of Object.entries(spec.resources ?? {})) {
      resourceDescriptors[key] = (
        typeof def === "function" ? (def as (c: InferCfg<C>) => Resource<unknown>)(configuration) : def
      ) as Resource<unknown>;
    }

    // LEGACY per-ambient cells (Activation.resources — the `this`-bound bare-fn arm, a
    // BUILDER-form `symbols`' own closure capture — e.g. `arrival/loader`'s `requireCache`/
    // `assembler` — and dynamic-metadata resolution, `symbols/metadata.ts`'s `resolveMetadata`,
    // which reads `Activation.resources` OUTSIDE any RunContext at all). These three consumers
    // have no RunContext to key against (a `.bind(activation)`-fixed `this`, a closure captured
    // once at `lower()` time, or a describe-time read with no run in flight), so they keep the
    // PRE-STAGE-2 ambient-scoped lifetime unchanged — `LoweredPack.windDown()`/`.resume()`
    // still pause/resume exactly this set. NOT part of Stage 2's per-RunContext migration; see
    // the file header's "two resource paths" for what DID move.
    const cells = {} as Record<string, ResourceCell<unknown>>;
    for (const [key, resource] of Object.entries(resourceDescriptors)) {
      cells[key] = new ResourceCell(resource);
    }
    const activation = { configuration, resources: cells, degradation } as unknown as Activation<C, R>;

    // The builder-form `symbols` arm (`typeof spec.symbols === "function"`) is RETIRED —
    // the record is the record (a define-form spec carries the eagerly-evaluated literal).
    const symbolsRec = spec.symbols ?? {};
    // Door-set degradation's OWN surfacing — degraded capabilities are ENUMERABLE: scan
    // the computed record for doors this capability minted via `degradation.door(...)`,
    // MERGED with the requiresConfig auto-door misses (bound as DoorProcedures below without
    // a record entry — see `collectRequiresConfigDegraded`), folded into the returned pack's
    // `degraded` field — `assembleEnv` (kernel.ts) aggregates it into `AssembledEnv.degraded`,
    // uninterpreted.
    const degraded = mergeDegraded(
      collectDegraded(capabilityName, symbolsRec),
      collectRequiresConfigDegraded(capabilityName, symbolsRec, configuration as Record<string, unknown>),
    );

    // First touch of ANY of this capability's symbols spawns ALL its resources
    // (single-flight), BEFORE the method body runs — so methods read `this.resources
    // .x.live` synchronously, never an `await .get()`. The capability dictates the
    // entity set; the env accessor (this wrapper) makes presence a precondition.
    // `cellList`/`ensureSpawned` remain the LEGACY (ambient-scoped) gate for the bare-fn arm
    // below (`gated`) — untouched by Stage 2.
    const cellList = Object.values(cells);
    let spawned: Promise<void> | undefined;
    const ensureSpawned = (): Promise<void> =>
      (spawned ??= Promise.all(cellList.map((c) => c.get())).then(() => undefined));

    // 1d — per-RunContext resources for the baked kinds (sequence/tagless/tagless-guard/rosetta,
    // plus define-form native) no longer ride a bind-time `runScoped` gate wrapped into the impl.
    // A real dispatch's `CallCtx` already carries `this.resources`, fetched at `makeCallCtx` from
    // the run's own `capabilityResources` store (keyed by THIS capability, produced lazily by
    // `["arrival/get-resources"]`, single-flighted + collapsed there) — see RunContext.ts. So the
    // impl adapter is just the bare `(args, callCtx) => rawRun.apply(callCtx, args)`: `rawRun`
    // reads `this.resources` off the `callCtx` the dispatch already enriched.
    const bakedImpl =
      (rawRun: (this: CallCtx, ...args: unknown[]) => Promise<unknown>): CallableImpl =>
      (args, callCtx) =>
        rawRun.apply(callCtx, args) as Promise<SchemeValue>;
    // Whether a NON-native baked verb of this capability reads its `this.resources` from the run
    // store (its `associateCapability(..., readsResources)`): true iff the capability produces a
    // per-run bag. `native` verbs are gated separately (`nativeReadsRunResources` — false in the
    // base form, where a resource-reading native is closure-fed, never `this.resources`).
    const bakedReadsResources = this.producesRunResources();
    const nativeReadsResources = this.nativeReadsRunResources();

    return {
      name,
      activation,
      ...(opts.config === undefined ? {} : { config: opts.config }),
      ...(degraded === undefined ? {} : { degraded: [degraded] }),
      // Deps inherit the SAME raw `config` object (each validates its own slice via its schema; the
      // stored `config` field stays reference-equal across a capability's root + dep appearances, so
      // closure dedup matches by identity instead of tripping AssembleConfigConflictError).
      ...(spec.deps
        ? {
            deps: spec.deps.map((d) =>
              d.lower({ evalScheme: opts.evalScheme, config: opts.config, degradation: opts.degradation }),
            ),
          }
        : {}),
      // Lifecycle (pause/resume) over this capability's cells. Wiring is untouched.
      windDown: async () => {
        spawned = undefined;
        await windDownAll(cellList);
      },
      resume: async (signal?: AbortSignal) => {
        spawned = spinUpAll(cellList, signal);
        await spawned;
      },
      async apply(env: SchemeEnv, ctx?: PackContext<SchemeEnv>) {
        // HERMETIC NARROW (instanceof DOOR, never a cast; docs/environments.md §HERMETIC): with
        // `SchemeEnv.set` hard-deleted, binding goes through the module-internal `bindValue`
        // (AmbientRuntime.ts), which writes real AmbientRuntime storage. Packs are applied onto real
        // envs everywhere in production (env-roots leaves, `LexicalScope.fresh()` roots, `inherit()`
        // children thereof); a synthetic structural env cannot RECEIVE bindings — assemble onto a
        // real frame instead.
        if (!isAmbientRuntime(env)) {
          throw new AmbientShapeError(
            `capability "${name}"`,
            `apply target is not an arrival AmbientRuntime — a capability's bindings ` +
              `land in real environment storage (the JS-side write surface is retired; HERMETIC-ENVIRONMENT ` +
              `ruling). Assemble onto \`LexicalScope.fresh().env\`, an env-roots base, or a child of one.`,
          );
        }
        // The env-backed bind face, shaped like the kernel's PreludeBindTarget shim so
        // `bindTarget` stays ONE type either way. The narrow from the shim's `unknown` is a
        // boundary cast per this file's applyCallback convention: every value routed through
        // it below is a constructed AmbientValue (ANativeProcedure/DoorProcedure/Macro/…).
        const envTarget: PreludeBindTarget = { set: (n, v) => bindValue(env, n, v as AmbientValue) };
        // preludeOnly routing: a baked native/rosetta def marked `preludeOnly: true` binds onto
        // `ctx.preludeScope` instead of the runtime env — the assembly-time-only contract is
        // docs/environments.md §PRELUDE. Same bind form either way (native → raw impl; rosetta → the
        // gated run wrapper); only the TARGET scope differs. Absent `ctx.preludeScope` (a bare direct
        // apply outside any assembly), fall back to `env` so the symbol is never silently dropped.
        const bindTarget = (def: AEntity): PreludeBindTarget =>
          "preludeOnly" in def && def.preludeOnly ? (ctx?.preludeScope ?? envTarget) : envTarget;
        const prefix = spec.symbolPrefix ?? "";
        // Two-phase binding (docs/environments.md §PRELUDE): symbol.define/symbol.defineSyntax entries
        // are collected here (in declaration order — JS object-key insertion order) and
        // evaluated+bound in Pass 2, AFTER every other kind. `ownNames` is the letrec* NAME
        // VISIBILITY set — see `BindCapabilityDefinesArgs.ownNames` (define-bake.ts) for the full
        // contract.
        const defineEntries: [string, DefineSymbolDef | DefineSyntaxSymbolDef][] = [];
        const ownNames = new Set<string>();
        for (const [name, rawDef] of Object.entries(symbolsRec)) {
          const verb = prefix + name;
          ownNames.add(verb);

          // symbol.alias dissolution: substitute the TARGET's already-baked def in place of
          // the marker, then fall through the SAME per-kind dispatch below — the alias binds
          // byte-identically to its target under its own name (`verb`), never a wrapper.
          // `symbolsRec` is already fully built (see alias.ts's header) so a sibling lookup
          // here — regardless of iteration order — is sound; a target absent from THIS
          // capability's own record, or itself an alias (no chains), is a declaration bug and
          // doors loudly rather than silently binding nothing.
          let def: SymbolDeclaration = rawDef;
          if (isAliasDef(rawDef)) {
            const targetDef = symbolsRec[rawDef.target];
            if (targetDef === undefined) {
              throw new AliasTargetError(capabilityName, name, rawDef.target, "missing-target");
            }
            if (isAliasDef(targetDef)) {
              throw new AliasTargetError(capabilityName, name, rawDef.target, "chained-alias");
            }
            def = targetDef;
          }

          if (isBakedDef(def) && (def.kind === "define" || def.kind === "define-syntax")) {
            defineEntries.push([verb, def]);
            continue;
          }

          // ── BAKED symbol.* forms — dispatch by kind (the target path) ────────────────
          //
          // Three rules generate the per-kind bodies below; each case cites them by name.
          //
          //   ARITY — `arity: { min: 0, max: null }` everywhere is introspection-only in this
          //     cut; the kinds self-check. Tighten from `def.in` when the MCP/type-lens surface
          //     consumes it.
          //
          //   PROVENANCE STAMP — every constructed proc is stamped with the RESOLVED provenance
          //     role (`provenanceRole = def.provenance`) plus, when declared, `callbackRoles` and
          //     `cacheClass`. The lineage classifier and wireframe builder read all three OFF THE
          //     BOUND VALUE via `env.get(op)`, never a duck-read. Cache class is Ruling A (the
          //     CACHE axis, lineage-independent), stamped only when declared (absent =
          //     regenerateable); tagless/tagless-guard are contract-less, so only `sequence`
          //     among the run-kinds has a cacheClass channel.
          //
          //   BOUNDARY CAST — a kind's `run`/`impl` produces scheme values by construction; TS
          //     sees only `unknown`. The `as … SchemeValue` narrows are that one seam — the same
          //     one rosetta.ts's `rawImpl` crosses (evaluator.ts's `ctx.currentInvocation as
          //     InvocationLike | undefined` is the sibling cast at the dispatch sites that BUILD
          //     the `callCtx` this file now only consumes).
          if (isBakedDef(def)) {
            switch (def.kind) {
              case "native": {
                // STAGE 3 AUTO-DERIVED DOOR (`Contract.requiresConfig`, ./symbols/_bake.js) —
                // read UNCONDITIONALLY, before the ordinary bind: an absent declared key mints
                // a cause-carrying DoorProcedure for this verb instead, via the SAME
                // `DegradationInfo.door` builder a manual builder-form `symbols` calls by hand
                // (`activation.degradation`, always defined — see its own doc). No mode gate:
                // fires under `"forbid"` too, closing the pre-Stage-3 gap where this reached
                // for a bare-required config key and threw a ZodError at `schema.parse` instead.
                const missingNative = missingRequiresConfig(
                  def.requiresConfig,
                  activation.configuration as Record<string, unknown>,
                );
                if (missingNative !== undefined) {
                  bindTarget(def).set(
                    verb,
                    new DoorProcedure(
                      activation.degradation.door(
                        verb,
                        requiresConfigNeeds(missingNative),
                        requiresConfigReason(missingNative, def.doc),
                      ),
                    ),
                  );
                  break;
                }
                // native (§SYMBOL-KINDS): bind a first-class ANativeProcedure, invoked through its
                // `arrival/tagless-final/apply` term. The impl adapts the term surface
                // `(args, callCtx)` to the host impl, which reads run-state off `this: CallCtx` —
                // the apply term now hands the impl the SAME whole `callCtx` dispatch built (no
                // reconstruction here), so no `this=undefined` crash from a HOF-invoked native.
                const hostImpl = def.impl as (this: CallCtx, ...a: unknown[]) => unknown;
                const proc = new ANativeProcedure({
                  name: verb,
                  arity: { min: 0, max: null }, // see ARITY above
                  contract: def,
                  // 1d: a base/constructor `native` binds `readsResources: false` (below), so its
                  // `this.resources` stays unpopulated — `arrival/loader` (the one production
                  // capability combining `spec.resources` with a `native` def) reads its resources
                  // through its BUILDER-form closure, never `this.resources`, and triggering the run
                  // store here would double-spawn. A define()-form native flips this on
                  // (`nativeReadsRunResources`), reading its bag off `this.resources` like its
                  // sibling rosetta. The impl is the bare adapter either way.
                  impl: (args, callCtx) => hostImpl.apply(callCtx, args) as SchemeValue,
                });
                // PROVENANCE STAMP (see above). A native value-op is provenance-transparent —
                // a pure transform, never a source.
                (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = def.provenance;
                if (def.cacheClass !== undefined) {
                  (proc as { cacheClass?: CacheClass }).cacheClass = def.cacheClass;
                }
                if (def.callbackRoles !== undefined) {
                  (proc as { callbackRoles?: CallbackRoles }).callbackRoles = def.callbackRoles;
                }
                // OWNER ASSOCIATION (1d, docs/execution.md §CALLCTX): key THIS bound value to its
                // OWNING CAPABILITY (object identity), so a real dispatch (evaluator.ts, via
                // makeCallCtx) enriches the `CallCtx` it builds — `configuration` resolves at
                // dispatch off the RUN now (`runCtx.capabilityConfigurations`), never carried
                // here. `readsResources` is FALSE for a base/constructor native (the legacy arm —
                // see `nativeReadsRunResources`'s doc); triggering the run store here would
                // double-spawn. `EnvCapability.define`'s form flips this via
                // `nativeReadsRunResources()`.
                associateCapability(proc, ownerCapability, nativeReadsResources);
                bindTarget(def).set(verb, proc);
                break;
              }
              case "sequence":
              case "tagless":
              case "tagless-guard": {
                // `run` is the complete ctx-aware wrapper, bound as a first-class
                // ANativeProcedure invoked through the `arrival/tagless-final/apply` term (P1:
                // no bare JS functions in env value space — a value is a term both interpreters
                // can execute). These three kinds read ONLY `this.runCtx`, and the apply term now
                // hands the impl the SAME whole `callCtx` dispatch built — no reconstruction here;
                // their `.run` shares the call SHAPE but not a common `this` type (tagless/
                // tagless-guard declare none) — hence the BOUNDARY CAST below. 1d: `this.resources`
                // (for a sequence that reads it) is enriched onto the `callCtx` at dispatch from the
                // run's own `capabilityResources` store — no bind-time gate wraps the impl.
                const rawRun = def.run as (this: unknown, ...args: unknown[]) => Promise<unknown>;
                const impl: CallableImpl = bakedImpl(rawRun as (this: CallCtx, ...args: unknown[]) => Promise<unknown>);
                const proc = new ANativeProcedure({
                  name: verb,
                  arity: { min: 0, max: null }, // see ARITY above
                  contract: def,
                  impl,
                });
                // PROVENANCE STAMP (see above). All three kinds resolve `.provenance` at bake
                // time; callback roles are bake-extracted for `sequence`, `withCallbackRoles`-
                // declared for tagless (e.g. reduce's acc-chain marker).
                (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = def.provenance;
                if (def.kind === "sequence" && def.cacheClass !== undefined) {
                  (proc as { cacheClass?: CacheClass }).cacheClass = def.cacheClass;
                }
                if (def.callbackRoles !== undefined) {
                  (proc as { callbackRoles?: CallbackRoles }).callbackRoles = def.callbackRoles;
                }
                // OWNER ASSOCIATION (1d) — see the `native` case's comment. A non-native baked
                // verb reads `this.resources` from the run store iff the capability produces a bag.
                associateCapability(proc, ownerCapability, bakedReadsResources);
                bindTarget(def).set(verb, proc);
                break;
              }
              case "rosetta": {
                // STAGE 3 AUTO-DERIVED DOOR — same gate as the `native` case above, see its
                // comment for the full model; `def.doc` here is the rosetta verb's own doc string.
                const missingRosetta = missingRequiresConfig(
                  def.requiresConfig,
                  activation.configuration as Record<string, unknown>,
                );
                if (missingRosetta !== undefined) {
                  bindTarget(def).set(
                    verb,
                    new DoorProcedure(
                      activation.degradation.door(
                        verb,
                        requiresConfigNeeds(missingRosetta),
                        requiresConfigReason(missingRosetta, def.doc),
                      ),
                    ),
                  );
                  break;
                }
                // The per-call INVOCATION now reaches the wrapper directly through the whole
                // `callCtx` the apply term dispatches with — built ONCE at the real call site
                // (the evaluator's dispatch, rosetta.ts's `callableToHostFn`, …) and threaded
                // WHOLE through apply → here, never reconstructed from ambient state. A
                // SOURCE rosetta's fresh-point mint (`pointProvenance` off the invocation) works
                // through the apply term exactly as it does through the legacy bare-fn path
                // (which received `makeCallCtx(ctx.runCtx, ctx.currentInvocation)` as `this`). A
                // caller with no live invocation (a direct-JS call, or a dispatcher that only
                // holds a bare `runCtx`) hands down `makeCallCtx(runCtx)` — invocation undefined
                // — matching the legacy path's own fallback. conservation.law's seal-laundering
                // rows gate this equivalence.
                //
                // Bind via `set`, NOT bindRosetta — that would double-wrap the membrane
                // (this `run` is already the complete ctx-aware wrapper, unlike the legacy
                // bare-fn arm's raw `sym.fn`, which bindRosetta wraps for the first time).
                const rawRun = def.run as (this: unknown, ...args: unknown[]) => Promise<unknown>;
                const impl: CallableImpl = bakedImpl(rawRun as (this: CallCtx, ...args: unknown[]) => Promise<unknown>);
                const proc = new ARosettaProcedure({
                  name: verb,
                  arity: { min: 0, max: null }, // see ARITY above
                  contract: def,
                  // `strategy` is opaque (`unknown`, "until stage 3") — carries the resolved
                  // role, not a `{ pure: boolean }` shape.
                  strategy: { provenance: def.provenance },
                  impl,
                });
                // PROVENANCE STAMP (see above). Cache class has two co-equal readers:
                // `env.get(op).cacheClass` (the declared downstream surface) and the bake-closure
                // copy inside the `run` wrapper that the run-cache interception reads — same value.
                (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = def.provenance;
                if (def.cacheClass !== undefined) {
                  (proc as { cacheClass?: CacheClass }).cacheClass = def.cacheClass;
                }
                if (def.callbackRoles !== undefined) {
                  (proc as { callbackRoles?: CallbackRoles }).callbackRoles = def.callbackRoles;
                }
                // OWNER ASSOCIATION (1d) — see the `native` case's comment. A rosetta reads
                // `this.resources` from the run store iff the capability produces a bag.
                associateCapability(proc, ownerCapability, bakedReadsResources);
                bindTarget(def).set(verb, proc);
                break;
              }
              case "door": {
                // errors-as-doors: an OMITTED verb. Bind an INTROSPECTABLE DoorProcedure —
                // the causal-chain UX's first link. `def.cause` is stamped HERE when a
                // `symbol.notImplemented` door carries none (the factory can't know its own
                // capability — see notImplemented.ts): owner = this capability's OWN `name`,
                // needs = [] (a permanent design omission, never caused by an absent
                // config/dep — a non-empty `needs` is the door-set-degradation kind; see
                // `DoorCause`'s doc in _bake.ts for the full needs-scope rule). A door that
                // already carries a cause passes through unchanged. Firing still throws the
                // same teaching `PurityError` (DoorProcedure's own doc) — `PurityError.
                // feature`/`.owner` — the routing/telemetry keys, mirroring core.ts's
                // %purity-door → PurityError.
                const doorDef: DoorSymbolDef = def.cause
                  ? def
                  : { ...def, cause: { owner: capabilityName, needs: [] } };
                // Routes through `bindTarget`, same as every other kind (a `preludeOnly`
                // door — none exist yet, but the field is real on `DoorSymbolDef` now —
                // binds into the assembly's prelude scope, not the runtime env).
                bindTarget(def).set(verb, new DoorProcedure(doorDef));
                break;
              }
              case "keyword":
                // kernel KEYWORD: bind the first-class marker the evaluator dispatches on.
                // Resolving a call head to this VALUE → SPECIAL_FORMS[def.name] (the dual of
                // cxr): the special form is aliasable + lexically shadowable, unlike the
                // name-matched-before-lookup table it replaces.
                bindValue(env, verb, new AKernelKeyword(def.name));
                break;
              case "macro":
                // A non-evaluating MACRO form: bind the raw transformer (Macro/Syntax) as-is.
                // Not arg-evaluating (native/rosetta) nor evaluator-dispatched (keyword) — the
                // generic is_macro/is_syntax eval hook expands it. Home of syntax-rules +
                // preludeOnly assembly macros (`require/register-extension`). Routes through
                // `bindTarget` so `preludeOnly: true` lands on the assembly overlay.
                bindTarget(def).set(verb, def.macro);
                break;
              case "value":
                // Discriminated raw DATA binding (`symbol.value` — successor of the retired
                // untagged `{ value }` arm): bound via `bindValue` so a bare JS leaf is boxed
                // by its fromJS tail and a pre-boxed scheme value passes through. Never a
                // scheme call target.
                bindValue(env, verb, def.value as AmbientValue);
                break;
            }
            continue;
          }

          // ── LEGACY {fn}-record arm — still McpEnvCapability's downstream authoring shape
          // (the retired bare-`Fn` and `{ value }` arms used to land here / just above — see
          // `SymbolDeclaration`'s doc). Anything else reaching this point is a type-erased
          // violation; the guard keeps the error legible.
          invariant(
            isSymbolSpec(def),
            `EnvCapability "${capabilityName}": symbol "${verb}" is neither a baked symbol.* def nor a legacy { fn } record — the bare-Fn and { value } arms are retired.`,
          );
          const sym = def;
          const bound = (sym.fn as Fn).bind(activation);
          // Same activation-spawn middleware as `ensureSpawned` above — first touch gates on it.
          const gated =
            cellList.length === 0
              ? bound
              : async (...args: unknown[]) => {
                  await ensureSpawned();
                  return bound(...args);
                };
          // `bindRosetta` (AmbientRuntime.ts): wrap via createRosettaWrapper, bind, stamp
          // `rosettaTypesOf` when `.type` is declared and `env` is genuinely an
          // `AmbientRuntime` (never a test mock).
          bindRosetta(env, verb, { ...sym, fn: gated } as RosettaFunction);
        }
        if (spec.prelude !== undefined) {
          if (opts.evalScheme === undefined) throw new PreludeArmingError(name);
          // BOOTSTRAP: evaluate against `env` (= R, already re-parented onto the prelude
          // overlay by the caller) so prelude `define`s land in R — `ctx.preludeEvalScope` is
          // undefined here. MID-RUN: evaluate against the caller's discarded CHILD scope
          // instead, so a prelude `define` is dropped with it rather than leaking to the live env.
          await opts.evalScheme(ctx?.preludeEvalScope ?? env, spec.prelude);
        }

        // Pass 2: symbol.define / symbol.defineSyntax — evaluated + bound SEQUENTIALLY,
        // in declaration order, against the SAME scope a prelude evaluates against
        // (`ctx.preludeEvalScope ?? env`), now that every non-define kind (Pass 1) + the
        // prelude have already landed.
        if (defineEntries.length > 0) {
          await bindCapabilityDefines({
            capabilityName,
            ownNames,
            entries: defineEntries,
            deps: spec.deps ?? [],
            env,
            scope: ctx?.preludeEvalScope ?? env,
            bindTarget,
            evalScheme: opts.evalScheme,
          });
        }
      },
    };
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
   *  memoized per capability INSTANCE, not per `lower()` call: a module-singleton
   *  capability's export set never changes across assemblies. */
  exports(): Promise<ReadonlySet<string>> {
    this._exportsPromise ??= computeCapabilityExports(this.spec);
    return this._exportsPromise;
  }
}

/** The runtime half of `EnvCapability.define` (Stage 1c) — see the section immediately above
 *  the class, and `define()`'s own doc, for the full model. A THIN subclass over the SAME
 *  `lower()` body (1d): `super.lower(opts)` binds every symbol AND `associateCapability`s each
 *  one to THIS instance, so the run's `capabilityResources` store reaches this capability's
 *  `["arrival/get-resources"]` override below — no `apply()`-time rebind loop, no per-proc
 *  rewrap. The only per-form specialization is the three virtual hooks:
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

  protected override producesRunResources(): boolean {
    return this.resourcesFactory !== undefined;
  }

  protected override nativeReadsRunResources(): boolean {
    return this.resourcesFactory !== undefined;
  }
}
