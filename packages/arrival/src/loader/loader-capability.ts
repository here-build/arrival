// loader-capability — `arrivalLoaderCapability`: the module system as a plain
// `EnvCapability`, the worked exemplar of docs/environments.md §LOADER. `(require …)` /
// `(require/extension …)` / `(require/register-extension …)` are declared here; all their
// per-run state lives on the capability's own axes (configuration + resources), nothing wired
// imperatively, nothing pushed OUT through callbacks. §LOADER states the model in full: `fs`
// IS configuration and `require` is ALWAYS ENUMERATED, gated by `requiresConfig` — without a
// derivable loader it binds a cause-carrying DoorProcedure naming `fs`/`loader` (the Stage-3
// auto-door: a program's `(require …)` under a loaderless env is a STATIC
// "missing-configuration" diagnostic, not an unbound variable); run state IS resources
// (the per-RunContext bag below: the single-flight require session — a fresh bag per
// RunContext IS the "clear the cache between runs" reset — plus the per-live-env
// `RuntimeAssembler` whose `[Symbol.asyncDispose]` tears extensions back out at run
// teardown); `require/register-extension` is a `preludeOnly` macro that must apply BEFORE the
// preludes calling it (last in the root set, lowest precedence ⇒ applied first, or the ext
// capabilities dep on it).
//
// LOCAL to this site — the transitional COMPAT bridge §LOADER does not cover:
//   ⚠ `configuration.onRequireCache` and `configuration.onExtensionAssembler` REMAIN as receivers
//     only because the kernel can't hand these hosts the resource Ref today. `buildArrivalEnv`
//     (arrival-chain, run-program.ts) DISCARDS the `LoweredPack`s it lowers (returns only the
//     assembled `env`), so its consumers (`run-traced.ts`'s shared kernel; `chain-env.ts`'s
//     `ChainEnvironment`) have NO handle to `windDown()/resume()`. Until `buildArrivalEnv` threads
//     the pack out, these two receivers bridge the SAME underlying resource state (an in-place
//     clearer for the session cache; the live assembler for dispose-folding). Both fire LAZILY,
//     from inside the verb impls, re-firing once per run-resources bag (the flipped `.define`
//     form has no per-lower builder to fire from) — every consumer just stores the latest
//     callback into a slot, so per-run re-fire is drop-in. They delete the day the pack is
//     surfaced — the resources are already the single source of truth.
//
// The configuration slice mirrors `BuildArrivalEnvOpts`' loader-facing fields, so the ONE shared
// config bag (`exec(src, { capabilities, config })` / `buildArrivalEnv(opts)`) feeds this capability
// with no adapter — it validates its own slice (real structural zod checks, no `z.custom<T>()`
// passthrough) and ignores the rest.

import type { EvalTap } from "../eval/evaluator.js";
import { execExpr } from "../eval/generator-exec.js";
import { EnvCapability } from "../common/capability.js";
import { createRuntimeAssembler, type EnvPack, type RuntimeAssembler } from "../common/kernel.js";
import * as z from "../common/scheme-zod.js";
import { applyCallback } from "../values/primitives/ACallable.js";
import { is_applyable } from "../values/value-guards.js";
import { theVoid } from "../values/primitives/AVoid.js";
import invariant from "tiny-invariant";
import { RequireCycleError, RequireResolverError } from "../errors.js";

import { bindValue, AmbientRuntime, type AmbientValue, mintFrame, isAmbientRuntime } from "../env/AmbientRuntime.js";
import {
  legacyExtensionRegistry,
  lookupExtensionResolverIn,
  makeRegisterExtensionMacro,
  type ExtensionResolverRegistry,
} from "./loader-extensions.js";
import type { RunContext } from "../run/RunContext.js";
import { getCapabilityResources } from "../run/CallCtx.js";
import {
  dataToScheme,
  dirOf,
  type FsReadLike,
  type Loader,
  makeFsLoader,
  pickHandler,
  type ResolverResult,
  type RunEnv,
  runEnvOf,
  runResolverOf,
  type SchemeVal,
} from "./loader.js";

