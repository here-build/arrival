// capability — EnvCapability: the ONE shape every palette pack uses.
//
// `export default new EnvCapability(name, { configuration, resources, prelude, methods, deps })`
//   • a MODULE SINGLETON (one `new` per package) — no factories, no accidental dupes;
//   • INHERITANCE-FREE — the contribution surface is a CLOSED taxonomy (the 5 spec
//     keys), configured by composition, never subclassed;
//   • IN-DEPTH INFERRABLE — `methods` carries `ThisType<Activation<C,R>>`, so inside
//     any method `this.configuration.<k>` is `z.infer`'d and `this.resources.<k>` is
//     the typed `Ref`, with ZERO annotations. Methods are static (defined once on the
//     spec), bound to the per-env activation at wire time — no per-env closure churn.
//
// Lowers to a kernel `EnvPack`: apply = wire methods (membrane-wrapped) + eval prelude.
// Resources become ref-counted `ResourceCell`s on the activation (the `this.resources`).

import { z } from "zod";

import type { EnvPack, PackContext, PreludeBindTarget } from "./kernel.js";
import { type Ref, type Resource, ResourceCell, spinUpAll, windDownAll } from "./resources.js";
import type { EvalSchemeInto, ResolverSpec, RosettaSpec, SchemeEnv } from "./scheme-env.js";
import type { AEntity, DefineSymbolDef, DefineSyntaxSymbolDef, DoorSymbolDef } from "./symbol.js";
import { bindCapabilityDefines, computeCapabilityExports } from "./symbols/define-bake.js";
import type { AliasSymbolDef } from "./symbols/alias.js";
import { Keyword } from "../values/Keyword.js";
import {
  ANativeProcedure,
  ARosettaProcedure,
  DoorProcedure,
  type CallableImpl,
} from "../values/primitives/ACallable.js";
import type { RunContext } from "../values/primitives/RunContext.js";
// The dependency-free ambient leaf (see its header): the evaluator installs the current
// invocation there at every apply site; the rosetta bind adapter reads it back. No cycle —
// the leaf imports nothing.
import { currentDynamicCallSite } from "../eval/dynamic-call-site.js";
import type { InvocationLike, RosettaFunction } from "../rosetta.js";
// The retired public `env.defineRosetta` method's internal replacement — this legacy
// `SymbolDeclaration` bind arm and `provenance/replay.ts`'s playback frame are its only
// two producers (env-capability-authoring skill's migration recipes name this the way in).
import { bindRosetta, bindValue, AmbientRuntime, type AmbientValue, isAmbientRuntime } from "../AmbientRuntime.js";
import { CallCtx, makeCallCtx, type CacheClass, type CallbackRoles, type ProvenanceRole } from "./symbols/_bake.js";
import { type SchemeValue } from "../values/types.js";
import { AliasTargetError, AmbientShapeError, PreludeArmingError } from "../errors.js";
import {
  buildDegradationInfo,
  collectDegraded,
  missingOptionalKeys,
  type DegradationInfo,
  type DegradationMode,
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
   *  The phase-2 read channel (exec-phases-and-dynamic-metadata.md §2.4): `assembleEnv`
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
  /** Door-set degradation — see `./degradation.js`'s `DegradationInfo`.
   *  Present on EVERY activation (informational under `"forbid"`, the default — no capability
   *  is affected unless it explicitly consults `.door(...)`); a builder-form `symbols` MAY
   *  destructure it to trade a manual `if (x !== undefined)` withhold for a cause-carrying
   *  door under `"doors"` mode (see `@inhuman.tools/arrival/loader`'s `require`/`require/extension`
   *  for the migrated shape). */
  readonly degradation: DegradationInfo;
}

type Fn = (...args: any[]) => unknown;

