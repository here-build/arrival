// scheme-env — the SCHEME-AWARE layer over the pure C3 kernel (kernel.ts).
//
// The kernel is env-agnostic: a pack's `apply(env)` may do anything, but the kernel
// itself never touches `env` or knows what scheme is. This module adds the two
// things a scheme env-build needs on top of that seam, WITHOUT modifying the kernel:
//
//   1. the ENV TYPE CONTRACT (`SchemeEnv`) — the surface a pack contributes to,
//      defined here (not imported from arrival-scheme) so the dependency only ever
//      points arrival-scheme → arrival-scheme-env, never back (no cycle).
//   2. BOOTSTRAP-SEQUENCE support — a pack may carry scheme `bootstrap` source
//      (`define-macro` forms + `define`s) ALONGSIDE its JS `wire`, lowered to a
//      plain `EnvPack` whose apply evaluates the bootstrap then runs the wiring.
//      Because the kernel applies packs in C3 (dependency) order, a dependency's
//      macros/defs are present before a dependent's bootstrap runs — the
//      "bootstrap sequence" falls out of the DAG, not a hand-maintained order.
//
// The evaluator is INJECTED (`EvalSchemeInto`): arrival-scheme's `exec(src,{env})`
// satisfies it. This module never imports the interpreter, so it stays the lower,
// dependency-free layer the base sandbox can be re-expressed in terms of.

import type { EnvPack } from "./kernel.js";
// Type-only edges (no runtime import — AmbientRuntime.ts imports THIS module's types, so a
// value edge here would cycle; `import type` erases at emit, same posture as guards.ts's
// false-leaf note): the storage union a resolver may answer with, and the run identity a
// resolving read threads.
import type { AmbientValue } from "../AmbientRuntime.js";
import type { RunContext } from "../values/primitives/RunContext.js";

/** A rosetta (host-fn) contribution, mirroring arrival-scheme's retired `defineRosetta`
 *  config structurally (kept here so we don't import the runtime). Still the type the
 *  legacy `SymbolDeclaration` authoring arm (capability.ts) declares against — the
 *  authoring SHAPE survives even though the `defineRosetta` method that once consumed
 *  it does not (see `bindRosetta`, AmbientRuntime.ts, the surviving internal wiring). */
export interface RosettaSpec {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variadic host fn, matches RosettaFunction
  fn: (...args: any[]) => unknown;
  /** Optional ambient `.d.ts` member-body type fragment, harvested by the type-lens. */
  type?: string;
  /** Rosetta options (e.g. `{ argProvenance: true }`) — passed through verbatim. */
  options?: unknown;
  /** PURE (provenance-PROPAGATING) rosetta — forwards its inputs' provenance instead of
   *  minting a fresh source point (mirrors `RosettaFunction.pure`; `mintsPoint = pure !== true`).
   *  Absent ⇒ source/mint (the conservative default). Carried here so a cross-package pack
   *  declaring a pure verb (`(approve …)`, `(expose …)`) types against this surface. */
  pure?: boolean;
}

/** What a resolver may answer with: a BOXED scheme/runtime binding (the same union
 *  environment storage holds), or a membrane primitive — a bare fn like the `:key`
 *  pluck, which is NOT rosetta-wrapped because it IS part of the membrane, like `@`.
 *  Deliberately NOT `unknown`: a raw JS scalar answer is a contract violation the
 *  probe sites door on at runtime (`assertResolvedBinding`, AmbientRuntime.ts) and this
 *  type walls off at compile time. */
export type ResolvedBinding = AmbientValue | ((...args: never[]) => unknown);

/** A catchall resolver contribution, mirroring arrival-scheme's `FallbackResolver`
 *  structurally (kept here so we don't import the runtime). It fires when the env
 *  did NOT bind `name`, mapping a NAME to a value — the polyglot member accessors
 *  (`:key`) and the unbounded `c[ad]+r` family are exactly this. */
export interface ResolverSpec {
  readonly id: string;
  /** Resolve `name` to a boxed binding, or `undefined` for "not mine, keep looking".
   *
   *  `ctx` is the RESOLVING READ's RunContext when the lookup came from a live run
   *  (the evaluator threads it through `Resolver.resolve`/`lookup`); absent on
   *  run-less reads (host `env.get`, assembly probes). A resolver that MINTS a value
   *  boxes at its own boundary: under `ctx` when it computes per-read (impure), but a
   *  `pure` resolver mints RUN-NEUTRALLY (`CONSTANT_CTX`-class) — its hits are
   *  memoized by the sealed chain and served across runs, so stamping the first
   *  reader's ctx would leak run identity between runs. */
  resolve(name: string, ctx?: RunContext): ResolvedBinding | undefined;
  /** DECLARED purity (a drift alarm catches CONTRADICTIONS against this declaration,
   *  never lies outright): `true` promises NAME-STABLE results (same
   *  name ⇒ same value forever), which licenses the compiled resolution chain to
   *  memoize hits through this step — and, iff EVERY resolver in a chain is pure, to
   *  cache misses ("unbound") too. Absent/`false` (the safe default): nothing is cached
   *  through this step — a dynamic middleware may start answering tomorrow. */
  readonly pure?: boolean;
}

