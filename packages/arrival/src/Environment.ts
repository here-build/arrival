import { CLASS } from "./well-known-symbols.js";
import { CONSTANT_CTX } from "./values/primitives/RunContext.js";
import type { EnvironmentModule, FallbackResolver } from "./bindings.js";
import { isBridgeInitialized } from "./boot.js";
import type { EOF } from "./values/primitives/EOF.js";
import { AString } from "./values/primitives/AString.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import type { Macro } from "./eval/Macro.js";
import { AExact } from "./values/primitives/AExact.js";
import { AInexact } from "./values/primitives/AInexact.js";
import type { SchemeValue } from "./values/types.js";
import { nil } from "./values/primitives/ANil.js";
import type { RosettaFunction } from "./rosetta.js";
import { createRosettaWrapper } from "./rosetta.js";
import { typecheck } from "./utils/typecheck.js";
import type { Syntax } from "./eval/Syntax.js";
import invariant from "tiny-invariant";
import { fromJS, isSchemeValue } from "./membrane.js";
import { AJSObject } from "./values/primitives/AJSObject.js";
import { accessMember, NOT_FOUND } from "./interop-access.js";
import { InteropAccessError } from "./errors.js";
import { patch_value } from "./reader/values-repr.js";
import { rosettaPureOf, rosettaTypesOf } from "./env-registries.js";

/**
 * Brand on a keyword-accessor pluck function carrying its bare field name
 * (`:tagline` → "tagline"). Lets consumers detect a keyword key EXPLICITLY via
 * this symbol instead of sniffing valueOf/string shape. Registered (Symbol.for)
 * so it matches across the package boundary — arrival-chain's `dict` reads the
 * same key (project.ts).
 */
export const KEYWORD_ACCESSOR_FIELD = Symbol.for("@here.build/arrival/keyword-accessor-field");

// -------------------------------------------------------------------------
// :: Type definitions for Environment bindings
// -------------------------------------------------------------------------

/**
 * A name that can be used to look up values in an environment.
 * Supports strings, symbols (both primitive and SchemeSymbol), and SchemeString.
 */
export type BindingName = string | symbol | ASymbol | AString;

/**
 * A function with optional LIPS metadata.
 */
export interface LipsFunction extends Function {
  __doc__?: string;
  __name__?: string | symbol;
  __code__?: unknown;
}

/**
 * Value that can be stored in an environment.
 * This includes all SchemeValues plus runtime-specific types like Macro, Syntax, etc.
 */
export type EnvironmentValue = SchemeValue | LipsFunction | Macro | Syntax | EOF | Environment | RegExp;

// -------------------------------------------------------------------------
// :: Member access — formerly reached up into the stdlib monolith through a
// :: deferred runtime slot (the last LIPS-era DI channel). Both pieces are pure
// :: functions of leaf values, so Environment now owns them directly:
// ::   • own-keys enumeration (string keys + symbols, matching what clone()
// ::     preserves) for list();
// ::   • the dot-notation member walk (foo.bar.baz) for get(), which had no other
// ::     caller in the package.
// -------------------------------------------------------------------------

/** Own string keys + own symbols of a binding record (what `clone()` preserves). */
function ownProps(obj: object): (string | symbol)[] {
  return [...(Object.keys(obj) as (string | symbol)[]), ...Object.getOwnPropertySymbols(obj)];
}

/**
 * Walk a chain of (string) member keys off a base value, settling each step for
 * Scheme via `patch_value` (a Pair is cycle-marked + quoted, primitives boxed).
 * A foreign value routes through its membrane proxy (`SchemeJSObject.get`); any
 * other value reads through `accessMember`, so blocked names and members past an
 * interop boundary surface as a miss, never as host-internal leakage. A miss
 * yields `undefined`, and only the final key may miss (mid-chain miss throws —
 * "get X from undefined"), preserving the stdlib accessor's contract exactly.
 */
