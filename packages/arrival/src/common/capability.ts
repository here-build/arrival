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
  DoorCause,
  DoorSymbolDef,
  MacroSymbolDef,
  MaybePromise,
  MetadataRecord,
  NativeSymbolDef,
  RestSpec,
  RosettaSymbolDef,
  SequenceSymbolDef,
  TaglessGuardSymbolDef,
  TaglessSymbolDef,
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
import { ANativeProcedure, ARosettaProcedure, DoorProcedure } from "../values/primitives/ACallable.js";
import type { RosettaFunction } from "../membrane/rosetta.js";
// `bindRosetta`: the internal rosetta wiring (its retirement ledger lives in AmbientRuntime.ts).
// Two producers only — this legacy `SymbolDeclaration` bind arm and `provenance/replay.ts`'s
// playback frame; a third would be suspect.
import { bindRosetta, bindValue, AmbientRuntime, type AmbientValue, isAmbientRuntime } from "../env/AmbientRuntime.js";
import { associateCapability, CallCtx, type Face } from "./symbols/_bake.js";
import type { RunContext } from "../run/RunContext.js";
import { onRunContextDispose } from "../run/run-lifecycle.js";
import { AliasTargetError, AmbientShapeError, PreludeArmingError, SymbolKeyMismatchError } from "../errors.js";
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

/** A symbol is one of TWO families (collapsing toward ONE — the minted A-VALUE):
 *
 *  • Stage A2 (2026-07-22): the symbol.* FACTORIES now mint the runtime A-value directly —
 *    `symbol.native`/`sequence`/`tagless`/`tagless-guard` → `ANativeProcedure`, `rosetta` →
 *    `ARosettaProcedure`, `door`/`notImplemented` → `DoorProcedure`, `keyword` →
 *    `AKernelKeyword`, `value` → the boxed `AmbientValue` itself. Every one of these is
 *    already `instanceof AValue` (or a raw `AmbientValue` leaf for `value`'s bigint/
 *    Promise/binary passthrough cases) — `AmbientValue` alone covers the whole family, so
 *    it's the ONE arm below (dispatched by `instanceof` in apply(), not by a `kind` tag —
 *    see the per-kind cases). `symbol.define`/`symbol.defineSyntax` are the two-phase
 *    carve-out (their scheme body doesn't evaluate until `apply()`'s Pass 2 runs) and
 *    `symbol.macro` hands over an already-built `Macro` — all THREE stay plain, `kind`-
 *    tagged declarative records, dispatched exactly as before.
 *  • the LEGACY rosetta-config form (`{ fn, withContext, type, options }`) — `fn` reads
 *    `this: Activation` (bound at wire time). Load-bearing OUTSIDE arrival:
 *    `McpEnvCapability`'s whole inline-annotation design (MCP `description`/`inputSchema`
 *    spliced onto the same object as `fn`) is built on it, and the here.build discovery
 *    servers author verbs this way. Deleting it needs McpEnvCapability's annotation-lifting
 *    to move to baked-symbol splicing first (the postponed MCP rework) — NOT dead code.
 *
 *  Named `SymbolDeclaration`, not `SymbolDef`: the wider authoring shape a `symbols` record
 *  entry can literally BE, vs. `symbol.js`'s narrower `AEntity` (now a CONTRACT-data type only
 *  — it rides `.contract`/`.door` on a minted value, no longer a record traveling on its own).
 *
 *  `AliasSymbolDef` (`symbol.alias`) is a FIFTH arm: it never binds directly (see the
 *  apply-loop resolution below) — it only ever stands in for a sibling entry's already-baked
 *  value.
 *
 *  RETIREMENT PIN: `Exclude<AmbientValue, Fn>`, not bare `AmbientValue` — `AmbientValue`'s
 *  own `AProcedure` member (values/types.ts) is STRUCTURALLY a bare callable
 *  (`(this, ...args) => Result | …`), the exact shape the Stage-6 bare-`Fn` authoring arm
 *  retired (a capability declaring `symbols: { foo: someFn }` directly, bypassing both the
 *  symbol.* factories and the surviving `{ fn }` wrapper). `symbol.value`'s factory itself
 *  never MINTS a bare function (see value.ts: `isSchemeValue` passthrough or `fromJS`,
 *  neither of which produces one) — this `Exclude` keeps that true at the TYPE level too,
 *  matching `capability.test-d.ts`'s retirement pin. The runtime fallback below doors
 *  loudly on the (should-be-unreachable) case a mis-authored capability hands one anyway. */
