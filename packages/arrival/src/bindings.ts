/**
 * Module & resolver contracts for the Scheme environment.
 *
 * Defines the two interfaces the environment-composition layer
 * (`Environment.fromModules`) consumes:
 * - `FallbackResolver` — extensible lazy lookup (keyword accessors, dot
 *   notation, auto-imports) tried when a direct binding lookup misses.
 * - `EnvironmentModule` — a composable unit of bindings + resolver +
 *   bootstrap code, layered into the environment chain.
 */

import type { Environment } from "./Environment.js";
import type { SchemeValue } from "./values/types.js";

/**
 * Called when normal symbol lookup fails.
 * Enables extensible resolution strategies like:
 * - Keyword accessors (:key -> property accessor)
 * - Dot notation (foo.bar -> property access)
 * - Auto-imports
 * - etc.
 */
export interface FallbackResolver {
  /**
   * Unique identifier for this resolver.
   * Used to prevent duplicate registration.
   */
  readonly id: string;

  /**
   * Attempt to resolve a symbol name.
   *
   * @param name - The symbol name that wasn't found
   * @param env - The environment where lookup failed
   * @returns Resolved value, or undefined if this resolver doesn't handle it
   */
  resolve(name: string, env: Environment): SchemeValue | undefined;
}

/**
 * A composable env layer: eager `bindings`, a lazy `resolver`, and post-binding
 * `bootstrap` Scheme. `dependencies` drive the composition order — a module is
 * chained as a CHILD of (i.e. ABOVE, shadowing) every module it depends on, so its
 * overrides win over the deeper dependency (see `Environment.fromModules` for why
 * that ordering is load-bearing, not cosmetic). Per-layer resolution is
 * bindings → resolver → parent (`_lookupWithResolvers`): an explicit binding beats
 * the layer's own catch-all resolver, both beat the dependency below.
 */
export interface EnvironmentModule {
  /**
   * Unique identifier for this module.
   * Used for dependency resolution and debugging.
   */
  readonly id: string;

  /**
   * Module IDs that must be loaded before this module.
   */
  readonly dependencies?: string[];

  /**
   * Direct bindings to add to the environment.
   * These are checked before resolvers.
   */
  readonly bindings?: Record<string, SchemeValue>;

  /**
   * Resolver for lazy/dynamic symbol lookup.
   * Called when direct binding lookup fails.
   * Return undefined to yield to parent module.
   */
  readonly resolver?: FallbackResolver;

  /**
   * Scheme code to evaluate after bindings and resolver are set.
   * Useful for defining derived functions/macros.
   */
  readonly bootstrap?: string;
}
