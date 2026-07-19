// loader-capability — `arrivalLoaderCapability`: the module system as a DECLARATIVE,
// configuration-style EnvCapability. `(require …)` / `(require/extension …)` /
// `(require/register-extension …)` are declared here; ALL of their per-run state lives on the
// capability's own axes (configuration + resources), so nothing is wired imperatively and nothing
// is pushed OUT through callbacks.
//
//   • fs IS CONFIGURATION. The primary surface is `configuration.fs` — a raw read-capable
//     filesystem (`{ readFile(path) }`). The capability DERIVES its own `Loader` (resolve + read +
//     the per-suffix resolver table) from it internally (`makeFsLoader`); a host no longer
//     pre-builds a `Loader` by hand. A pre-built `configuration.loader` is still accepted (it WINS
//     over `fs`) for the one thing `fs` can't express: a caller that injects CUSTOM resolvers into
//     the table (arrival-chain threads its `.yaml`/`.toml` `ExtensionHandler`s that way). `require`
//     is present IFF a loader is derivable (fs or loader) — capability withholding by absence: a
//     loader-less env has no `require` symbol at all, so a program's `(require …)` is a plain
//     unbound variable, not a policed call.
//
//   • RUN STATE IS RESOURCES, not stashed callbacks. The two pieces of lifecycle-bearing per-run
//     state are modeled as capability-owned `Resource`s on the `resources` axis:
//       – `requireCache` — the single-flight module cache + cycle/loading bookkeeping. Its
//         `windDown()` drops the session so the next touch re-acquires a FRESH (empty) one — which
//         IS "clear the cache between runs of a shared env". A lifecycle owner reaches it through
//         the `LoweredPack.windDown()/resume()` cycle instead of a stashed `clearRequireCache` fn.
//       – `assembler` — a holder for the per-live-env `RuntimeAssembler` backing
//         `(require/extension …)`; the resource's `asyncDispose` IS `assembler.dispose()`, so
//         winding the pack down tears every runtime-applied extension back out.
//     ⚠ COMPAT (transitional, documented per V's Stage-1 instruction): `configuration.onRequireCache`
//     and `configuration.onExtensionAssembler` REMAIN as receivers — but only because the kernel
//     genuinely can't hand these hosts the Ref today. `buildArrivalEnv` (arrival-chain,
//     run-program.ts) DISCARDS the `LoweredPack`s it lowers (it returns only the assembled `env`),
//     so its consumers (`run-traced.ts`'s shared kernel; `chain-env.ts`'s `ChainEnvironment`) have
//     NO handle to `windDown()/resume()`. Until `buildArrivalEnv` threads the pack out, these two
//     receivers bridge the SAME underlying resource state (a `peek()`-clear for the cache; the live
//     assembler for dispose-folding). They delete the day the pack is surfaced — the resources are
//     already the single source of truth.
//
//   • `require/register-extension` is a `preludeOnly: true` MACRO: unevaluated resolver NAME so
//     preludes write `(require/register-extension ".prompt" ext/prompt/resolve)` without string
//     quotes (a bare symbol would otherwise evaluate to the function, and String(fn) would poison
//     the registry key). The kernel's phase-gated prelude scope makes it callable from every
//     LATER-APPLIED capability's prelude and a plain unbound-variable error at runtime. ⚠ ORDERING:
//     this capability must apply BEFORE the capabilities whose preludes call it — list it LAST in
//     the assembly's root set (lowest precedence ⇒ applied first), or make the ext capabilities
//     dep on it.
//
// The configuration slice mirrors `BuildArrivalEnvOpts`' loader-facing fields, so the ONE shared
// config bag (`exec(src, { capabilities, config })` / `buildArrivalEnv(opts)`) feeds this capability
// with no adapter — it validates its own slice (real structural zod checks, no `z.custom<T>()`
// passthrough) and ignores the rest.

import type { EvalTap } from "../eval/evaluator.js";
import { execExpr } from "../eval/generator-exec.js";
import { EnvCapability, type SymbolDeclaration } from "../common/capability.js";
import { createRuntimeAssembler, type EnvPack, type RuntimeAssembler } from "../common/kernel.js";
import { port, type Resource } from "../common/resources.js";
import { type CallCtx, symbol } from "../common/symbol.js";
import * as z from "../common/scheme-zod.js";
import { applyCallback } from "../values/primitives/ACallable.js";
import { is_callable_value } from "../values/value-guards.js";
import { theVoid } from "../values/primitives/AVoid.js";
import invariant from "tiny-invariant";
import { RequireCycleError, RequireResolverError } from "../errors.js";