/** Resolve a `(require/extension :name)` argument to the bare extension name. A keyword
 *  (`:sql`) is a self-evaluating symbol (arrival's keyword-tagless-apply.md) that stringifies
 *  to its own name including the leading `:` — strip it; a bare string passes through
 *  unchanged (so `(require/extension "sql")` also works, though `:sql` is the intended,
 *  path-distinct surface). */
function extensionName(arg: unknown): string {
  return String(arg).replace(/^:/, "");
}

// ── configuration: real structural validators (not `z.custom<T>()` passthrough) ────────────────

/** A read-capable fs is any object exposing `readFile(path)`. */
const isFsReadLike = (v: unknown): v is FsReadLike =>
  v !== null && typeof v === "object" && typeof (v as FsReadLike).readFile === "function";

/** A `Loader` is `{ resolve(), read(), resolvers: Map }`. */
const isLoader = (v: unknown): v is Loader =>
  v !== null &&
  typeof v === "object" &&
  typeof (v as Loader).resolve === "function" &&
  typeof (v as Loader).read === "function" &&
  (v as Loader).resolvers instanceof Map;

// ── resources: the capability's per-RunContext state ────────────────────────────────────────────

/** The single-flight module cache + the `.scm` cycle/loading bookkeeping, as ONE session. A
 *  FRESH session is minted per RunContext (the `.define` resources factory runs once per run) —
 *  dropping the bag at run teardown IS the reset, so "clear the cache between runs" needs no
 *  lifecycle verbs. */
interface RequireSession {
  /** Each resolved path loads EXACTLY ONCE; every later require — sequential repeat OR concurrent
   *  sibling — awaits that one promise. */
  readonly inflight: Map<string, Promise<{ value: SchemeVal }>>;
  /** Paths whose MODULE FORMS are mid-evaluation (`.scm` `load` kind only): a re-entrant require of
   *  one is a genuine R7RS cycle (awaiting its in-flight promise would deadlock). */
  readonly evaluating: Set<string>;
  /** The `.scm` require chain, for the cycle / requireChain message. */
  readonly loadingStack: string[];
  /** Current module's dir, for relative resolves (seeded with the entry `dirname`). A SHARED stack
   *  assumes the resolve dir is stable across concurrent requires — true for same-dir fan-out (the
   *  common case: top-level `(map (require "x.prompt") …)`). Concurrent requires of modules in
   *  DIFFERENT dirs doing relative NESTED requires can mis-resolve: two chains push/pop one stack, so
   *  `dirStack.at(-1)` may read the sibling chain's dir.
   *
   *  DEFERRED (blocked, not by choice). A correct fix threads the dir PER require-chain, but the only
   *  channel that propagates through nested `(require …)` calls is the evaluator's `EvalContext`, and:
   *   (a) `EvalContext` has no per-eval dir field, and `execExpr(form, { env, tap })` exposes no user
   *       passthrough to carry one — adding it is an arrival-CORE change (out of this package); OR
   *   (b) a dynamic parameter (`ctx.dynamic_env`, which DOES propagate per-call) would work, but
   *       creating/reading one needs arrival's parameter API, again core-side.
   *  A dir-carrying CHILD scope is NOT viable: a `.scm`'s `define`s must spill into the SHARED run
   *  env, so the module's forms can't be evaluated in a private child. Until (a) or (b) lands in
   *  arrival core, the shared stack stays — correct for the common same-dir case, racy only for
   *  concurrent cross-dir nested requires. */
  readonly dirStack: string[];
}

/** The per-RunContext resources bag `this.resources` carries into every loader verb. Built once
 *  per run by the `.define` resources factory below; `[Symbol.asyncDispose]` (the assembler's
 *  `dispose()`, folding every runtime-applied extension back out) runs at RunContext teardown. */
