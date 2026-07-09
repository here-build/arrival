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
import type { AEntity } from "./symbol.js";
import { PurityError } from "../errors.js";
import { Keyword } from "../values/Keyword.js";
import { ANativeProcedure, ARosettaProcedure, type CallableImpl } from "../values/primitives/ACallable.js";
import type { RunContext } from "../values/primitives/RunContext.js";
// The dependency-free ambient leaf (see its header): the evaluator installs the current
// invocation there at every apply site; the rosetta bind adapter reads it back. No cycle —
// the leaf imports nothing.
import { currentDynamicCallSite } from "../eval/dynamic-call-site.js";
import type { InvocationLike } from "../rosetta.js";
import { CallCtx, makeCallCtx, type CallbackRoles, type ProvenanceRole } from "./symbols/_bake.js";
import { type SchemeValue } from "../values/types.js";
import invariant from "tiny-invariant";

/** An `EnvPack` that also carries its resource lifecycle (wind-down = pause; resume
 *  = re-spawn). The kernel uses the EnvPack face; a lifecycle owner calls these. */
export type LoweredPack = EnvPack<SchemeEnv> & {
  /** Release every resource (reverse-DAG), keep wiring. Next touch/resume re-spawns. */
  windDown(): Promise<void>;
  /** Eagerly re-acquire every resource. */
  resume(signal?: AbortSignal): Promise<void>;
};

type ZodMap = Record<string, z.ZodType>;
type InferCfg<C extends ZodMap> = { [K in keyof C]: z.infer<C[K]> };
type HandleOf<T> = T extends Resource<infer H> ? H : never;
type RefsOf<R extends Record<string, Resource<unknown>>> = { readonly [K in keyof R]: Ref<HandleOf<R[K]>> };

/** The per-env binding context a method's `this` sees: validated config + live resource Refs. */
export interface Activation<C extends ZodMap, R extends Record<string, Resource<unknown>>> {
  readonly configuration: InferCfg<C>;
  readonly resources: RefsOf<R>;
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
 *  of this union, not a synonym for it). */
export type SymbolDeclaration = AEntity | Fn | (Omit<RosettaSpec, "fn"> & { fn: Fn }) | { value: unknown };

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
    (m as { kind: unknown }).kind === "macro");

// ── LEGACY-form guards — see `SymbolDeclaration`'s doc for why these stay ────────────────
const isValueDef = (m: SymbolDeclaration): m is { value: unknown } =>
  typeof m === "object" && m !== null && "value" in m;