import { bindValue, AmbientRuntime, type AmbientValue, mintFrame, isAmbientRuntime } from "../AmbientRuntime.js";
import { lookupExtensionResolver, makeRegisterExtensionMacro } from "./loader-extensions.js";
import {
  type ContentResolver,
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


// ── resources: the capability's lifecycle-bearing per-run state ─────────────────────────────────

/** The single-flight module cache + the `.scm` cycle/loading bookkeeping, as ONE session. Modeled as
 *  a `Resource` so its lifecycle is the resource lifecycle: `windDown()` drops the handle, and the
 *  next `(require …)` re-acquires a FRESH (empty) session — i.e. "clear the cache between runs". */
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


/** Holds the per-live-env `RuntimeAssembler` backing `(require/extension …)`. The assembler binds to
 *  the LIVE env, which the resource meets only at call time (ctx channel), so it is created lazily
 *  by `getOrCreate` rather than in `acquire`. The resource's `asyncDispose` IS the assembler's
 *  `dispose()`, so winding the pack down tears every runtime-applied extension back out. */
interface AssemblerHolder {
  /** The assembler for `env`, created on first touch. Idempotent per env identity (one lowered
   *  capability normally applies to exactly one env; a re-applied lower re-creates for the new env). */
  getOrCreate(env: RunEnv): RuntimeAssembler<RunEnv>;
}


// Explicit `<any, any>`: TS's declaration-emit (this package builds `--build`/composite) can't
// portably NAME the inferred config/resource type without referencing arrival's internal
// `AmbientRuntime` (RunEnv's root) across the package boundary. No consumer reads `.configuration`/
// `.resources` off this export from outside `loader-capability.ts` itself (every external use is
// `arrivalLoaderCapability.lower({...})`, generic-erased already) — so widening the export's own
// generics costs nothing real; the `symbols` builder body above is still checked against the
// REAL inferred shapes at the `new EnvCapability(...)` call site below, unaffected by this annotation.
export const arrivalLoaderCapability: EnvCapability<any, any> = new EnvCapability("arrival/loader", {
  configuration: {
    /** PRIMARY: the raw read-capable filesystem arming `(require …)`. The capability derives its own
     *  `Loader` from this (`makeFsLoader`) — no host `makeFsLoader` step. */
    fs: z.custom<FsReadLike>(isFsReadLike, "fs must expose readFile(path)").optional(),
    /** COMPAT: a pre-built `Loader` (WINS over `fs`) — the seam for a caller that injects CUSTOM
     *  resolvers into the table (arrival-chain's `.yaml`/`.toml` handlers). */
    loader: z.custom<Loader>(isLoader, "loader must have resolve()/read()/resolvers:Map").optional(),
    /** Tap for `require`d module internals (the host's trace). */
    tap: z.custom<EvalTap>((v: unknown): v is EvalTap =>
      v !== null && typeof v === "object" && typeof (v as EvalTap).enter === "function", "tap must implement EvalTap.enter()").optional(),
    /** Base dir for resolving relative `(require …)` — the entry module's dirname. Seeds the
     *  `requireCache` resource's initial `dirStack`. (`z.custom` + typeof, not `z.string()`: the
     *  scheme-zod `z.string` export is a scheme AString CODEC, not the plain JS-string schema.) */
    dirname: z.custom<string>((v) => typeof v === "string", "dirname must be a string").optional(),
    /** Host-armed registry of named extension packs for `(require/extension :name)`.
     *  Absent ⇒ the verb is absent (unbound-symbol, same withholding posture). */
    extensionRegistry: z
      .custom<ReadonlyMap<string, EnvPack<RunEnv>>>((v) => v instanceof Map, "extensionRegistry must be a Map")
      .optional(),
    /** ⚠ COMPAT receiver (see header) — bridges the `requireCache` resource until `buildArrivalEnv`
     *  surfaces the `LoweredPack`. Hands the host an in-place clearer of the live session's cache. */
    onRequireCache: z
      .custom<(clearRequireCache: () => void) => void>((v) => typeof v === "function", "onRequireCache must be a function")
      .optional(),
    /** ⚠ COMPAT receiver (see header) — bridges the `assembler` resource until `buildArrivalEnv`
     *  surfaces the `LoweredPack`. Fires with the live `RuntimeAssembler` for dispose-folding. */
    onExtensionAssembler: z
      .custom<(assembler: RuntimeAssembler<RunEnv>) => void>(
        (v) => typeof v === "function",
        "onExtensionAssembler must be a function",
      )
      .optional(),
  },
  resources: {
    requireCache: (cfg: { dirname?: string }): Resource<RequireSession> => ({
      kind: "arrival/require-session",
      // In-memory session: dropping the handle IS the reset (windDown ⇒ fresh empty session next touch),
      // so the closer only clears for hygiene. No external port to close.
      acquire: async () =>
        port<RequireSession>(
          { inflight: new Map(), evaluating: new Set(), loadingStack: [], dirStack: [cfg.dirname ?? ""] },
          (): void => {
            /* no external handle; the drop-and-re-acquire cycle is the reset */
          },
        ),
    }),
    assembler: (): Resource<AssemblerHolder> => ({
      kind: "arrival/require-extension-assembler",
      acquire: async () => {
        let assembler: RuntimeAssembler<RunEnv> | undefined;
        let boundEnv: RunEnv | undefined;
        return port<AssemblerHolder>(
          {
            getOrCreate(env: RunEnv): RuntimeAssembler<RunEnv> {
              if (assembler === undefined || boundEnv !== env) {
                assembler = createRuntimeAssembler(env);
                boundEnv = env;
              }
              return assembler;
            },
          },
          async (): Promise<void> => {
            await assembler?.dispose();
          },
        );
      },
    }),
  },
  // BUILDER form: the verbs close over per-lower `configuration` + `resources` (the requireCache /
  // assembler Refs), constructed once per apply.
  symbols: ({ configuration, resources, degradation }) => {
    // Destructure INSIDE (not in the param): the body also reads `configuration`/`resources`
    // wholesale (onRequireCache compat bridge, extensionRegistry gate, the requireCache/assembler
    // Refs) — an inline param destructure would unbind the objects themselves.
    const { fs, loader = fs ? makeFsLoader(fs) : undefined, tap } = configuration;
    void tap;
    const { requireCache, assembler } = resources;
    void requireCache;
    void assembler;
    const defs: Record<string, SymbolDeclaration> = {
      // Assembly-time-only MACRO (kernel's phase-gated prelude scope): callable from every
      // later-applied capability's prelude, unbound everywhere at runtime. MACRO so the
      // resolver name is unevaluated — see makeRegisterExtensionMacro.
      "require/register-extension": {
        kind: "macro" as const,
        name: "require/register-extension",
        macro: makeRegisterExtensionMacro(),
        preludeOnly: true,
      },
    };

    // Door-set degradation (design doc symbol-define-static-program-validation.md §3.7, W2):
    // under `degradation: "doors"`, an absent `fs`/`loader` no longer WITHHOLDS `require`
    // entirely (the header's "capability withholding by absence" posture) — it binds a
    // cause-carrying door instead, teaching "provide fs (or loader) to enable it". Under the
    // default `"forbid"` mode (`degradation.active` false) this branch never fires — byte-
    // identical withhold, unchanged.
    if (loader === undefined && degradation.active) {
      defs["require"] = degradation.door(
        "require",
        ["fs", "loader"],
        'loads a module by specifier and returns its value or spills its defines into the environment. Provide "fs" (or a pre-built "loader") to enable it.',
      );
    }

    if (loader !== undefined) {
      // ⚠ COMPAT bridge (see header): hand the host an in-place clearer of the LIVE session's cache.
      // `peek()` late-binds to whatever session is spawned (undefined = not yet loaded = nothing to
      // clear). The designed channel is `LoweredPack.windDown()`; this stays only until the pack is
      // surfaced to `buildArrivalEnv`'s consumers.
      configuration.onRequireCache?.(() => resources.requireCache.peek()?.inflight.clear());

      defs["require"] = symbol.native`require: loads a module by specifier and returns its value or spills its defines into the environment`(
        { input: [z.value], output: [z.value] },
        // RAW-BOUND, never rosetta-wrapped — so there is no provenance mint (`(define run-x
        // (require "x.prompt"))` returns a CALLABLE — the data is born when the proc is
        // INVOKED, not when required — a mint here would surface `require` as a spurious chain
        // node) and no return marshal (an `eval` module's scheme lambda survives; a wrapper's
        // `jsToScheme` would void it).
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
        async function (this: CallCtx, ...args: unknown[]): Promise<SchemeVal> {
          // The COMPOSED resolver, not just its env (the cut-path fix — see runResolverOf):
          // module forms evaluate through it below, and the registered-resolver-verb lookup
          // walks it too, so builtins/capability verbs resolve identically under cut and glass.
          const resolver = runResolverOf(this, "require");
          // The single-flight cache + cycle/loading bookkeeping (the requireCache resource).
          // `.get()` single-flights: concurrent requires (the `map` fan-out) share ONE session.
          const { inflight, evaluating, loadingStack, dirStack } = await resources.requireCache.get();
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
            // Registry overlay (proposal §7): a capability-registered resolver for this
            // suffix wins over the loader's built-in table. The registry stores the resolver
            // verb's NAME (process-global), resolved against THIS env (late-bind), so a
            // resource-armed resolver (e.g. `.prompt` → `prompt/compile`) uses THIS env's
            // resource. If the suffix is registered but the verb is NOT bound in this env (a
            // scope that didn't root the owning capability), resolution FALLS THROUGH to the
            // built-in table — so during migration a bare loader still resolves it; once a
            // suffix is removed from `defaultResolvers`, that fallthrough naturally errors
            // (no handler), which IS the scoping guarantee (you must root the capability).
            const resolverName = lookupExtensionResolver(path);
            // The COMPOSED lookup (scope ?? capabilities), non-throwing: a capability-registered
            // resolver verb lives on the capability base under the cut — an env-chain-only read
            // (`env.get`) would miss it there, the same failure family as the module-forms bug.
            const registered = resolverName === undefined ? undefined : resolver.lookup(resolverName);
            let result: ResolverResult;
            // A bound verb is a callable VALUE now (ANativeProcedure — the callable-as-value
            // rework), not `typeof === "function"` — dispatch through the ONE invocation seam
            // (`applyCallback`), which handles both the value's apply term and a legacy bare fn.
            if (typeof registered === "function" || is_callable_value(registered)) {
              // applyCallback's CallResult (SchemeValue | SchemeBounceMarker | Promise<SchemeValue>)
              // doesn't structurally overlap ResolverResult — a registered resolver verb is never
              // invoked in tail position, so a SchemeBounceMarker genuinely can't reach here; the
              // registry's own contract IS that its resolver returns a ResolverResult shape (an
              // authoring convention, not something the type system can see through applyCallback's
              // generic seam) — bridge through `unknown` at this one boundary.
              result = (await applyCallback(
                registered,
                [contents, { path }],
                this.runCtx,
              )) as unknown as ResolverResult;
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
                for (const form of result.forms) value = await execExpr(form, { resolver, tap });
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
      );
    }

    // Same door-set degradation posture as `require` above, for the `extensionRegistry`-gated
    // verb: absent registry + "doors" mode ⇒ a cause-carrying door naming `extensionRegistry`
    // instead of withholding the symbol entirely.
    if (configuration.extensionRegistry === undefined && degradation.active) {
      defs["require/extension"] = degradation.door(
        "require/extension",
        ["extensionRegistry"],
        'applies a host-registered extension pack (by :name) to the current env. Provide "extensionRegistry" to enable it.',
      );
    }

    if (configuration.extensionRegistry !== undefined) {
      const { extensionRegistry, onExtensionAssembler } = configuration;
      // Track the last assembler we notified the compat receiver about, so a fresh assembler after a
      // windDown+resume re-notifies (the old WeakMap-per-env fired only once, ever).
      let notifiedAssembler: RuntimeAssembler<RunEnv> | undefined;

      defs["require/extension"] = symbol.native`require/extension: applies a host-registered extension pack (by :name) to the current env`(
        { input: [z.value], output: [z.value] },
        // RAW-BOUND, `__withCtx` — no rosetta wrapper, no marshal (`pure: true` no-mint behavior
        // is structural here, same as `require` above). Resolves the name, applies the registered
        // pack (and its deps) to the live env through the per-env `RuntimeAssembler` (held by the
        // `assembler` resource — created lazily on first call; its resource `asyncDispose` folds
        // `dispose()` into pack teardown), and returns unspecified: the capability's symbols are now
        // live on the env. Absent name ⇒ teaching error.
        //
        // MID-RUN prelude scope (design doc §1.4 — deliberately NOT bootstrap's machinery):
        // unlike bootstrap assembly (whose `preludeOnly` symbols ride the kernel's phase-gated
        // resolver inside `assembleEnv`), the env here is LIVE and concurrently evaluating the
        // user program, and the bootstrap assembly's prelude phase is long closed. So EACH call
        // seeds a fresh, DISCARDED child scope `C' = mintFrame(liveEnv, "prelude/<name>")` with
        // `register-extension` (so an applied pack's prelude may still call it), and passes it
        // as BOTH `preludeScope` (the bind target for any `preludeOnly` symbols) AND
        // `preludeEvalScope` (the scope the pack's prelude TEXT is evaluated against — a lookup
        // miss on `C'` falls through to `liveEnv` naturally). `C'` is never linked INTO
        // `liveEnv` — it is simply dropped when the call resolves. Consequence (deliberate, not
        // a bug): a mid-run pack's own prelude `define`s land in `C'` and are lost with it —
        // only its DECLARED `symbols` reach the live env.
        async function (this: CallCtx, ...args: unknown[]): Promise<SchemeVal> {
          const env = runEnvOf(this, "require/extension");
          const name = extensionName(args[0]);
          const pack = extensionRegistry.get(name);
          RequireResolverError.invariant(pack !== undefined, "no-extension", name, [...extensionRegistry.keys()]);
          const assembler = (await resources.assembler.get()).getOrCreate(env);
          // ⚠ COMPAT bridge (see header): hand a lifecycle owner the live assembler so it can fold
          // `dispose()` into its own teardown, until it can reach `LoweredPack.windDown()` instead.
          if (assembler !== notifiedAssembler) {
            notifiedAssembler = assembler;
            onExtensionAssembler?.(assembler);
          }
          // A discarded child scope, seeded with register-extension so the applied pack's
          // prelude may still call it. Never linked into `env` — used only for THIS call.
          // Inlined bind (no capability `apply()` pass runs over this scope): the SAME native
          // def bootstrap uses, bound by hand exactly as `apply()` would for a `kind: "native"`
          // def — through the module-internal `bindValue` (the `SchemeEnv` face carries no
          // write member; the instanceof narrow is the same door capability.ts's apply uses:
          // a run env's frames are real AmbientRuntimes by construction).
          // The structural `SchemeEnv` face carries no birth member (monadic-birth ruling) —
          // narrow to the concrete frame class first (a run env's frames are real AmbientRuntimes
          // by construction), then mint the discarded child through the module-internal fn.
          invariant(
            isAmbientRuntime(env),
            "require/extension: the run env is not an arrival AmbientRuntime — a mid-run prelude scope must be minted off a real frame to receive bindings.",
          );
          const preludeScope = mintFrame(env, `prelude/${name}`);
          bindValue(preludeScope, "require/register-extension", makeRegisterExtensionMacro());
          await assembler.require(pack, {
            // The kernel's bind-target face over the same frame (PreludeBindTarget is the
            // `.set`-only shim shape; the frame itself no longer carries `set`).
            preludeScope: { set: (n, v) => bindValue(preludeScope, n, v as AmbientValue) },
            // The SAME laundered seam `runEnvOf` always carried (loader.ts's explicit
            // through-`unknown` widen): the assembler is typed over the structural RunEnv,
            // the minted frame is the concrete class; `RunEnv & AmbientRuntime` restates the
            // narrow above (`isAmbientRuntime(env)` on a RunEnv) one frame down.
            preludeEvalScope: preludeScope as RunEnv & AmbientRuntime,
          });
          return theVoid; // applied for effect; the pack's symbols are now bound on the env
        },
      );
    }

    return defs;
  },
});