/** The minimal surface a scheme-env pack touches. arrival-scheme's `AmbientRuntime`
 *  satisfies this structurally — packs type against THIS, not the concrete class.
 *
 *  There is deliberately NO `set` member (hermetic-Environment ruling, 2026-07-11)
 *  and NO `inherit`/`merge` member (the same ruling extended to birth: an env can
 *  only be BORN — assembled — and READ from JS; frame birth is the module-internal
 *  `mintFrame`, AmbientRuntime.ts): the env is opaque from the JS side — values enter
 *  the interpreter only as capabilities or overrides. Binding is the assembly
 *  machinery's own act, through the module-internal `bindValue` (AmbientRuntime.ts,
 *  never barrel-exported); a pack contributes bindings DECLARATIVELY
 *  (`symbols`/`resolvers`/`bootstrap`), it does not write. */
export interface SchemeEnv {
  get(name: string, options?: { throwError?: boolean }): unknown;
  /** Register a catchall resolver (fires on a name the env did not bind). This is the
   *  APPLY-TIME landing door for a capability's declared `resolvers` (CapabilitySpec.
   *  resolvers → capability.ts's apply) and the kernel's bake overlay — assembly-time
   *  producers only. There is deliberately NO `unregisterResolver` on this contract:
   *  resolver REMOVAL is not a pack-facing operation. The kernel's bake-SEAL hook
   *  reaches it structurally (`ResolverHostLike`, kernel.ts) on hosts that offer it —
   *  `ResolvingAmbient` does — and falls back to the sealed-flag silencer on hosts
   *  that don't. */
  registerResolver(resolver: ResolverSpec): void;
  /** Own bound names of THIS scope layer (string keys + symbols), not chained. The
   *  per-layer primitive `allBoundNames` walks; a consumer wanting only own-scope
   *  names (e.g. inspecting a freshly-minted child frame) reads this directly. */
  list(): (string | symbol)[];
  /** Every name bound anywhere up this scope's `__parent__` chain, de-duplicated
   *  (a closer layer's name appears once). Encapsulates the chain-walk so a consumer
   *  reflecting the full vocabulary (the MCP discovery schema) never pokes the
   *  internal `__parent__`/`list` machinery itself. Unsorted — the caller orders. */
  allBoundNames(): (string | symbol)[];
}

/** Evaluate scheme `source` into `env`. arrival-scheme's `exec(source, { env })`
 *  is the canonical implementation; injected so this package is evaluator-agnostic. */
export type EvalSchemeInto<E = SchemeEnv> = (env: E, source: string) => unknown | Promise<unknown>;

/** A scheme-aware capability: scheme `bootstrap` (macros + defs) and/or JS `wire`,
 *  composed as ONE pack. `deps`/`config`/`name` carry through to the kernel pack. */
export interface SchemePackSpec<E = SchemeEnv> {
  readonly name: string;
  readonly deps?: readonly EnvPack<E>[];
  /** Pack identity arming (e.g. the injected vfs/loader). Two same-name packs with
   *  non-equal config in one assembly conflict — see the kernel's `configEqual`. */
  readonly config?: unknown;
  /** Scheme source: `(define-macro …)` forms + `(define …)`s, eval'd into env on apply. */
  readonly bootstrap?: string;
  /** JS wiring (resolver registration, resource arming — NOT direct value binds:
   *  `SchemeEnv` carries no write member; bindings are contributed via `bootstrap`
   *  source or a capability's declarative `symbols`), run AFTER bootstrap so it may
   *  reference symbols the bootstrap introduced. */
  readonly wire?: (env: E) => void | Promise<void>;
}

/**
 * Bind the injected evaluator once, get a `SchemePackSpec → EnvPack` lowering. The
 * produced packs are plain kernel `EnvPack`s (so they compose in the same DAG as
 * pure-JS packs); their `apply` evaluates `bootstrap` then runs `wire`. Async by
 * construction (eval is async) ⇒ assemble with `assembleEnv` (the kernel has no
 * synchronous assembler — there is no synchronous eval path anywhere in arrival).
 *
 *   const pack = schemePacks(exec)({ name: "scheme/srfi-1", bootstrap: SRFI1_SCM });
 *   await assembleEnv(env, [pack]);
 */
export function schemePacks<E = SchemeEnv>(evalScheme: EvalSchemeInto<E>): (spec: SchemePackSpec<E>) => EnvPack<E> {
  return (spec) => ({
    name: spec.name,
    deps: spec.deps,
    config: spec.config,
    apply: async (env) => {
      if (spec.bootstrap !== undefined) await evalScheme(env, spec.bootstrap);
      await spec.wire?.(env);
    },
  });
}