/** A symbol is one of THREE families:
 *
 *  • the BAKED `AEntity` from the symbol.* API (`{ kind: "native" | "rosetta" | "door" | … }`)
 *    — dispatched by `kind` in apply(). The ONLY form every pack under `foundations/arrival/**`
 *    declares.
 *  • a raw VALUE binding (`{ value }`) — a PERMANENT, deliberate arm, not a migration remnant.
 *    Reserved for the CALLABLE RULE's one true exception: a binding `require`'s loader
 *    machinery resolves and calls directly in JS-land, never through the scheme evaluator (no
 *    rosetta marshal makes sense for a value that's never a scheme call target) —
 *    `packs/ext-yaml.ts` / `packs/ext-toml.ts`'s `ext/yaml/resolve`-shaped bindings are the
 *    known holders.
 *  • a LEGACY form — a bare fn, or a rosetta config (`{ fn, withContext, type, options }`) —
 *    read `this` (`ThisType<Activation<C,R>>`, bound at wire time). Gone from `foundations/
 *    arrival/**` itself, but load-bearing OUTSIDE it: `McpEnvCapability`'s whole
 *    inline-annotation design (MCP `description`/`inputSchema` spliced onto the same object as
 *    `fn`) is built on it, and every downstream capability (here.build's `saas/server/
 *    {arrival,mcp}`, inhuman's `saas/mcp`, the `sift-submission/mcp/packs/*` forensics catalog)
 *    still authors verbs this way. Deleting this arm needs McpEnvCapability's annotation-lifting
 *    to move to baked-symbol splicing first — a separate migration; NOT dead code.
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
  | Fn
  | (Omit<RosettaSpec, "fn"> & { fn: Fn })
  | { value: unknown }
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
    (m as { kind: unknown }).kind === "define-syntax");

// ── LEGACY-form guards — see `SymbolDeclaration`'s doc for why these stay ────────────────
const isValueDef = (m: SymbolDeclaration): m is { value: unknown } =>
  typeof m === "object" && m !== null && "value" in m;
const isSymbolSpec = (m: SymbolDeclaration): m is Omit<RosettaSpec, "fn"> & { fn: Fn } =>
  typeof m === "object" && m !== null && "fn" in m;

/** `symbol.alias`'s marker — see `alias.ts`'s header for the full dissolution-semantics
 *  contract. Checked BEFORE `isBakedDef` in the apply loop (its `kind` — `"alias"` — is
 *  deliberately outside `AEntity`'s discriminant set, so `isBakedDef` alone would never
 *  recognize it and it would fall through to the legacy `{ fn }`-guessing arm instead). */
const isAliasDef = (m: SymbolDeclaration): m is AliasSymbolDef =>
  typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "alias";

/** A `symbols` record, or a BUILDER computing it from the activation (per-env config).
 *  The builder form is how a config-bearing capability closes host resolvers into its baked
 *  verbs (`arrivalInferCapability`, `arrivalDataCapability`, …) without riding them on `this` —
 *  or (legacy shape) how a helper-delegating pack used to express symbols via `captureSymbols`. */
export type SymbolsSpec<C extends ZodMap, R extends Record<string, Resource<unknown>>> =
  | (Record<string, SymbolDeclaration> & ThisType<Activation<C, R>>)
  | ((activation: Activation<C, R>) => Record<string, SymbolDeclaration>);

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
  /** catchall fallback resolvers this capability contributes — registered on the env
   *  at apply (e.g. the `:key` keyword accessor, the unbounded `c[ad]+r` family). A
   *  resolver maps a name the env did NOT bind to a value; it may return a membrane
   *  primitive (the `:key` pluck) — NOT rosetta-wrapped, it IS the membrane. */
  resolvers?: readonly ResolverSpec[];
  /** DAG edges = capability grants. */
  deps?: readonly EnvCapability[];
  /** the verbs this capability exposes — baked `symbol.native`/`symbol.rosetta`/… declarations
   *  (the target form everything under `foundations/arrival` now uses), or (legacy shape,
   *  still load-bearing for `McpEnvCapability`'s downstream population — see
   *  `SymbolDeclaration`'s doc) a `Record<name, RosettaConfig>` whose `fn` reads `this`
   *  (`this.configuration.*` / `this.resources.*.live`), with `this` typed as `Activation<C,R>`
   *  (ThisType, inferred). A config-bearing BAKED capability instead uses the BUILDER form
   *  (`(activation) => ({...})`) to close a host resolver from `configuration` into each verb's
   *  impl — a baked rosetta's `this` is the per-call INVOCATION context
   *  (`this.invocation`/`this.abortSignal`), not the activation, so config can't ride `this` there. */
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

