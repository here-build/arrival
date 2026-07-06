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
 *    — dispatched by `kind` in apply(). This is the ONLY form every pack under
 *    `foundations/arrival/**` now declares — the whole base stdlib + the infer/mcp/data/
 *    approval palette (arrival-scheme-env-infer, arrival-chain) migrated off the legacy forms
 *    below in the `symbol.rosetta`/`symbol.native` bake effort.
 *  • a raw VALUE binding (`{ value }`) — a PERMANENT, deliberate arm, not a migration remnant.
 *    Reserved for the CALLABLE RULE's one true exception: a binding `require`'s loader
 *    machinery resolves and calls directly in JS-land, never through the scheme evaluator (no
 *    rosetta marshal makes sense for a value that's never a scheme call target) —
 *    `packs/ext-yaml.ts` / `packs/ext-toml.ts`'s `ext/yaml/resolve`-shaped bindings are the
 *    known holders.
 *  • a LEGACY form — a bare fn, or a rosetta config (`{ fn, withContext, type, options }`) —
 *    read `this` (`ThisType<Activation<C,R>>`, bound at wire time). This was the `captureSymbols`
 *    migration scaffold's target shape; `captureSymbols` itself is gone now that its only two
 *    callers (arrival-chain's `arrivalDataCapability`/`arrivalSuperDefineCapability`) declare
 *    baked forms directly. But the SHAPE remains load-bearing OUTSIDE `foundations/arrival` —
 *    `McpEnvCapability`'s whole inline-annotation design (MCP `description`/`inputSchema` spliced
 *    onto the same object as `fn`) is built on it, and every one of its downstream capabilities
 *    (here.build's `saas/server/{arrival,mcp}`, inhuman's `saas/mcp`, the whole
 *    `sift-submission/mcp/packs/*` forensics catalog) still authors verbs this way. Deleting this
 *    arm is a SEPARATE, much larger migration (McpEnvCapability's annotation-lifting would need
 *    to move to baked-symbol splicing first) — out of scope here; NOT dead code.
 *
 *  Named `SymbolDeclaration` (not `SymbolDef`) to keep it distinct from `symbol.js`'s
 *  `AEntity` — the two used to share the identical name `SymbolDef`, a real naming
 *  collision (this is the wider authoring shape; `AEntity` is the narrower baked/discriminated
 *  result — `AEntity` is one arm of this union, not a synonym for it). */
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
 *  dependent's — the same order `lower()`'s own `apply()` evaluates them in, so a
 *  dependent's prelude may reference names its dep's prelude defined), deduplicated by
 *  capability IDENTITY (a diamond-shaped dep graph — two capabilities sharing one dep —
 *  must not double-emit its prelude).
 *
 *  For an EDITOR/type-lens's ambient scheme vocabulary: it needs EVERY capability actually
 *  assembled into the real env, not a hand-picked subset named by the caller. A hand-picked
 *  list silently drifts out of sync the moment a capability's own prelude changes or a new
 *  capability joins the root-set — exactly the bug this closes (`define/overridable`'s
 *  macro read as unresolved in studio's live editor because the caller named two
 *  capabilities' preludes by hand instead of walking the real assembled set). */
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
      apply: async (env: SchemeEnv, ctx?: PackContext<SchemeEnv>) => {
        // preludeOnly routing (design doc §1.3, phase-gated model): a baked native/rosetta def
        // marked `preludeOnly: true` binds onto `ctx.preludeScope` instead of the runtime env.
        // Under `assembleEnv` that target is the kernel's Map-backed shim, answered by a
        // phase-gated resolver on the base env — so the symbol is resolvable by every
        // later-applied capability's prelude (C3 dep order) and by nothing else: once the C3
        // loop ends the resolver goes silent, and the name is a plain unbound-variable
        // EVERYWHERE at runtime, including from lambdas a prelude defined (closures walk the
        // live chain at call time — `preludeOnly` means ASSEMBLY-TIME-ONLY; a prelude bridges a
        // value to runtime by capturing the CALL'S RESULT in an ordinary define, never the
        // verb). Same bind form either way (native → raw impl; rosetta → the gated run
        // wrapper); only the TARGET scope differs. Absent `ctx.preludeScope` (a bare direct
        // apply outside any assembly), fall back to `env` so the symbol is never silently
        // dropped.
        const bindTarget = (def: AEntity): PreludeBindTarget =>
          "preludeOnly" in def && def.preludeOnly ? (ctx?.preludeScope ?? env) : env;
        const symbolsRec = typeof spec.symbols === "function" ? spec.symbols(activation) : (spec.symbols ?? {});
        const prefix = spec.symbolPrefix ?? "";
        for (const [name, def] of Object.entries(symbolsRec)) {
          const verb = prefix + name;

          // ── BAKED symbol.* forms — dispatch by kind (the target path). ──────────────
          if (isBakedDef(def)) {
            switch (def.kind) {
              case "native":
                // The impl works on SCHEME VALUES, no codec, no validation — bind it raw,
                // exactly like the legacy `{ value: fn }` path (and provenance-transparent:
                // a native value-op is a pure transform, never a source).
                bindTarget(def).set(verb, def.impl);
                break;
              case "sequence":
              case "tagless":
              case "tagless-guard":
              case "rosetta": {
                // `run` is the COMPLETE decode→validate→impl→encode→mint wrapper, already
                // tagged `__withCtx` (so the evaluator appends ctx and the wrapper mints
                // provenance — same spine as createRosettaWrapper; see symbol.ts bakeRosetta).
                // Bind it via `set`, NOT defineRosetta — routing it through defineRosetta would
                // double-wrap the membrane (a second schemeToJs/jsToScheme over the codec output).
                // Resource pre-spawning still applies if the capability owns cells.
                const runFn = def.run;
                const gatedRun =
                  cellList.length === 0
                    ? runFn
                    : Object.assign(
                        async (...args: unknown[]) => {
                          await ensureSpawned();
                          return runFn(...args);
                        },
                        { __withCtx: runFn.__withCtx },
                      );
                bindTarget(def).set(verb, gatedRun);
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
          // Activation middleware: first touch of ANY symbol spawns ALL resources
          // (single-flight) before the fn body runs → fns read `.live` synchronously.
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
