import { CLASS } from "../well-known-symbols.js";
import type { Environment, EnvironmentValue } from "../Environment.js";

/**
 * The CAPABILITY base — the builtins/preludes/host-supplied resolvers a run is
 * armed with (today, everything reachable from `global_env`). In the eventual
 * (3b) split this is the shared root that a {@link LexicalScope} falls through
 * to: lexical names resolve in the frame chain, everything else (car, map,
 * `:key` accessors, the polyglot resolvers) resolves here.
 *
 * In 3b.2 the lexical chain and the capability base are still the SAME
 * `__parent__`-linked env, so this wraps it. The hygiene engine now consults
 * `globalRoot` (the unshadowed-builtin identity, kept a STABLE singleton so
 * `=== globalRoot` survives the topology swap) and `refFrame` (does the base
 * OWN this name). 3b.3 severs the link; the surface here is already the target.
 */
export class Capabilities {
  static [CLASS] = "capabilities";

  /**
   * @param env  the base leaf this wraps (glass: the scope env; assembled: the base top).
   * @param assembledBase  ASSEMBLED mode — `globalRoot`/`refFrame` use the `env` sentinel
   *   and probe the WHOLE base chain, surviving the 3b.3 topology cut. GLASS (default) keeps
   *   the structural `chainRoot` probe, byte-identical to 3b.2.
   */
  constructor(
    readonly env: Environment,
    private readonly assembledBase = false,
  ) {}

  /**
   * The ASSEMBLED capability base — the two-frame `user_env → global_env` chain.
   * `base` is the run's base leaf (`user_env` from env-roots.ts), passed BY THE
   * CALLER (generator-exec, which already imports the leaf safely) rather than
   * imported here: a value import of env-roots into this module would cycle through
   * the early-loaded eval chain (`Resolver → Capabilities → env-roots → new
   * Environment`, before `Environment` is constructed). In 3b.2 this is a glass over
   * `base`: `lookup` walks `base → global_env`; `globalRoot` is the stable `base`
   * sentinel (the base top), `refFrame` probes the WHOLE `base → global_env` chain —
   * both survive the 3b.3 topology cut (when `base` is sourced from a still-base-linked
   * `user_env`, but a name owned anywhere in the base resolves to the one sentinel).
   */
  static assembled(base: Environment): Capabilities {
    return new Capabilities(base, true);
  }

  /** The raw base bindings walk (`undefined` on a miss, no synth) — the capability
   *  half of the Resolver's composed `scope.lookup(name) ?? capabilities.lookup(name)`.
   *  Glass: walks this scope's whole `__parent__` chain (the lexical half never reaches
   *  here on a hit). Assembled: walks `user_env → global_env` (the base only). */
  lookup(name: string | symbol): EnvironmentValue | undefined {
    return this.env._lookupWithResolvers(name);
  }

  /** The capability base = the chain root (`global_env`), found structurally as the
   *  parent-less top of this scope's chain rather than by an env-roots import (which would
   *  cycle through the early-loaded eval modules). The hygiene literal check compares a
   *  resolved frame `=== globalRoot` to mean "an unshadowed base builtin"; the root is a
   *  stable identity that survives the 3b.3 cut. */
  private chainRoot(): Environment {
    let e: Environment = this.env;
    while (e.__parent__) e = e.__parent__;
    return e;
  }

  /** The stable "unshadowed base builtin" sentinel hygiene compares `=== globalRoot`.
   *  ASSEMBLED: the base top (`this.env`, e.g. `user_env`) — ONE identity for any
   *  base-owned name, surviving the cut. GLASS: the structural chain root (`global_env`). */
  get globalRoot(): Environment {
    return this.assembledBase ? this.env : this.chainRoot();
  }

  /** The base's claim on `name`, as the `globalRoot` sentinel (or `undefined`). ASSEMBLED:
   *  probe the WHOLE base chain (`this.env → … → global_env` via `Environment.ref`), so a
   *  native owned on the base leaf (`cons` on user_env) AND a builtin on global_env both
   *  resolve to the one sentinel — replacing the GLASS `chainRoot.has` that only caught the
   *  chain root. GLASS: the own-binding probe on the structural chain root. */
  refFrame(name: string): Environment | undefined {
    if (this.assembledBase) {
      return this.env.ref(name) ? this.globalRoot : undefined;
    }
    const root = this.chainRoot();
    return root.has(name) ? root : undefined;
  }

  toString(): string {
    return `#<capabilities:${this.env.__name__}>`;
  }
}