const isSymbolSpec = (m: SymbolDeclaration): m is Omit<RosettaSpec, "fn"> & { fn: Fn } =>
  typeof m === "object" && m !== null && "fn" in m;

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
   *  exists); `config` is validated against the `configuration` schemas. */
  lower(opts: { evalScheme?: EvalSchemeInto; config?: Partial<InferCfg<C>> } = {}): LoweredPack {
    const { spec, name } = this;

    const schema = spec.configuration ? z.object(spec.configuration as ZodMap) : z.object({});
    const configuration = schema.parse(opts.config ?? {}) as InferCfg<C>;

    // Resources → ref-counted cells. A provider entry reads the parsed config.
    const cells = {} as Record<string, ResourceCell<unknown>>;
    for (const [key, def] of Object.entries(spec.resources ?? {})) {
      const resource = (
        typeof def === "function" ? (def as (c: InferCfg<C>) => Resource<unknown>)(configuration) : def
      ) as Resource<unknown>;
      cells[key] = new ResourceCell(resource);
    }
    const activation = { configuration, resources: cells } as unknown as Activation<C, R>;

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
      ...(opts.config === undefined ? {} : { config: opts.config }),
      // Deps inherit the SAME raw `config` object (each validates its own slice via its schema; the
      // stored `config` field stays reference-equal across a capability's root + dep appearances, so
      // closure dedup matches by identity instead of tripping AssembleConfigConflictError).
      ...(spec.deps
        ? { deps: spec.deps.map((d) => d.lower({ evalScheme: opts.evalScheme, config: opts.config })) }
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
        // preludeOnly routing (design doc §1.3): a baked native/rosetta def marked
        // `preludeOnly: true` binds onto `ctx.preludeScope` instead of the runtime env — see
        // `PackContext.preludeScope` in kernel.ts for the full assembly-time-only contract. Same
        // bind form either way (native → raw impl; rosetta → the gated run wrapper); only the
        // TARGET scope differs. Absent `ctx.preludeScope` (a bare direct apply outside any
        // assembly), fall back to `env` so the symbol is never silently dropped.
        const bindTarget = (def: AEntity): PreludeBindTarget =>
          "preludeOnly" in def && def.preludeOnly ? (ctx?.preludeScope ?? env) : env;
        const symbolsRec = typeof spec.symbols === "function" ? spec.symbols(activation) : (spec.symbols ?? {});
        const prefix = spec.symbolPrefix ?? "";
        for (const [name, def] of Object.entries(symbolsRec)) {
          const verb = prefix + name;

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
                // Stamp the RESOLVED provenance role onto the bound value (docs/PROVENANCE.md
                // §2, PROVENANCE-PLAN.md Q2) — the lineage classifier reads it OFF THE BOUND
                // VALUE via `env.get(op)`, replacing the retired `.fanout` boolean this same
                // seam used to copy. The Q4 twin rides the same seam: the resolved per-lambda-
                // arm callback roles (element-transformer/control/effect/accumulator), read as
                // data by the classifier (Q3) and the wireframe builder (Q8a).
                (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = def.provenance;
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
                // ANativeProcedure invoked through the `arrival/tagless-final/apply` term
                // (the B2 binder cut: no bare JS functions in env value space, P1). These
                // three kinds read ONLY `this.runCtx` — the apply term's threaded runCtx
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
                // Stamp the RESOLVED provenance role (all three kinds now carry `.provenance`
                // on the def itself — sequence()/tagless()/taglessGuard() resolve it at bake
                // time) onto the bound value, same seam as the native case above — plus the
                // Q4 callback roles (sequence: bake-extracted; tagless: `withCallbackRoles`-
                // declared, e.g. reduce's acc-chain marker).
                (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = def.provenance;
                if (def.callbackRoles !== undefined) {
                  (proc as { callbackRoles?: CallbackRoles }).callbackRoles = def.callbackRoles;
                }
                bindTarget(def).set(verb, proc);
                break;
              }
              case "rosetta": {
                // Stage-3 conversion per reverse-membrane-for-callables.md §9, RULED option
                // (c) materialized: the per-call INVOCATION reaches the wrapper from the
                // evaluator's ambient dynamic call site — evaluator-owned state, installed
                // at every apply site (`setDynamicCallSite(ctx.currentInvocation)` around
                // evalPair / applyArrowProc / wrapLambda dispatch) — never smuggled by this
                // binder. The adapter reconstructs the wrapper's `CallCtx` from
                // (runCtx, ambient), so a SOURCE rosetta's fresh-point mint
                // (`pointProvenance` off the invocation) works through the apply term
                // exactly as it did through the legacy bare-fn path (which received
                // `makeCallCtx(ctx.runCtx, ctx.currentInvocation)` as `this`). A direct-JS
                // call with no evaluator frame sees no ambient → the input-union fallback,
                // byte-identical to legacy. conservation.law's seal-laundering rows gate
                // this equivalence.
                //
                // Bind via `set`, NOT defineRosetta — that would double-wrap the membrane.
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
                  // Retired the `{ pure: boolean }` shape (PROVENANCE-PLAN.md Q2) — `strategy`
                  // is opaque (`unknown`, "until stage 3") anyway; carries the resolved role now.
                  strategy: { provenance: def.provenance },
                  impl,
                });
                // Same stamp as the native/sequence cases — the classifier reads it off the
                // bound value uniformly across every callable kind (callback roles included).
                (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = def.provenance;
                if (def.callbackRoles !== undefined) {
                  (proc as { callbackRoles?: CallbackRoles }).callbackRoles = def.callbackRoles;
                }
                bindTarget(def).set(verb, proc);
                break;
              }
              case "door":
                // errors-as-doors: an OMITTED verb. Bind a throw carrying the teaching
                // reason; the door's `name` is its omitted-set membership (PurityError.feature
                // — the routing/telemetry key, mirroring core.ts's %purity-door → PurityError).
                env.set(verb, () => {
                  throw new PurityError(`${def.name} is not available.\n  Why: ${def.reason}`, def.name);
                });
                break;
              case "keyword":
                // kernel KEYWORD: bind the first-class marker the evaluator dispatches on.
                // Resolving a call head to this VALUE → SPECIAL_FORMS[def.name] (the dual of
                // cxr): the special form is aliasable + lexically shadowable, unlike the
                // name-matched-before-lookup table it replaces.
                env.set(verb, new Keyword(def.name));
                break;
              case "macro":
                // A non-evaluating MACRO form: bind the raw transformer (Macro/Syntax) as-is.
                // Not arg-evaluating (native/rosetta) nor evaluator-dispatched (keyword) — the
                // generic is_macro/is_syntax eval hook expands it. Home of syntax-rules.
                env.set(verb, def.macro);
                break;
            }
            continue;
          }

          // ── the raw-value arm (see `SymbolDeclaration`'s doc) ────────────────────────
          if (isValueDef(def)) {
            env.set(verb, def.value); // raw binding — a `require`-resolved value, never a scheme call target
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
          env.defineRosetta(verb, { ...sym, fn: gated } as RosettaSpec);
        }
        for (const resolver of spec.resolvers ?? []) {
          env.registerResolver(resolver);
        }
        if (spec.prelude !== undefined) {
          invariant(
            opts.evalScheme !== undefined,
            `capability "${name}" has a prelude but no evalScheme was provided to lower()`,
          );
          // Bootstrap (§1.3): evaluate against `env` (= R, already re-parented onto the prelude
          // overlay by the caller) so prelude `define`s land in R — `ctx.preludeEvalScope` is
          // undefined here. Mid-run (§1.4): evaluate against the caller's discarded CHILD scope
          // instead, so a prelude `define` is dropped with it rather than leaking to the live env.
          await opts.evalScheme(ctx?.preludeEvalScope ?? env, spec.prelude);
        }
      },
    };
  }
}
