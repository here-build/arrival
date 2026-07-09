import { CLASS } from "../well-known-symbols.js";
import type { Environment, EnvironmentValue } from "../Environment.js";
import { type CompiledResolutionChain, sealResolutionChain } from "./CompiledResolutionChain.js";

/**
 * The CAPABILITY base — the builtins/preludes/host-supplied resolvers a run is
 * armed with (everything reachable from `global_env`). This is the shared root
 * that a {@link LexicalScope} falls through to: lexical names resolve in the
 * frame chain, everything else (car, map, `:key` accessors, the polyglot
 * resolvers) resolves here.
 *
 * GLASS mode: the lexical chain and the capability base are the SAME
 * `__parent__`-linked env, so this wraps it and keeps the LIVE walk (glass envs
 * don't bake — embedder-controlled mutability is a feature, design §3).
 * ASSEMBLED mode (ENV T2, environment-resolution-chain.md §§1–2): the base is
 * a SEALED artifact — a {@link CompiledResolutionChain} — and `lookup` consults
 * it instead of walking the env chain (zero live resolvers ⇒ ONE flat `Map.get`).
 * Either way the hygiene engine consults `globalRoot` (the unshadowed-builtin
 * identity, a STABLE singleton so `=== globalRoot` survives a topology change)
 * and `refFrame` (does the base OWN this name).
 */
export class Capabilities {
  static [CLASS] = "capabilities";

  /**
   * ASSEMBLED mode only — the sealed ambient artifact this base resolves through.
   * `undefined` ⇒ GLASS (live walk). T3 note (deferred, design §2 "hygiene
   * sentinel"): once `Frame`/`BakedBase` become distinct types, the chain object
   * itself becomes the sentinel; under T2's `Environment`-typed surface the base
   * leaf stays the sentinel (same one-identity-per-baked-base guarantee, pinned
   * by capabilities-assembled.test.ts).
   */
  private readonly chain: CompiledResolutionChain | undefined;

  /**
   * @param env  the base leaf this wraps (glass: the scope env; assembled: the base top).
   * @param chain  ASSEMBLED mode — the sealed resolution chain; `lookup`/`refFrame`
   *   consult it and `globalRoot` is the stable `env` sentinel. Absent (GLASS,
   *   default): the structural `chainRoot` probe over the live walk.
   */
  constructor(
    readonly env: Environment,
    chain?: CompiledResolutionChain,
  ) {
    this.chain = chain;
  }

  /**
   * The ASSEMBLED capability base — the baked `user_env → global_env` chain in its
   * SEALED form. `base` is the run's base leaf (`user_env` from env-roots.ts), passed
   * BY THE CALLER (generator-exec, which already imports the leaf safely) rather than
   * imported here: a value import of env-roots into this module would cycle through
   * the early-loaded eval chain (`Resolver → Capabilities → env-roots → new
   * Environment`, before `Environment` is constructed). `sealResolutionChain` is
   * memoized per base (one chain, one realm-shared memo), so the per-exec call here
   * reuses the artifact the assembly call sites sealed at bake end.
   */
  static assembled(base: Environment): Capabilities {
    return new Capabilities(base, sealResolutionChain(base));
  }

  /** The raw base bindings lookup (`undefined` on a miss, no synth) — the capability
   *  half of the Resolver's composed `scope.lookup(name) ?? capabilities.lookup(name)`.
   *  Glass: walks this scope's whole live `__parent__` chain (the lexical half never
   *  reaches here on a hit). Assembled: ONE probe of the sealed chain — the degenerate
   *  zero-resolver form is a single flat `Map.get` (design §2). */
  lookup(name: string | symbol): EnvironmentValue | undefined {
    return this.chain === undefined ? this.env._lookupWithResolvers(name) : this.chain.lookup(name);
  }

  /** The capability base = the chain root (`global_env`), found structurally as the
   *  parent-less top of this scope's chain rather than by an env-roots import (which would
   *  cycle through the early-loaded eval modules). The hygiene literal check compares a
   *  resolved frame `=== globalRoot` to mean "an unshadowed base builtin"; the root is a
   *  stable identity across the scope's lifetime. GLASS mode only. */
  private chainRoot(): Environment {
    let e: Environment = this.env;
    while (e.__parent__) e = e.__parent__;
    return e;
  }

  /** The stable "unshadowed base builtin" sentinel hygiene compares `=== globalRoot`.
   *  ASSEMBLED: the base top (`this.env`, e.g. `user_env`) — ONE identity for any
   *  base-owned name. GLASS: the structural chain root (`global_env`). */
  get globalRoot(): Environment {
    return this.chain === undefined ? this.chainRoot() : this.env;
  }

  /** The base's claim on `name`, as the `globalRoot` sentinel (or `undefined`). ASSEMBLED:
   *  ONE sealed-chain probe (merged maps + resolver steps — a resolver-answered name
   *  counts as base-owned, exactly like the live `_lookupWithResolvers` probe it
   *  replaces), so a native owned on the base leaf (`cons` on user_env) AND a builtin on
   *  global_env both resolve to the one sentinel. GLASS: the own-binding probe on the
   *  structural chain root. */
  refFrame(name: string): Environment | undefined {
    if (this.chain === undefined) {
      const root = this.chainRoot();
      return root.has(name) ? root : undefined;
    }
    return this.chain.lookup(name) === undefined ? undefined : this.env;
  }

  toString(): string {
    return `#<capabilities:${String(this.env.__name__)}>`;
  }
}