export type SymbolDeclaration =
  | Exclude<AmbientValue, Fn>
  | MacroSymbolDef
  | DefineSymbolDef
  | DefineSyntaxSymbolDef
  | (Omit<RosettaSpec, "fn"> & { fn: Fn })
  | AliasSymbolDef;

// ── LEGACY-form guard — see `SymbolDeclaration`'s doc for why this one stays ─────────────
const isSymbolSpec = (m: SymbolDeclaration): m is Omit<RosettaSpec, "fn"> & { fn: Fn } =>
  typeof m === "object" && m !== null && "fn" in m;

/** `symbol.alias`'s marker — see `alias.ts`'s header for the full dissolution-semantics
 *  contract. Checked BEFORE every other dispatch in the apply loop (its `kind` — `"alias"` —
 *  is deliberately outside both the minted-value family and the three surviving declarative
 *  kinds, so it would otherwise fall through to the legacy `{ fn }`-guessing arm instead). */
const isAliasDef = (m: SymbolDeclaration): m is AliasSymbolDef =>
  typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "alias";

/** The three SURVIVING declarative record kinds — `symbol.define`/`symbol.defineSyntax` (the
 *  two-phase carve-out) and `symbol.macro` (already hands over a real `Macro`, but stays a
 *  `{kind, name, macro}` record so `preludeOnly` routing has somewhere to live). Every OTHER
 *  kind mints its A-value directly now (see `SymbolDeclaration`'s doc), so a plain object
 *  carrying one of these three `kind` tags is unambiguous — none of the minted classes'
 *  OWN `.kind` field (`"procedure"`/`"keyword"`/an ordinary scheme-value kind) collides with
 *  `"define"`/`"define-syntax"`/`"macro"`. */
