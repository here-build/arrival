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

  constructor(readonly env: Environment) {}

  /**
   * The ASSEMBLED capability base — the two-frame `user_env → global_env` chain.
   * `base` is the run's base leaf (`user_env` from env-roots.ts), passed BY THE
   * CALLER (generator-exec, which already imports the leaf safely) rather than
   * imported here: a value import of env-roots into this module would cycle through
   * the early-loaded eval chain (`Resolver → Capabilities → env-roots → new
   * Environment`, before `Environment` is constructed). In 3b.2 this is a glass over
   * `base`: `globalRoot`/`refFrame` still chainRoot to `global_env` (so it is
   * additive/inert — `assembled()` is unused until the 3b.3 flip), `lookup` walks
   * `base → global_env`. 3b.3 step 4 repoints `globalRoot`/`refFrame` onto the
   * stable `base` sentinel that survives the topology cut.
   */
  static assembled(base: Environment): Capabilities {
    return new Capabilities(base);
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

  get globalRoot(): Environment {
    return this.chainRoot();
  }

  /** The owning frame of `name` in the base, or `undefined`. The base IS the chain root
   *  (where `Environment.ref` bottoms out), so this is an own-binding probe on it. */
  refFrame(name: string): Environment | undefined {
    const root = this.chainRoot();
    return root.has(name) ? root : undefined;
  }

  toString(): string {
    return `#<capabilities:${this.env.__name__}>`;
  }
}
