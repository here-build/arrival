/**
 * Module & resolver contracts — SUPERSEDED, currently unreferenced.
 *
 * `Environment.ts` no longer consumes these: its `registerResolver`/
 * `_lookupWithResolvers` type against `ResolverSpec` (`common/scheme-env.ts`,
 * whose header notes it "mirrors arrival-scheme's `FallbackResolver`
 * structurally"), not the `FallbackResolver` below. `EnvironmentModule` (the
 * composable bindings+resolver+bootstrap layering unit) has no consumer at
 * all — the env-pack/capability system (`common/kernel.ts` + `common/
 * capability.ts`) is the layering mechanism in current use. Neither type is
 * imported anywhere in this package or by a cross-package consumer; kept
 * only pending an explicit decision to delete.
 */

import type { Environment } from "./Environment.js";
import type { SchemeValue } from "./values/types.js";

/**
 * Called when normal symbol lookup fails — keyword accessors (`:key`), dot
 * notation (`foo.bar`), auto-imports, etc.
 */
export interface FallbackResolver {
  /** Unique id; prevents duplicate registration. */
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
 * `bootstrap` Scheme, plus the `dependencies` it declares. The intended per-layer
 * resolution order was bindings → resolver → parent: an explicit binding beats
 * the layer's own catch-all resolver, both beat the dependency below. (Not wired
 * to any assembler — see file header.)
 */
export interface EnvironmentModule {
  /** Unique id; used for dependency resolution and debugging. */
  readonly id: string;

  /** Module IDs that must load before this one. */
  readonly dependencies?: string[];

  /** Direct bindings added to the environment; checked before `resolver`. */
  readonly bindings?: Record<string, SchemeValue>;

  /** Lazy/dynamic symbol lookup, tried when a direct binding misses. Return
   *  undefined to yield to the parent module. */
  readonly resolver?: FallbackResolver;

  /** Scheme code evaluated after bindings and resolver are set — for derived
   *  functions/macros. */
  readonly bootstrap?: string;
}