function walkMembers(base: unknown, keys: string[]): EnvironmentValue | undefined {
  let object: unknown = base;
  let value: EnvironmentValue | undefined;
  const remaining = [...keys];
  while (remaining.length > 0) {
    const name = remaining.shift()!;
    if (object instanceof AJSObject) {
      value = object.get(name) as EnvironmentValue;
    } else {
      try {
        const accessed = accessMember(object, name);
        value = accessed === NOT_FOUND ? undefined : (accessed as EnvironmentValue);
      } catch (error) {
        if (error instanceof InteropAccessError) {
          value = undefined;
        } else {
          throw error;
        }
      }
    }
    if (value === undefined) {
      invariant(remaining.length === 0, () => `Try to get ${remaining[0]} from undefined`);
      return value;
    }
    value = patch_value(value) as EnvironmentValue;
    object = value;
  }
  return value;
}
// -------------------------------------------------------------------------
export class Environment {
  static [CLASS] = "environment";
  private __resolvers__: FallbackResolver[] = [];
  /**
   * Per-run allocation meter (see `heap-budget.ts`). Installed by `exec` on the run's top env when a
   * `heapBudget` is requested, and found by `to_array` walking the parent chain from the calling
   * scope. Absent ⇒ no allocation bound (the default for un-budgeted callers). Run-scoped, not
   * chained-and-shared: the nearest one up the chain wins, so concurrent runs meter independently.
   */
  __heapMeter__?: import("./heap-budget.js").HeapMeter;

  // -------------------------------------------------------------------------
  // :: Fallback Resolver Management
  // -------------------------------------------------------------------------

  constructor(
    public __name__: string = "anonymous",
    public __env__: Record<string | symbol, EnvironmentValue> = {},
    public __parent__: Environment | null = null,
  ) {}