/** A configured, lowerable env capability. The default export of every palette pack. */

export class EnvCapability<C extends ZodMap = any, R extends Record<string, Resource<unknown>> = any> {
  constructor(
    readonly name: string,
    readonly spec: CapabilitySpec<C, R>,
  ) {}

  /** Lower to a kernel `EnvPack`. `evalScheme` runs the prelude (required iff a prelude
   *  exists); `config` is validated against the `configuration` schemas.
   *
   *  `degradation`: `"forbid"` (the default — host/provisioning posture) or `"doors"`
   *  (program-scoped callers opt in). Threaded to every dep's own `lower()` call, same
   *  as `evalScheme`/`config` — a
   *  degraded dep and a degraded root see the SAME mode. Changes nothing by itself: it only
   *  affects capabilities whose `symbols` builder explicitly consults
   *  `Activation.degradation` (see `./degradation.js`). */
  lower(
    opts: { evalScheme?: EvalSchemeInto; config?: Partial<InferCfg<C>>; degradation?: DegradationMode } = {},
  ): LoweredPack {
    const { spec, name } = this;
    // A SEPARATE alias for `apply()`'s door-bind arm: the per-symbol loop below rebinds
    // `name` to each entry's OWN key (`for (const [name, def] of Object.entries(...))`),
    // shadowing this capability-level `name` for the rest of that block — reading `name`
    // from inside the "door" case would stamp the SYMBOL's name as the cause owner, not
    // the capability's.
    const capabilityName = name;

    const schema = spec.configuration ? z.object(spec.configuration as ZodMap) : z.object({});
    const configuration = schema.parse(opts.config ?? {}) as InferCfg<C>;

    // Door-set degradation: computed from the RAW config bag (pre-`schema.parse`,
    // which already ran above and would have thrown for a present-but-invalid or a
    // genuinely-required-and-absent key — this scan only ever looks at declared-OPTIONAL
    // keys, so it never masks either of those two throw paths). `"forbid"` (unset) makes
    // `missingKeys` purely informational — `.active` stays false, so no capability's
    // behavior changes unless it opted in.
    const degradationMode: DegradationMode = opts.degradation ?? "forbid";
    const missingKeys = missingOptionalKeys(
      spec.configuration as Record<string, z.ZodTypeAny> | undefined,
      opts.config as Record<string, unknown> | undefined,
    );
    const degradation = buildDegradationInfo(capabilityName, degradationMode, missingKeys);

    // Resources → ref-counted cells. A provider entry reads the parsed config.
    const cells = {} as Record<string, ResourceCell<unknown>>;
    for (const [key, def] of Object.entries(spec.resources ?? {})) {
      const resource = (
        typeof def === "function" ? (def as (c: InferCfg<C>) => Resource<unknown>)(configuration) : def
      ) as Resource<unknown>;
      cells[key] = new ResourceCell(resource);
    }
    const activation = { configuration, resources: cells, degradation } as unknown as Activation<C, R>;

    // Computed HERE (not inside apply()): the builder-form `symbols` takes ONLY `activation`
    // (never `env`/`ctx` — the type contract), which is fully known by this point, exactly
    // like `resources`/`configuration` already are. Computing it once, eagerly, lets
    // `degraded` (below) inspect what this lower() actually produced instead of guessing.
    const symbolsRec = typeof spec.symbols === "function" ? spec.symbols(activation) : (spec.symbols ?? {});
    // Door-set degradation's OWN surfacing — degraded capabilities are ENUMERABLE: scan
    // the computed record for doors this capability minted via `degradation.door(...)`,
    // folded into the returned pack's `degraded` field — `assembleEnv` (kernel.ts)
    // aggregates it into `AssembledEnv.degraded`, uninterpreted.
    const degraded = collectDegraded(capabilityName, symbolsRec);

    // First touch of ANY of this capability's symbols spawns ALL its resources
    // (single-flight), BEFORE the method body runs — so methods read `this.resources
    // .x.live` synchronously, never an `await .get()`. The capability dictates the
    // entity set; the env accessor (this wrapper) makes presence a precondition.
    const cellList = Object.values(cells);
    let spawned: Promise<void> | undefined;
    const ensureSpawned = (): Promise<void> =>
      (spawned ??= Promise.all(cellList.map((c) => c.get())).then(() => undefined));

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
        // HERMETIC NARROW (instanceof DOOR, never a cast): with `SchemeEnv.set` hard-deleted,
        // binding goes through the module-internal `bindValue` (AmbientRuntime.ts), which writes
        // real AmbientRuntime storage. Packs are applied onto real envs everywhere in production
        // (env-roots leaves, `LexicalScope.fresh()` roots, `inherit()` children thereof); a
        // synthetic structural env cannot RECEIVE bindings — assemble onto a real frame instead.
        if (!isAmbientRuntime(env)) {
          throw new AmbientShapeError(
            `capability "${name}"`,
            `apply target is not an arrival AmbientRuntime — a capability's bindings ` +
              `land in real environment storage (the JS-side write surface is retired; hermetic-AmbientRuntime ` +
              `ruling). Assemble onto \`LexicalScope.fresh().env\`, an env-roots base, or a child of one.`,
          );
        }
        // The env-backed bind face, shaped like the kernel's PreludeBindTarget shim so
        // `bindTarget` stays ONE type either way. The narrow from the shim's `unknown` is a
        // boundary cast per this file's applyCallback convention: every value routed through
        // it below is a constructed AmbientValue (ANativeProcedure/DoorProcedure/Macro/…).
        const envTarget: PreludeBindTarget = { set: (n, v) => bindValue(env, n, v as AmbientValue) };
        // preludeOnly routing: a baked native/rosetta def marked `preludeOnly: true`
        // binds onto `ctx.preludeScope` instead of the runtime env — see
        // `PackContext.preludeScope` in kernel.ts for the full assembly-time-only contract. Same
        // bind form either way (native → raw impl; rosetta → the gated run wrapper); only the
        // TARGET scope differs. Absent `ctx.preludeScope` (a bare direct apply outside any
        // assembly), fall back to `env` so the symbol is never silently dropped.
        const bindTarget = (def: AEntity): PreludeBindTarget =>
          "preludeOnly" in def && def.preludeOnly ? (ctx?.preludeScope ?? envTarget) : envTarget;
        const prefix = spec.symbolPrefix ?? "";
        // Two-phase binding: symbol.define/symbol.defineSyntax entries are collected
        // here (in declaration order — JS object-key insertion order) and evaluated+bound
        // in Pass 2, AFTER every other kind — never interleaved, so a define's body may
        // always assume its capability's own native/rosetta/door/… siblings are already
        // bound. `ownNames` is the letrec* NAME VISIBILITY set — see
        // `BindCapabilityDefinesArgs.ownNames` (define-bake.ts) for the full contract.
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

          // ── BAKED symbol.* forms — dispatch by kind (the target path). ──────────────
          if (isBakedDef(def)) {
            switch (def.kind) {
              case "native": {
                // A native is a CONTOUR primitive — bind it as a first-class ANativeProcedure
                // (callable-as-value), invoked through its `arrival/tagless-final/apply` term.
                // The stored impl adapts the term surface `(args, runCtx)` to the legacy host
                // impl, which reads run-state off `this: CallCtx` (`makeCallCtx(runCtx)`) — no
                // `this=undefined` crash from a HOF-invoked native. Provenance-transparent: a
                // native value-op is a pure transform, never a source.
                const hostImpl = def.impl as (this: CallCtx, ...a: unknown[]) => unknown;
                const proc = new ANativeProcedure({
                  name: verb,
                  // Arity is introspection-only in this cut (natives self-check); tighten from
                  // `def.in` when the MCP/type-lens surface consumes it.
                  arity: { min: 0, max: null },
                  contract: def,
                  impl: (args, runCtx) => hostImpl.apply(makeCallCtx(runCtx), args) as SchemeValue,
                });
                // Stamp the RESOLVED provenance role onto the bound value — the lineage
                // classifier reads it OFF THE BOUND VALUE via `env.get(op)`, never a duck-read.
                // The resolved per-lambda-arm callback roles (element-transformer/control/
                // effect/accumulator) ride the same seam, read as data by the classifier and
                // the wireframe builder. The cache class (Ruling A — the CACHE axis, lineage-
                // independent) rides it too, stamped only when declared (absent = regenerateable).
                (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = def.provenance;
                if (def.cacheClass !== undefined) {
                  (proc as { cacheClass?: CacheClass }).cacheClass = def.cacheClass;
                }
                if (def.callbackRoles !== undefined) {
                  (proc as { callbackRoles?: CallbackRoles }).callbackRoles = def.callbackRoles;
                }
                bindTarget(def).set(verb, proc);
                break;
              }
              case "sequence":
              case "tagless":
              case "tagless-guard": {
                // `run` is the complete ctx-aware wrapper. Bind it as a first-class
                // ANativeProcedure invoked through the `arrival/tagless-final/apply` term —
                // no bare JS functions in env value space (P1: a value is a term both
                // interpreters can execute). These three kinds read ONLY `this.runCtx` —
                // the apply term's threaded runCtx
                // reconstructs their `this` losslessly (`makeCallCtx(runCtx)`). Resource
                // pre-spawning gates inside the impl when the capability owns cells.
                //
                // The kinds' `.run` share the call SHAPE but not a common `this` type
                // (tagless/tagless-guard declare none at all) — erase once here, the same
                // boundary rosetta.ts's own `rawImpl` crosses.
                const rawRun = def.run as (this: unknown, ...args: unknown[]) => Promise<unknown>;
                // Boundary cast per applyCallback's convention: the wrapper produces scheme
                // values by construction; TS sees only `unknown`.
                const impl: CallableImpl =
                  cellList.length === 0
                    ? (args, runCtx) => rawRun.apply(makeCallCtx(runCtx), args) as Promise<SchemeValue>
                    : async (args, runCtx) => {
                        await ensureSpawned();
                        return (await rawRun.apply(makeCallCtx(runCtx), args)) as SchemeValue;
                      };
                const proc = new ANativeProcedure({
                  name: verb,
                  // Arity is introspection-only in this cut; tighten from `def.in` when the
                  // MCP/type-lens surface consumes it.
                  arity: { min: 0, max: null },
                  contract: def,
                  impl,
                });
                // Stamp the RESOLVED provenance role (all three kinds carry `.provenance`
                // on the def itself — sequence()/tagless()/taglessGuard() resolve it at bake
                // time) onto the bound value, same seam as the native case above — plus the
                // callback roles (sequence: bake-extracted; tagless: `withCallbackRoles`-
                // declared, e.g. reduce's acc-chain marker). Cache class: only `sequence`
                // carries a Contract to declare one on (tagless kinds are contract-less by
                // construction — no channel, so nothing to stamp).
                (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = def.provenance;
                if (def.kind === "sequence" && def.cacheClass !== undefined) {
                  (proc as { cacheClass?: CacheClass }).cacheClass = def.cacheClass;
                }
                if (def.callbackRoles !== undefined) {
                  (proc as { callbackRoles?: CallbackRoles }).callbackRoles = def.callbackRoles;
                }
                bindTarget(def).set(verb, proc);
                break;
              }
              case "rosetta": {
                // The per-call INVOCATION reaches the wrapper from the evaluator's ambient
                // dynamic call site — evaluator-owned state, installed at every apply site
                // (`setDynamicCallSite(ctx.currentInvocation)` around evalPair /
                // applyArrowProc / wrapLambda dispatch) — never smuggled by this binder. The
                // adapter reconstructs the wrapper's `CallCtx` from (runCtx, ambient), so a
                // SOURCE rosetta's fresh-point mint (`pointProvenance` off the invocation)
                // works through the apply term exactly as it does through the legacy bare-fn
                // path (which receives `makeCallCtx(ctx.runCtx, ctx.currentInvocation)` as
                // `this`). A direct-JS call with no evaluator frame sees no ambient → the
                // input-union fallback, matching the legacy path's own fallback.
                // conservation.law's seal-laundering rows gate this equivalence.
                //
                // Bind via `set`, NOT bindRosetta — that would double-wrap the membrane
                // (this `run` is already the complete ctx-aware wrapper, unlike the legacy
                // bare-fn arm's raw `sym.fn`, which bindRosetta wraps for the first time).
                const rawRun = def.run as (this: unknown, ...args: unknown[]) => Promise<unknown>;
                // Boundary casts per applyCallback's convention: the wrapper produces
                // scheme values by construction; the ambient site is opaque by design and
                // narrows at this one seam (the same shape evaluator.ts's own
                // `ctx.currentInvocation as InvocationLike | undefined` sites use).
                const rosettaCtx = (runCtx: RunContext) =>
                  makeCallCtx(runCtx, currentDynamicCallSite() as InvocationLike | undefined);
                const impl: CallableImpl =
                  cellList.length === 0
                    ? (args, runCtx) => rawRun.apply(rosettaCtx(runCtx), args) as Promise<SchemeValue>
                    : async (args, runCtx) => {
                        await ensureSpawned();
                        return (await rawRun.apply(rosettaCtx(runCtx), args)) as SchemeValue;
                      };
                const proc = new ARosettaProcedure({
                  name: verb,
                  // Arity is introspection-only in this cut, same as the sibling kinds.
                  arity: { min: 0, max: null },
                  contract: def,
                  // `strategy` is opaque (`unknown`, "until stage 3") — carries the resolved
                  // role, not a `{ pure: boolean }` shape.
                  strategy: { provenance: def.provenance },
                  impl,
                });
                // Same stamp as the native/sequence cases — the classifier reads it off the
                // bound value uniformly across every callable kind (callback roles included).
                // The cache class rides here too: `env.get(op).cacheClass` is the declared
                // read surface for downstream consumers; the run-cache interception itself
                // reads the bake-closure copy inside the `run` wrapper (same resolved value).
                (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = def.provenance;
                if (def.cacheClass !== undefined) {
                  (proc as { cacheClass?: CacheClass }).cacheClass = def.cacheClass;
                }
                if (def.callbackRoles !== undefined) {
                  (proc as { callbackRoles?: CallbackRoles }).callbackRoles = def.callbackRoles;
                }
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
                bindValue(env, verb, new Keyword(def.name));
                break;
              case "macro":
                // A non-evaluating MACRO form: bind the raw transformer (Macro/Syntax) as-is.
                // Not arg-evaluating (native/rosetta) nor evaluator-dispatched (keyword) — the
                // generic is_macro/is_syntax eval hook expands it. Home of syntax-rules +
                // preludeOnly assembly macros (`require/register-extension`). Routes through
                // `bindTarget` so `preludeOnly: true` lands on the assembly overlay.
                bindTarget(def).set(verb, def.macro);
                break;
            }
            continue;
          }

          // ── the raw-value arm (see `SymbolDeclaration`'s doc) ────────────────────────
          if (isValueDef(def)) {
            bindValue(env, verb, def.value as AmbientValue); // raw binding (boxed by bindValue's fromJS tail when it is a bare JS leaf) — a `require`-resolved value, never a scheme call target
            continue;
          }

          // ── LEGACY forms — still McpEnvCapability's downstream authoring shape ──────
          const sym = isSymbolSpec(def) ? def : { fn: def };
          const bound = (sym.fn as Fn).bind(activation);
          // Same activation-spawn middleware as `ensureSpawned` above — first touch gates on it.
          const gated =
            cellList.length === 0
              ? bound
              : async (...args: unknown[]) => {
                  await ensureSpawned();
                  return bound(...args);
                };
          // `env.defineRosetta` retired (public method hard-deleted) — `bindRosetta`
          // (AmbientRuntime.ts) is the same wiring, internalized: wrap via
          // createRosettaWrapper, bind via `env.set`, stamp `rosettaTypesOf` when `.type`
          // is declared and `env` is genuinely an `AmbientRuntime` (never a test mock).
          bindRosetta(env, verb, { ...sym, fn: gated } as RosettaFunction);
        }
        for (const resolver of spec.resolvers ?? []) {
          env.registerResolver(resolver);
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
            ownResolvers: spec.resolvers ?? [],
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
   *  this capability contributes to a shared env — prefixed `spec.symbols` keys (a
   *  builder-form `symbols` is NOT statically enumerable — a LIMIT, contributes
   *  nothing here; a pre-assembly consumer needing full fidelity there degrades to
   *  assembled-mode) ∪ macro-aware `define`/`define-macro`/`define-syntax` names
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