interface LoaderRunResources {
  /** This run's require session — fresh per RunContext (see `RequireSession`). */
  readonly session: RequireSession;
  /** The loader derived ONCE per run from config (`loader` wins over `fs`-derived);
   *  `undefined` only when neither key is armed — unreachable from `require`'s impl, whose
   *  `requiresConfig` door already gated that case at bind. */
  readonly loader: Loader | undefined;
  /** STAGE B4 — THIS run's file-suffix → resolver-verb-name registry (§LOADER's original
   *  resource-registry design, restored): fresh, EMPTY per RunContext (this factory runs once
   *  per run), populated ONLY from a prelude via `require/register-extension` (preludeOnly —
   *  post-prelude registration is lexically impossible, by construction). Read by `require`'s
   *  own impl (below) and written by the registration macro — see `loaderRegistryOf`, this
   *  file, and loader-extensions.ts's header for the vocabulary-path-vs-legacy-ambient-path
   *  split this field only ever answers the FORMER half of. */
  readonly extensionResolvers: ExtensionResolverRegistry;
  /** The per-live-env `RuntimeAssembler` backing `(require/extension …)`. The assembler binds to
   *  the LIVE env, which the resource meets only at call time (ctx channel), so it is created
   *  lazily on first touch. Idempotent per env identity (one lowered capability normally applies
   *  to exactly one env; a re-applied lower re-creates for the new env). */
  getOrCreateAssembler(env: RunEnv): RuntimeAssembler<RunEnv>;
  /** ⚠ COMPAT one-shot latches for the two receivers (see the file header) — per-run, so each
   *  fresh RunContext re-notifies its host slot exactly once. */
  notifiedRequireCache: boolean;
  notifiedAssembler: RuntimeAssembler<RunEnv> | undefined;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Which extension-resolver registry a given `runCtx` implies (STAGE B4) — the ONE decision
 *  point `require`'s lookup and `require/register-extension`'s write both defer to, so they can
 *  never disagree:
 *   - `runCtx.vocabulary !== undefined` ⇒ this run was minted by `env/assemble-run.ts`'s
 *     `assembleRun` (the vocabulary path, the exec default) — its prelude pass threads THIS
 *     SAME `runCtx` through every prelude form (`generator-exec.ts`'s `preludeEvalScheme`), so
 *     a registration during the prelude and a `require` dispatch during program code both
 *     resolve `this`'s / `ctx.runCtx`'s resources off the identical `RunContext`. Read (or
 *     lazily spawn, on first touch) THIS run's own `LoaderRunResources.extensionResolvers` bag
 *     via `getCapabilityResources` — the SAME get-or-produce cache a real dispatch's
 *     `this.resources` would hit.
 *   - otherwise (ambient/glass) ⇒ this run's prelude — if any ran at all — baked at
 *     ASSEMBLY time (`lower()`/`assembleEnv`), through a throwaway internal RunContext with no
 *     `capabilityConfigurations` table; calling `getCapabilityResources` under such a run would
 *     throw (the resources factory destructures `config` unconditionally). Fall back to the
 *     legacy process-global table (`loader-extensions.ts`'s `legacyExtensionRegistry`) —
 *     BYTE-IDENTICAL to pre-B4 behavior: same table, same lifetime, same tests. See
 *     loader-extensions.ts's file header for why this bridge cannot (yet) become per-run too. */
function loaderRegistryOf(runCtx: RunContext): ExtensionResolverRegistry {
  if (runCtx.vocabulary === undefined) return legacyExtensionRegistry();
  const resources = getCapabilityResources(runCtx, arrivalLoaderCapability) as LoaderRunResources;
  return resources.extensionResolvers;
}

// Explicit `<any, any>`: TS's declaration-emit (this package builds `--build`/composite) can't
// portably NAME the inferred config type without referencing arrival's internal
// `AmbientRuntime` (RunEnv's root) across the package boundary. No consumer reads `.configuration`/
// `.resources` off this export from outside `loader-capability.ts` itself (every external use is
// `arrivalLoaderCapability.lower({...})`, generic-erased already) — so widening the export's own
// generics costs nothing real; the `symbols` callback body is still checked against the REAL
// inferred shapes at the `EnvCapability.define(...)` call site below, unaffected by this annotation.
export const arrivalLoaderCapability: EnvCapability<any, any> = EnvCapability.define("arrival/loader", {
  configuration: {
    /** PRIMARY: the raw read-capable filesystem arming `(require …)`. The capability derives its own
     *  `Loader` from this (`makeFsLoader`) — no host `makeFsLoader` step. */
    fs: z.custom<FsReadLike>(isFsReadLike, "fs must expose readFile(path)").optional(),
    /** COMPAT: a pre-built `Loader` (WINS over `fs`) — the seam for a caller that injects CUSTOM
     *  resolvers into the table (arrival-chain's `.yaml`/`.toml` handlers). */
    loader: z.custom<Loader>(isLoader, "loader must have resolve()/read()/resolvers:Map").optional(),
    /** Tap for `require`d module internals (the host's trace). */
    tap: z
      .custom<EvalTap>(
        (v: unknown): v is EvalTap => v !== null && typeof v === "object" && typeof (v as EvalTap).enter === "function",
        "tap must implement EvalTap.enter()",
      )
      .optional(),
    /** Base dir for resolving relative `(require …)` — the entry module's dirname. Seeds the
     *  per-run session's initial `dirStack`. (`z.custom` + typeof, not `z.string()`: the
     *  scheme-zod `z.string` export is a scheme AString CODEC, not the plain JS-string schema.) */
    dirname: z.custom<string>((v) => typeof v === "string", "dirname must be a string").optional(),
    /** Host-armed registry of named extension packs for `(require/extension :name)`.
     *  Absent ⇒ the verb DOORS (its `requiresConfig` names this key — same static-gate posture
     *  as `require`'s own fs/loader door). */
    extensionRegistry: z
      .custom<ReadonlyMap<string, EnvPack<RunEnv>>>((v) => v instanceof Map, "extensionRegistry must be a Map")
      .optional(),
    /** ⚠ COMPAT receiver (see header) — bridges the require session until `buildArrivalEnv`
     *  surfaces the `LoweredPack`. Hands the host an in-place clearer of the live session's cache;
     *  fires lazily at each run's first `(require …)` dispatch. */
    onRequireCache: z
      .custom<
        (clearRequireCache: () => void) => void
      >((v) => typeof v === "function", "onRequireCache must be a function")
      .optional(),
    /** ⚠ COMPAT receiver (see header) — bridges the assembler resource until `buildArrivalEnv`
     *  surfaces the `LoweredPack`. Fires with the live `RuntimeAssembler` for dispose-folding. */
    onExtensionAssembler: z
      .custom<
        (assembler: RuntimeAssembler<RunEnv>) => void
      >((v) => typeof v === "function", "onExtensionAssembler must be a function")
      .optional(),
  },
  /** One bag per RunContext (docs/execution.md §HERMETIC): the require session, the config-derived
   *  loader, and the lazily-created per-env assembler — whose `dispose()` IS the bag's
   *  `[Symbol.asyncDispose]`, so winding the run down tears every runtime-applied extension out. */
  resources: (config): LoaderRunResources => {
    const { fs, loader } = config as { fs?: FsReadLike; loader?: Loader; dirname?: string };
    let assembler: RuntimeAssembler<RunEnv> | undefined;
    let boundEnv: RunEnv | undefined;
    return {
      session: {
        inflight: new Map(),
        evaluating: new Set(),
        loadingStack: [],
        dirStack: [(config as { dirname?: string }).dirname ?? ""],
      },
      loader: loader ?? (fs ? makeFsLoader(fs) : undefined),
      extensionResolvers: new Map(),
      getOrCreateAssembler(env: RunEnv): RuntimeAssembler<RunEnv> {
        if (assembler === undefined || boundEnv !== env) {
          assembler = createRuntimeAssembler(env);
          boundEnv = env;
        }
        return assembler;
      },
      notifiedRequireCache: false,
      notifiedAssembler: undefined,
      async [Symbol.asyncDispose](): Promise<void> {
        await assembler?.dispose();
      },
    };
  },
  // FLIPPED form (`EnvCapability.define`): the symbol record is STATIC — every verb is always
  // enumerated; config-gating rides each contract's `requiresConfig` (the Stage-3 auto-door)
  // instead of conditional `defs["x"] = …` enumeration, and impls read
  // `this.configuration`/`this.resources` at dispatch.
  symbols: (symbol) => ({
    // Assembly-time-only MACRO (§LOADER / §PRELUDE): callable from every later-applied
    // capability's prelude, unbound everywhere at runtime. MACRO so the resolver name is
    // unevaluated — see makeRegisterExtensionMacro. `loaderRegistryOf` is referenced here
    // (module scope, this capability's OWN definition) before `arrivalLoaderCapability`'s
    // `const` binding finishes initializing — safe: the reference resolves lazily, inside a
    // closure `loaderRegistryOf` returns, not invoked until a REAL macro expansion long after
    // module load completes (ordinary forward-closure-over-const, not a TDZ read).
    "require/register-extension": {
      kind: "macro" as const,
      name: "require/register-extension",
      macro: makeRegisterExtensionMacro(loaderRegistryOf),
      preludeOnly: true,
    },

    require:
      symbol.native`require: loads a module by specifier and returns its value or spills its defines into the environment`(
        {
          input: [z.value],
          output: [z.value],
          // ANY-OF door gate (the disjunctive `requiresConfig` form): `require` is callable
          // while EITHER `fs` (the loader is derived) or a pre-built `loader` is armed; with
          // both absent it binds a DoorProcedure naming the pair — the static gate's
          // "missing-configuration" diagnostic replaces the old unbound-variable withholding.
          requiresConfig: [["fs", "loader"]],
        },
        // RAW-BOUND `{ value }`-style native, never rosetta-wrapped — §LOADER (no provenance
        // mint: `(define run-x (require "x.prompt"))` returns a CALLABLE, the data is born when
        // the proc is INVOKED; no return marshal: an `eval` module's scheme lambda survives
        // where a wrapper's `jsToScheme` would void it).
        //
        // STATEMENT-POSITION + eager-sequential within a `.scm`: that file's forms are
        // `execExpr`'d in order, to completion, so a required file's `define-macro` is
        // installed before the caller's next form expands (R5RS `load`). But requires are NOT
        // globally sequential — `(map …)` evaluates its body in PARALLEL, so the same path can
        // be `(require)`d concurrently by N iterations, hence the single-flight `inflight`
        // cache (a flat in-flight Set would read siblings #2…N as a cycle, spuriously
        // failing same-path fan-out). Cycles THROW (R7RS forbids module cycles; no exports
        // object to return "partial" in a spill model) — only `.scm` (`load`) can `require`
        // during its OWN evaluation, so the cycle guard is scoped to it; value/eval modules
        // (`.json`, `.hbs`, capability-registered types like `.prompt`) are require-graph
        // leaves and cannot cycle.
        async function (...args: unknown[]): Promise<SchemeVal> {
          const resources = this.resources as LoaderRunResources | undefined;
          // The run-resources bag rides `RunContext.capabilityResources` (1d) — absent only on a
          // bare-env dispatch that never went through `instantiate`'s mint site, which no loader
          // consumer path does (require needs a real run).
          invariant(
            resources !== undefined,
            "require: no run resources — dispatched outside a resource-armed RunContext.",
          );
          const { session, loader } = resources;
          // The `requiresConfig` door above already gated the both-absent case at bind — this
          // narrow is for TS and for the (impossible by construction) bare-env dispatch.
          invariant(
            loader !== undefined,
            "require: no loader derivable — the fs/loader door should have bound instead.",
          );
          // ⚠ COMPAT bridge (see header): hand the host an in-place clearer of THIS run's
          // session cache, once per run-resources bag. The designed channel is
          // `LoweredPack.windDown()`; this stays only until the pack is surfaced to
          // `buildArrivalEnv`'s consumers.
          if (!resources.notifiedRequireCache) {
            resources.notifiedRequireCache = true;
            (this.configuration as { onRequireCache?: (clear: () => void) => void }).onRequireCache?.(() =>
              session.inflight.clear(),
            );
          }
          const { tap } = this.configuration as { tap?: EvalTap };
          // The COMPOSED resolver, not just its env (see runResolverOf, loader.ts): module
          // forms evaluate through it, and the registered-resolver lookup walks it, so builtins
          // and capability verbs resolve identically under cut and glass.
          const resolver = runResolverOf(this, "require");
          const { inflight, evaluating, loadingStack, dirStack } = session;
          const specifierArg = args[0];
          const path = await loader.resolve(String(specifierArg), dirStack.at(-1)!);

          const pending = inflight.get(path);
          if (pending) {
            // In-flight as this chain's own ancestor → real cycle (awaiting would deadlock).
            // Otherwise a settled cache hit or a concurrent sibling — share the load.
            RequireCycleError.invariant(!evaluating.has(path), [...loadingStack, path]);
            return (await pending).value;
          }

          const load = (async (): Promise<{ value: SchemeVal }> => {
            const contents = await loader.read(path);
            // Registry overlay: a capability-registered resolver for this suffix wins over the
            // loader's built-in table. The registry stores the resolver verb's NAME — THIS run's
            // own bag on the vocabulary path, the legacy process-global table otherwise
            // (`loaderRegistryOf`, above) — resolved against THIS env (late-bind), so a
            // resource-armed resolver (e.g. `.prompt` → `prompt/compile`) uses THIS env's
            // resource. If the suffix is registered but the verb is NOT bound in this env (a
            // scope that didn't root the owning capability), resolution FALLS THROUGH to the
            // built-in table; once a suffix is removed from `defaultResolvers`, that fallthrough
            // errors (no handler), which IS the scoping guarantee (you must root the capability).
            const resolverName = lookupExtensionResolverIn(loaderRegistryOf(this.runCtx), path);
            // The COMPOSED lookup (scope ?? capabilities), non-throwing: a capability-registered
            // resolver verb lives on the capability base under the cut, where an env-chain-only
            // read (`env.get`) would miss it.
            const registered = resolverName === undefined ? undefined : resolver.lookup(resolverName);
            let result: ResolverResult;
            // A bound verb is a callable VALUE (ANativeProcedure), not `typeof === "function"` —
            // dispatch through the ONE invocation seam (`applyCallback`), which handles both the
            // value's apply term and a legacy bare fn.
            if (typeof registered === "function" || is_applyable(registered)) {
              // applyCallback's CallResult (SchemeValue | SchemeBounceMarker | Promise<SchemeValue>)
              // doesn't structurally overlap ResolverResult — a registered resolver verb is never
              // invoked in tail position, so a SchemeBounceMarker genuinely can't reach here; the
              // registry's own contract IS that its resolver returns a ResolverResult shape (an
              // authoring convention, not something the type system can see through applyCallback's
              // generic seam) — bridge through `unknown` at this one boundary.
              // `this` IS the whole CallCtx `require` was dispatched with — thread it, not
              // just `this.runCtx`.
              result = (await applyCallback(registered, [contents, { path }], this)) as unknown as ResolverResult;
            } else {
              const handler = pickHandler(path, loader.resolvers);
              RequireResolverError.invariant(handler !== undefined, "no-resolver", path);
              result = await handler.resolve(contents, { path });
            }

            let value: SchemeVal = theVoid;
            if (result.kind === "value") {
              // Shape data into scheme (`dataToScheme`): arrays become scheme LISTS at every
              // depth (so `(append …)`/`(car …)`/`(length …)` work), plain objects become
              // member-readable records (so `@`/`field` work). This is WHERE data gets
              // parsed-into-scheme — which is why the program needs no `json/parse` verb.
              // Pure value — `require` RETURNS it for an explicit `(define x (require …))`;
              // nothing is spilled. `value` is for DATA only — a JS function here would be
              // VOIDED to `#void` by the membrane (see THE CALLABLE RULE on `ResolverResult`,
              // loader.ts). A callable file (`.hbs`, `.prompt`) resolves as `kind: "eval"`
              // returning a scheme lambda instead.
              value = dataToScheme(result.value);
            } else {
              // load / eval: evaluate the module's forms in order into the run env, with the
              // module's own dir on the stack for its relative requires. Only `load` (`.scm`)
              // can require during this eval, so only it enters the cycle domain
              // (`evaluating` / `loadingStack`).
              const isLoad = result.kind === "load";
              dirStack.push(dirOf(path));
              if (isLoad) {
                evaluating.add(path);
                loadingStack.push(path);
              }
              try {
                // Evaluate through the requiring run's OWN composed resolver (ExecOptions.resolver,
                // the module-eval passthrough): defines spill into the same lexical frame
                // (`resolver.env`), builtins keep resolving through the same capability base.
                // `execExpr({ env })` here would rebuild a GLASS resolver over the frame env —
                // which under the cut is null-rooted, so module code lost the stdlib.
                //
                // `runCtx: this.runCtx` (Stage C Cut 1): thread the requiring run's LIVE handle too,
                // not just its resolver — else `execExpr` mints a fresh, vocabulary-less RunContext
                // and a NESTED `(require …)` inside THIS module resolves `loaderRegistryOf` against
                // the process-global legacy table even when the outer run is on the vocabulary path
                // with its own per-run extension registry. Same run ⇒ same vocabulary, same meter,
                // same extension registry, for every level of require nesting.
                for (const form of result.forms) value = await execExpr(form, { resolver, tap, runCtx: this.runCtx });
              } finally {
                if (isLoad) {
                  loadingStack.pop();
                  evaluating.delete(path);
                }
                dirStack.pop();
              }
              // `load` returns unspecified — the void SINGLETON, not a raw JS `undefined`
              // (raw-bound verbs return scheme values; `undefined` is not one).
              if (isLoad) value = theVoid;
            }
            return { value };
          })();

          inflight.set(path, load);
          try {
            return (await load).value;
          } catch (error) {
            // A failed load must not poison the cache — drop it so the path can be retried
            // (a transient read error isn't permanent; a real cycle / parse error simply
            // recurs). Then annotate the throw with the require chain (which `require` led
            // here: a → b → c). The DEEPEST require wins — outer levels see it already set
            // and leave it, so the chain reads entry→failing-module. Survives evaluator
            // propagation: an already-SchemeError is re-thrown unchanged (evaluator.ts:615),
            // and a plain assignment to an Error object sticks. Best-effort (frozen → skip).
            inflight.delete(path);
            if (error !== null && typeof error === "object" && !("requireChain" in error)) {
              try {
                (error as { requireChain?: string[] }).requireChain = [...loadingStack, path];
              } catch {
                /* frozen/sealed error — annotation is best-effort */
              }
            }
            throw error;
          }
        },
      ),

    "require/extension":
      symbol.native`require/extension: applies a host-registered extension pack (by :name) to the current env`(
        {
          input: [z.value],
          output: [z.value],
          // Same static-gate posture as `require`'s fs/loader door: absent registry ⇒ a
          // cause-carrying door naming `extensionRegistry` instead of withholding the symbol.
          requiresConfig: ["extensionRegistry"],
        },
        // RAW-BOUND, `__withCtx` — no rosetta wrapper, no marshal (same as `require`, §LOADER).
        // Resolves the name, applies the registered pack (and its deps) to the live env through
        // the per-env `RuntimeAssembler` (held by the run-resources bag — created lazily on
        // first call; the bag's `asyncDispose` folds `dispose()` into run teardown), and returns
        // unspecified: the capability's symbols are now live. Absent name ⇒ teaching error.
        //
        // The mid-run child scope `C'` is §LOADER / §PRELUDE (bootstrap's phase-gated prelude
        // machinery cannot touch a LIVE env, so each call seeds a fresh, DISCARDED
        // `C' = mintFrame(liveEnv, "prelude/<name>")` seeded with `register-extension` — passed
        // as both the `preludeScope` bind target and the `preludeEvalScope` eval scope, a lookup
        // miss on `C'` falling through to `liveEnv`; never linked in, dropped when the call
        // resolves — so the applied pack's own prelude `define`s are lost with `C'`, only its
        // DECLARED `symbols` reach the live env).
        async function (...args: unknown[]): Promise<SchemeVal> {
          const resources = this.resources as LoaderRunResources | undefined;
          invariant(
            resources !== undefined,
            "require/extension: no run resources — dispatched outside a resource-armed RunContext.",
          );
          const { extensionRegistry, onExtensionAssembler } = this.configuration as {
            extensionRegistry?: ReadonlyMap<string, EnvPack<RunEnv>>;
            onExtensionAssembler?: (assembler: RuntimeAssembler<RunEnv>) => void;
          };
          // The `requiresConfig` door already gated the absent-registry case at bind.
          invariant(
            extensionRegistry !== undefined,
            "require/extension: no extensionRegistry — the config door should have bound instead.",
          );
          const env = runEnvOf(this, "require/extension");
          const name = extensionName(args[0]);
          const pack = extensionRegistry.get(name);
          RequireResolverError.invariant(pack !== undefined, "no-extension", name, [...extensionRegistry.keys()]);
          const assembler = resources.getOrCreateAssembler(env);
          // ⚠ COMPAT bridge (see header): hand a lifecycle owner the live assembler so it can fold
          // `dispose()` into its own teardown, until it can reach `LoweredPack.windDown()` instead.
          // Re-notifies when a fresh assembler replaces a disposed one (per-run bag tracking).
          if (assembler !== resources.notifiedAssembler) {
            resources.notifiedAssembler = assembler;
            onExtensionAssembler?.(assembler);
          }
          // A discarded child scope, seeded with register-extension so the applied pack's prelude
          // may still call it. Never linked into `env` — used only for THIS call. Bound by hand
          // (no capability `apply()` pass runs here): the structural `SchemeEnv` face carries no
          // write member, so narrow to the concrete frame class (a run env's frames are real
          // AmbientRuntimes by construction) and mint through the module-internal `bindValue` /
          // `mintFrame` — exactly as `apply()` binds a `kind: "native"` def.
          invariant(
            isAmbientRuntime(env),
            "require/extension: the run env is not an arrival AmbientRuntime — a mid-run prelude scope must be minted off a real frame to receive bindings.",
          );
          const preludeScope = mintFrame(env, `prelude/${name}`);
          bindValue(preludeScope, "require/register-extension", makeRegisterExtensionMacro(loaderRegistryOf));
          await assembler.require(pack, {
            // The kernel's bind-target face over the same frame (PreludeBindTarget is the
            // `.set`-only shim shape; the frame does not carry `set`).
            preludeScope: { set: (n, v) => bindValue(preludeScope, n, v as AmbientValue) },
            // Same through-`unknown` widen as runEnvOf (loader.ts): assembler typed over structural
            // RunEnv, the minted frame is the concrete class; `RunEnv & AmbientRuntime` restates the
            // narrow above (`isAmbientRuntime(env)`) one frame down.
            preludeEvalScope: preludeScope as RunEnv & AmbientRuntime,
          });
          return theVoid; // applied for effect; the pack's symbols are now bound on the env
        },
      ),
  }),
});
