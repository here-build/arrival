import { CLASS } from "./well-known-symbols.js";
import { CONSTANT_CTX } from "./values/primitives/RunContext.js";
import type { ResolverSpec } from "./common/scheme-env.js";
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
import type { SchemeEnv } from "./common/scheme-env.js";
import { typecheck } from "./utils/typecheck.js";
import type { Syntax } from "./eval/Syntax.js";
import invariant from "tiny-invariant";
import { fromJS, isSchemeValue } from "./membrane.js";
import { patch_value } from "./reader/values-repr.js";
import { rosettaPureOf, rosettaTypesOf } from "./env-registries.js";
import { unboundVariableError } from "./env/polyglot-rich-errors/registry.js";

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

// -------------------------------------------------------------------------
/**
 * The low-level lexical FRAME-STORAGE primitive: a `__name__`/`__env__` binding
 * record with a `__parent__` link and its own fallback resolvers, plus a run-scoped
 * heap meter. One `__parent__`-linked chain is a scope.
 *
 * It is the storage the evaluator's resolution model wraps — NOT the model itself
 * (ejection P3/P5):
 *   - {@link LexicalScope} (eval/LexicalScope.ts) wraps an Environment as the
 *     lexical-binding chain (let/lambda/letrec/… frames a program introduces).
 *   - {@link Capabilities} (eval/Capabilities.ts) wraps the assembled base
 *     (builtins/preludes/host resolvers) a run is armed with.
 *   - {@link Resolver} (eval/Resolver.ts) composes the two — `scope.lookup ??
 *     capabilities.lookup` — and is the single object the evaluator threads
 *     (`EvalContext.resolver`). `resolver.env` is the underlying lexical frame.
 *
 * INTERNAL-ONLY: not on the public surface (see index.ts). Cross-package consumers
 * type against the structural `SchemeEnv` contract (common/scheme-env.ts), never
 * this concrete class — so the name "Environment" is an impl detail under the
 * Resolver/LexicalScope/Capabilities model, deliberately NOT renamed to "Scope"
 * (which {@link LexicalScope} owns) or "Frame".
 */
export class Environment implements SchemeEnv {
  static [CLASS] = "environment";
  private __resolvers__: ResolverSpec[] = [];
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
    // `string | symbol`: a merge-frame's identity IS `Symbol.for("merge")`
    // (Syntax.__merge_env__), and LexicalScope.kind compares it by symbol-IDENTITY
    // — coercing to string would break hygiene. Display sites (toString, the
    // Resolver/Capabilities reprs, the StackFrame name) wrap it in `String(...)`.
    public __name__: string | symbol = "anonymous",
    public __env__: Record<string | symbol, EnvironmentValue> = {},
    public __parent__: Environment | null = null,
  ) {}

  /**
   * Register a fallback resolver.
   * Resolvers are tried in order when normal lookup fails.
   */
  registerResolver(resolver: ResolverSpec): this {
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
    name: string | symbol = `child of ${String(this.__name__) || "unknown"}`,
    obj: Record<string, EnvironmentValue> = {},
  ): Environment {
    return new Environment(name, obj, this);
  }

  /**
   * Resolve a name within one env layer before yielding to its parent. The
   * direct-bindings → resolvers → parent ordering is a precedence contract, not an
   * optimization: a module's explicit binding must WIN over its own lazy resolver
   * (so a pinned override can't be undone by a catch-all fallback in the same layer),
   * and BOTH must win over the parent (so a closer module shadows a deeper dependency). A
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
      const result = resolver.resolve(String(name));
      if (result !== undefined) {
        return result as EnvironmentValue;
      }
    }

    return this.__parent__?._lookupWithResolvers(name);
  }

  toString(): string {
    return `#<environment:${String(this.__name__)}>`;
  }

  merge(env: Environment, name: string | symbol = "merge"): Environment {
    typecheck("Environment::merge", env, "environment");
    return this.inherit(name, env.__env__);
  }

  get(symbol: BindingName, options: { throwError?: boolean } = {}): EnvironmentValue | undefined {
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

    if (throwError) {
      throw unboundVariableError(name.toString());
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

  // The runtime bootstrap is NO LONGER an Environment concern. It used to live here as
  // `init()` / `initialized` — a per-env trigger indirection that `exec` drove and that
  // dynamic-imported the bridge. That ceremony is gone: the lazy, realm-cached base
  // assembly lives in the one entry point that needs it (`ensureBaseAssembled` in
  // eval/generator-exec.ts, exposed publicly as `initBridge`), driven directly by `exec`.
  // The scope-node is just a scope again.
}