const isDeclarativeDef = (
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
 *  `s/string`), bound at runtime under its own record key (see `apply()`'s Pass-2 loop).
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
    // `["arrival/get-resources"]`, single-flighted + collapsed there) — see RunContext.ts. Stage
    // A2: the impl adapter (`(args, callCtx) => rawRun.apply(callCtx, args)`) now lives INSIDE each
    // factory (native.ts/rosetta.ts/sequence.ts/tagless.ts/taglessGuard.ts), minted once at bake —
    // this file no longer builds it.
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
        // Two-phase binding (docs/environments.md §PRELUDE): symbol.define/symbol.defineSyntax entries
        // are collected here (in declaration order — JS object-key insertion order) and
        // evaluated+bound in Pass 2, AFTER every other kind. `ownNames` is the letrec* NAME
        // VISIBILITY set — see `BindCapabilityDefinesArgs.ownNames` (define-bake.ts) for the full
        // contract.
        const defineEntries: [string, DefineSymbolDef | DefineSyntaxSymbolDef][] = [];
        const ownNames = new Set<string>();
        for (const [name, rawDef] of Object.entries(symbolsRec)) {
          // `symbolPrefix` retired (2026-07-22): it had exactly one author across the whole
          // codebase — a mercury test fixture — never a production capability; the bound
          // verb is simply the record key now.
          const verb = name;
          ownNames.add(verb);

          // symbol.alias dissolution: substitute the TARGET's already-baked def in place of
          // the marker, then fall through the SAME per-kind dispatch below — the alias binds
          // byte-identically to its target under its own name (`verb`), never a wrapper.
          // `symbolsRec` is already fully built (see alias.ts's header) so a sibling lookup
          // here — regardless of iteration order — is sound; a target absent from THIS
          // capability's own record, or itself an alias (no chains), is a declaration bug and
          // doors loudly rather than silently binding nothing.
          let def: SymbolDeclaration = rawDef;
          // KEY-NAME MISMATCH gate (SymbolKeyMismatchError, below): deliberately SKIPPED for
          // an alias-resolved entry — dissolution is a duplicate binding of a SIBLING's
          // value under a DIFFERENT name BY DESIGN (`symbol.alias`'s whole point), so the
          // resolved value's own mint-time name legitimately disagrees with `name` (the
          // alias's OWN record key) here.
          const viaAlias = isAliasDef(rawDef);
          if (viaAlias) {
            const targetDef = symbolsRec[(rawDef as AliasSymbolDef).target];
            if (targetDef === undefined) {
              throw new AliasTargetError(capabilityName, name, (rawDef as AliasSymbolDef).target, "missing-target");
            }
            if (isAliasDef(targetDef)) {
              throw new AliasTargetError(capabilityName, name, (rawDef as AliasSymbolDef).target, "chained-alias");
            }
            def = targetDef;
          }

          if (isDeclarativeDef(def)) {
            if (def.kind === "define" || def.kind === "define-syntax") {
              defineEntries.push([verb, def]);
              continue;
            }
            // "macro": a non-evaluating MACRO form: bind the raw transformer (Macro/Syntax)
            // as-is. Not arg-evaluating (native/rosetta) nor evaluator-dispatched (keyword) —
            // the generic is_macro/is_syntax eval hook expands it. Home of syntax-rules +
            // preludeOnly assembly macros (`require/register-extension`). Routes through
            // `bindTarget` so `preludeOnly: true` lands on the assembly overlay.
            bindTarget(def).set(verb, def.macro);
            continue;
          }

          // ── STAGE A2: symbol.* factories mint the A-VALUE directly — dispatch by
          // `instanceof`, not a `kind` tag (see `SymbolDeclaration`'s doc above). Each
          // branch's CONTRACT data rides `.contract` (native/rosetta/sequence/tagless/
          // tagless-guard) or `.door` (door); a KEY-NAME mismatch between the record's own
          // entry and the value's mint-time identity doors (SymbolKeyMismatchError) instead
          // of silently drifting — every kind here carries enough self-identity to check it
          // EXCEPT the final `value`-kind catch-all (a boxed leaf carries no declaration-
          // site name).
          //
          //   ARITY — `arity: { min: 0, max: null }` (minted at bake, in the factory) is
          //     introspection-only in this cut; the kinds self-check. Tighten from
          //     `contract.in` when the MCP/type-lens surface consumes it.
          //
          //   PROVENANCE / CACHE-CLASS / CALLBACK-ROLES — stamped by the FACTORY at MINT
          //   time now (native.ts/rosetta.ts/sequence.ts/tagless.ts/taglessGuard.ts), not
          //   here; this loop only still reads `contract.requiresConfig`/`contract
          //   .preludeOnly` (config/assembly-scope concerns that genuinely vary PER
          //   `lower()` call) and performs OWNER ASSOCIATION.
          //
          //   OWNER ASSOCIATION is now called on a value that may be a SHARED SINGLETON
          //   across every `lower()` call of this module-singleton capability (the factory
          //   mints it ONCE, at `symbols` — record-literal evaluation time) — harmless:
          //   `associateCapability` is idempotent for a repeat call under the SAME owning
          //   capability (`run/CallCtx.ts`'s own doc), so re-associating the same value on
          //   every apply() of the same capability is a no-op past the first.
          if (def instanceof ANativeProcedure) {
            // Unifies native/sequence/tagless/tagless-guard — all four mint this SAME
            // class (D1: kind lives on the contract, not the runtime class);
            // `contract.kind` tells them apart for the two things that still differ per
            // assembly: the requiresConfig gate (native only — sequence/tagless/
            // tagless-guard contracts carry no such field) and which readsResources
            // answer applies.
            const contract = def.contract as
              | NativeSymbolDef
              | SequenceSymbolDef
              | TaglessSymbolDef
              | TaglessGuardSymbolDef;
            if (!viaAlias && contract.name !== name) throw new SymbolKeyMismatchError(capabilityName, name, contract.name);
            if (contract.kind === "native") {
              // STAGE 3 AUTO-DERIVED DOOR (`Contract.requiresConfig`, ./symbols/_bake.js) —
              // read UNCONDITIONALLY, before the ordinary bind: an absent declared key mints
              // a cause-carrying DoorProcedure for this verb instead, via the SAME
              // `DegradationInfo.door` builder a manual builder-form `symbols` calls by hand
              // (`activation.degradation`, always defined — see its own doc). No mode gate:
              // fires under `"forbid"` too, closing the pre-Stage-3 gap where this reached
              // for a bare-required config key and threw a ZodError at `schema.parse` instead.
              const missingNative = missingRequiresConfig(
                contract.requiresConfig,
                activation.configuration as Record<string, unknown>,
              );
              if (missingNative !== undefined) {
                bindTarget(contract).set(
                  verb,
                  new DoorProcedure(
                    activation.degradation.door(
                      verb,
                      requiresConfigNeeds(missingNative),
                      requiresConfigReason(missingNative, contract.doc),
                    ),
                  ),
                );
                continue;
              }
              // OWNER ASSOCIATION (1d, docs/execution.md §CALLCTX): key THIS bound value to its
              // OWNING CAPABILITY (object identity), so a real dispatch (evaluator.ts, via
              // makeCallCtx) enriches the `CallCtx` it builds — `configuration` resolves at
              // dispatch off the RUN now (`runCtx.capabilityConfigurations`), never carried
              // here. `readsResources` is FALSE for a base/constructor native (the legacy arm —
              // see `nativeReadsRunResources`'s doc); triggering the run store here would
              // double-spawn. `EnvCapability.define`'s form flips this via
              // `nativeReadsRunResources()`.
              associateCapability(def, ownerCapability, nativeReadsResources);
              bindTarget(contract).set(verb, def);
              continue;
            }
            // sequence / tagless / tagless-guard: no requiresConfig channel on these
            // contracts. OWNER ASSOCIATION (1d) — see the `native` arm's comment. A
            // non-native baked verb reads `this.resources` from the run store iff the
            // capability produces a bag.
            associateCapability(def, ownerCapability, bakedReadsResources);
            bindTarget(contract).set(verb, def);
            continue;
          }
          if (def instanceof ARosettaProcedure) {
            const contract = def.contract as RosettaSymbolDef;
            if (!viaAlias && contract.name !== name) throw new SymbolKeyMismatchError(capabilityName, name, contract.name);
            // STAGE 3 AUTO-DERIVED DOOR — same gate as the `native` arm above; `contract.doc`
            // is the rosetta verb's own doc string.
            const missingRosetta = missingRequiresConfig(
              contract.requiresConfig,
              activation.configuration as Record<string, unknown>,
            );
            if (missingRosetta !== undefined) {
              bindTarget(contract).set(
                verb,
                new DoorProcedure(
                  activation.degradation.door(
                    verb,
                    requiresConfigNeeds(missingRosetta),
                    requiresConfigReason(missingRosetta, contract.doc),
                  ),
                ),
              );
              continue;
            }
            // OWNER ASSOCIATION (1d) — see the `native` arm's comment. A rosetta reads
            // `this.resources` from the run store iff the capability produces a bag.
            associateCapability(def, ownerCapability, bakedReadsResources);
            bindTarget(contract).set(verb, def);
            continue;
          }
          if (def instanceof DoorProcedure) {
            if (!viaAlias && def.door.name !== name) throw new SymbolKeyMismatchError(capabilityName, name, def.door.name);
            // errors-as-doors: an OMITTED verb. `def.door.cause` is stamped HERE, IN PLACE,
            // the first time this (shared, module-singleton) DoorProcedure is bound — the
            // factory (`notImplemented.ts`) can't know its own owning capability at mint
            // time. owner = this capability's OWN `name`, needs = [] (a permanent design
            // omission, never caused by an absent config/dep — a non-empty `needs` is the
            // door-set-degradation kind; see `DoorCause`'s doc in _bake.ts for the full
            // needs-scope rule). Idempotent: a later `lower()` of the SAME capability sees
            // `cause` already set and skips — a door bound instead via `requiresConfig`'s
            // auto-door path above mints its OWN fresh DoorProcedure per assembly, so it
            // never reaches here at all. Firing still throws the same teaching `PurityError`
            // (DoorProcedure's own doc) — `PurityError.feature`/`.owner` — the
            // routing/telemetry keys, mirroring core.ts's %purity-door → PurityError.
            if (def.door.cause === undefined) {
              (def.door as { cause?: DoorCause }).cause = { owner: capabilityName, needs: [] };
            }
            // Routes through `bindTarget`, same as every other kind (a `preludeOnly` door —
            // none exist yet, but the field is real on `DoorSymbolDef` now — binds into the
            // assembly's prelude scope, not the runtime env).
            bindTarget(def.door).set(verb, def);
            continue;
          }
          if (def instanceof AKernelKeyword) {
            // kernel KEYWORD: bind the first-class marker the evaluator dispatches on.
            // Resolving a call head to this VALUE → SPECIAL_FORMS[def.name] (the dual of
            // cxr): the special form is aliasable + lexically shadowable, unlike the
            // name-matched-before-lookup table it replaces.
            if (!viaAlias && def.name !== name) throw new SymbolKeyMismatchError(capabilityName, name, def.name);
            bindValue(env, verb, def);
            continue;
          }

          // ── LEGACY {fn}-record arm — still McpEnvCapability's downstream authoring shape
          // (the retired bare-`Fn` and untagged `{ value }` arms used to land here — see
          // `SymbolDeclaration`'s doc).
          if (isSymbolSpec(def)) {
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
            continue;
          }

          // RETIREMENT DOOR: a bare function reaching here is the Stage-6-retired bare-`Fn`
          // authoring arm (`symbols: { foo: someFn }`, bypassing both the symbol.* factories
          // and the surviving `{ fn }` wrapper) — `SymbolDeclaration`'s own type excludes it
          // (see that type's doc), so this is a type-erased/stale-dist violation, not a
          // reachable path for a type-checked capability. Doors loudly rather than silently
          // admitting it through `bindValue`'s function carve-out (which exists for OTHER
          // internal producers — bindRosetta's wrapper, the evaluator's catch-frame Error
          // bind — never a raw `symbols` record entry).
          invariant(
            typeof def !== "function",
            `EnvCapability "${capabilityName}": symbol "${verb}" is a bare function — the bare-Fn authoring arm is retired; declare it as \`{ fn }\` (the surviving legacy arm) or a baked symbol.* def.`,
          );

          // ── `symbol.value` — the ONLY remaining minted shape: a raw DATA binding (never a
          // scheme call target), already boxed at MINT time (value.ts's own `fromJS` tail —
          // successor of the retired untagged `{ value }` arm). gap-a ruling (2026-07-22):
          // the factory now stamps `{kind:"value",name,doc}` onto the box's own `.contract`
          // too (own, non-enumerable, define-once — value.ts), so the SAME key-name check
          // every other kind runs applies here as well via `contractOf` — absent only for
          // the narrow bigint-leaf gap (a primitive can't carry a hidden property). No
          // requiresConfig/preludeOnly channel — bound straight through `bindValue`, exactly
          // as before (a bare JS leaf or a pre-boxed scheme value alike).
          const valueEntity = contractOf(def);
          if (!viaAlias && valueEntity !== undefined && valueEntity.name !== name) {
            throw new SymbolKeyMismatchError(capabilityName, name, valueEntity.name);
          }
          bindValue(env, verb, def as AmbientValue);
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