  /**
   * Compose modules into a parent-chained environment, dependency-deepest as the
   * base. The chain order is load-bearing, not cosmetic: a later module SHADOWS an
   * earlier one (lookup walks child→parent, see `_lookupWithResolvers`), so a
   * dependency must sit BELOW its dependents to be overridable by them. The
   * topological sort is what guarantees that — a module is pushed only after every
   * module it depends on, so deps are always nearer the base. The cycle guard is not
   * defensive boilerplate: a dependency cycle has no valid shadowing order (A must be
   * below B and B below A), so it is an unsatisfiable composition, caught at build
   * rather than surfacing as a missing binding at lookup.
   *
   * Returns the TOP env (where user code runs); the pure-Scheme base auto-loads
   * unless a module already provides the core primitives.
   *
   * @param modules - Modules to compose (dependency order is derived, not assumed)
   * @param exec - Optional evaluator for each module's bootstrap Scheme
   * @returns The topmost environment
   */
  static fromModules(
    modules: EnvironmentModule[],
    exec?: (code: string, env: Environment) => void,
  ): Environment {
    const execFn = exec;

    const moduleMap = new Map<string, EnvironmentModule>();
    for (const mod of modules) {
      moduleMap.set(mod.id, mod);
    }

    // DFS post-order = dependency-deepest first (the base-to-top chain order). The
    // `visiting` set is the back-edge detector: re-entering a node still on the
    // current DFS path is a cycle (the unsatisfiable shadowing order, see header).
    const sorted: EnvironmentModule[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    function visit(mod: EnvironmentModule) {
      if (visited.has(mod.id)) return;
      invariant(!visiting.has(mod.id), `Circular dependency detected: ${mod.id}`);
      visiting.add(mod.id);

      for (const depId of mod.dependencies ?? []) {
        const dep = moduleMap.get(depId);
        invariant(dep, `Module '${mod.id}' depends on unknown module '${depId}'`);
        visit(dep);
      }

      visiting.delete(mod.id);
      visited.add(mod.id);
      sorted.push(mod);
    }

    // Visit all modules
    for (const mod of modules) {
      visit(mod);
    }

    // Build environment chain
    let env: Environment | null = null;

    for (const mod of sorted) {
      // Create child environment with this module's bindings
      env = new Environment(mod.id, mod.bindings ?? {}, env);

      // Register resolver if present
      if (mod.resolver) {
        env.registerResolver(mod.resolver);
      }

      // Run bootstrap code if present and exec is provided
      if (mod.bootstrap && execFn) {
        execFn(mod.bootstrap, env);
      }
    }

    invariant(env, "No modules provided");

    return env;
  }

  /**
   * Register a fallback resolver.
   * Resolvers are tried in order when normal lookup fails.
   */
  registerResolver(resolver: FallbackResolver): this {
    // Fail LOUD on a malformed resolver. An `undefined`/`.resolve`-less entry would
    // otherwise push silently (an empty `__resolvers__.some(...)` short-circuits before
    // it could throw) and only surface much later as a "cannot read 'resolve'" crash at
    // lookup time — the symptom of a module-eval-time TDZ capture (see polyglot.ts).
    invariant(
      resolver != null && typeof resolver.resolve === "function" && typeof resolver.id === "string",
      "registerResolver: resolver must have a string id and a resolve() function",
    );
    // Prevent duplicate registration
    if (!this.__resolvers__.some((r) => r.id === resolver.id)) {
      this.__resolvers__.push(resolver);
    }
    return this;
  }

  defineRosetta(name: string, config: RosettaFunction): void {
    const wrapper = createRosettaWrapper(config);
    this.set(name, wrapper);
    if (config.type !== undefined) rosettaTypesOf(this).set(name, config.type);
    if (config.pure) rosettaPureOf(this).add(name);
  }

  list(): (string | symbol)[] {
    return ownProps(this.__env__);
  }

  /**
   * Every name bound anywhere up the `__parent__` chain from this scope, de-duplicated
   * (a name shadowed by a closer layer appears once). The chain-walk that was formerly
   * open-coded by the MCP discovery tool (poking `__parent__`/`list` from outside);
   * encapsulated here so the scope-node owns its own traversal and consumers type against
   * the `SchemeEnv` contract. Unsorted — the caller imposes any ordering/filtering.
   */
  allBoundNames(): (string | symbol)[] {
    const names = new Set<string | symbol>();
    for (let env: Environment | null = this; env; env = env.__parent__) {
      for (const name of env.list()) names.add(name);
    }
    return [...names];
  }

  inherit(
    name: string = `child of ${this.__name__ || "unknown"}`,
    obj: Record<string, EnvironmentValue> = {},
  ): Environment {
    return new Environment(name, obj, this);
  }

  /**
   * Resolve a name within one env layer before yielding to its parent. The
   * direct-bindings → resolvers → parent ordering is a precedence contract, not an
   * optimization: a module's explicit binding must WIN over its own lazy resolver
   * (so a pinned override can't be undone by a catch-all fallback in the same layer),
   * and BOTH must win over the parent (so a closer module shadows a deeper dependency
   * — the same child-before-parent rule `fromModules` builds the chain to honor). A
   * resolver returns `undefined` to mean "not mine, keep looking"; that is why the
   * loop treats `undefined` as yield rather than as a found nil.
   */
  _lookupWithResolvers(name: string | symbol): EnvironmentValue | undefined {
    if (Object.hasOwn(this.__env__, name as string)) {
      return this.__env__[name as string];
    }

    // Resolvers fire only AFTER a direct miss — a generated binding never masks an
    // explicit one in the same layer. `undefined` = "not mine"; anything else is the hit.
    for (const resolver of this.__resolvers__) {
      const result = resolver.resolve(String(name), this);
      if (result !== undefined) {
        return result as EnvironmentValue;
      }
    }

    return this.__parent__?._lookupWithResolvers(name);
  }

  toString(): string {
    return `#<environment:${this.__name__}>`;
  }

  merge(env: Environment, name: string = "merge"): Environment {
    typecheck("Environment::merge", env, "environment");
    return this.inherit(name, env.__env__);
  }

  get(symbol: BindingName, options: { throwError?: boolean } = {}): EnvironmentValue {
    // `:key` keyword accessors are no longer special-cased here: a `:`-prefixed symbol
    // is never a binding, so it falls through to `_lookupWithResolvers` (below) where
    // the polyglot capability's `keyword-accessor` resolver (membrane.ts) maps it to
    // the `@`-alias pluck — exactly like the `c[ad]+r` catchall. One catchall path.
    typecheck("Environment::get", symbol, ["symbol", "string"]);
    const { throwError = true } = options;

    // Normalize to string/symbol name
    let name: string | symbol = symbol as string | symbol;
    if (symbol instanceof ASymbol || symbol instanceof AString) {
      name = symbol.valueOf();
    }

    // First, try direct lookup for the literal symbol (handles names like %as.data)
    const directValue = this._lookupWithResolvers(name);
    if (directValue !== undefined) {
      return patch_value(directValue);
    }

    // Determine if this is a dot-notation symbol (e.g., foo.bar.baz)
    // Only try dot-notation if direct lookup failed
    let parts: string[] | undefined;
    if (symbol instanceof ASymbol && (symbol as unknown as { [key: symbol]: string[] })[ASymbol.object]) {
      // dot notation symbols from syntax-rules that are gensyms
      parts = (symbol as unknown as { [key: symbol]: string[] })[ASymbol.object];
    } else if (typeof name === "string" && name.includes(".")) {
      parts = name.split(".").filter(Boolean);
    }

    // Handle dot notation: foo.bar.baz
    if (parts && parts.length > 1) {
      const [first, ...rest] = parts;
      // Use _lookupWithResolvers to find the base object
      const baseValue = this._lookupWithResolvers(first);
      if (baseValue !== undefined) {
        // Access nested properties
        return walkMembers(baseValue, rest) as EnvironmentValue;
      }
      // Base not found - fall through to error handling
    }

    if (throwError) {
      throw Object.assign(new Error(`Unbound variable \`${name.toString()}'`), {
        publicMessage: `symbol ${name.toString()} does not exist - look at list of available functions at tool description`,
      });
    }
    return undefined;
  }

  set(name: BindingName, value: EnvironmentValue | number | bigint): this {
    typecheck("Environment::set", name, ["string", "symbol"]);
    let storedValue: EnvironmentValue;

    // Numbers get special handling (convert to SchemeExact/SchemeInexact for typed numeric ops)
    if (typeof value === "number") {
      if (Number.isNaN(value)) {
        storedValue = new AInexact(CONSTANT_CTX, value);
      } else {
        storedValue = Number.isSafeInteger(value) ? new AExact(CONSTANT_CTX, BigInt(value)) : new AInexact(CONSTANT_CTX, value);
      }
    } else if (typeof value === "bigint") {
      storedValue = new AExact(CONSTANT_CTX, value);
    }
    // Already a Scheme value - pass through
    else if (isSchemeValue(value)) {
      storedValue = value;
    }
    // Primitives (boolean, string, symbol) pass through
    else if (typeof value === "boolean" || typeof value === "string" || typeof value === "symbol") {
      storedValue = value as EnvironmentValue;
    }
    // Functions pass through as-is (membrane wrapping happens at interop points, not storage)
    else if (typeof value === "function") {
      storedValue = value as EnvironmentValue;
    }
    // Error objects pass through unwrapped for exception handling (R7RSError, etc.)
    else if (value instanceof Error) {
      storedValue = value as EnvironmentValue;
    }
    // Objects get wrapped via membrane
    else {
      storedValue = fromJS(value) as EnvironmentValue;
    }

    let key: string | symbol;
    if (name instanceof ASymbol) {
      key = name.__name__;
    } else if (name instanceof AString) {
      key = name.valueOf();
    } else {
      key = name;
    }
    this.__env__[key as string] = storedValue;
    return this;
  }

  constant(name: string, value: EnvironmentValue): this {
    invariant(!Object.hasOwn(this.__env__, name), `Environment::constant: ${name} already exists`);
    Object.defineProperty(this.__env__, name, {
      value,
      enumerable: true,
    });
    return this;
  }

  has(name: string): boolean {
    return this.__env__.hasOwnProperty(name);
  }

  ref(name: string): Environment | undefined {
    let env: Environment | null = this;
    while (true) {
      if (!env) {
        break;
      }
      if (env.has(name)) {
        return env;
      }
      env = env.__parent__;
    }
  }

  // -------------------------------------------------------------------------
  // :: Runtime bootstrap (lazy, realm-level)
  // -------------------------------------------------------------------------

  /**
   * Whether the runtime bootstrap (bridge: TS builtins + assembled pack preludes
   * + sandbox seeding) has run for this realm. Realm-global: the bootstrap mutates
   * global singletons once, so every Environment reads the same flag. `exec` checks
   * this and calls `init()` when it's down, so embedders never call `initBridge()`.
   */
  get initialized(): boolean {
    return isBridgeInitialized();
  }

  /**
   * Ensure the runtime bootstrap has run. Idempotent and cheap once settled —
   * delegates to the bridge's `initBridge`, which memoizes via a single promise.
   * Dynamic import avoids a static Environment→bridge cycle (bridge imports
   * Environment); the edge is call-time only.
   */
  async init(): Promise<void> {
    const { initBridge } = await import("./bridge.js");
    await initBridge();
  }

}
