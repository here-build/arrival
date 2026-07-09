import { CLASS } from "./well-known-symbols.js";
import { type ResolverSpec, type SchemeEnv } from "./common/scheme-env.js";
import type { EOF } from "./values/primitives/EOF.js";
import { AString } from "./values/primitives/AString.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import type { Macro } from "./eval/Macro.js";
import type { AProcedure, SchemeValue } from "./values/types.js";
import { createRosettaWrapper, type RosettaFunction } from "./rosetta.js";
import type { Syntax } from "./eval/Syntax.js";
import invariant from "tiny-invariant";
import { fromJS, isSchemeValue } from "./membrane.js";
import { patch_value } from "./reader/values-repr.js";
import { rosettaPureOf, rosettaTypesOf } from "./env-registries.js";
import { unboundVariableError } from "./env/polyglot-rich-errors/registry.js";

// -------------------------------------------------------------------------
// :: Type definitions for Environment bindings
// -------------------------------------------------------------------------

/** A name usable to look up values in an environment: string, symbol, ASymbol, or AString. */
export type BindingName = string | symbol | ASymbol | AString;

/** Anything storable in an environment: SchemeValues plus runtime types (Macro, Syntax, etc). */
export type EnvironmentValue = SchemeValue | AProcedure | Macro | Syntax | EOF | Environment | RegExp;

// -------------------------------------------------------------------------
// :: Member access — both pure functions of leaf values, owned directly by
// :: Environment: own-keys enumeration (matching what clone() preserves) for
// :: list(), and the dot-notation member walk (foo.bar.baz) for get().
// -------------------------------------------------------------------------

/** Own string keys + own symbols of a binding record (what `clone()` preserves). */
function ownProps(obj: object): (string | symbol)[] {
  return [...(Object.keys(obj) as (string | symbol)[]), ...Object.getOwnPropertySymbols(obj)];
}

/**
 * The low-level lexical FRAME-STORAGE primitive: a `__name__`/`__env__` binding
 * record with a `__parent__` link and its own fallback resolvers. One
 * `__parent__`-linked chain is a scope.
 *
 * It is the storage the evaluator's resolution model wraps — NOT the model itself:
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
  private readonly __resolvers__: ResolverSpec[] = [];

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

  /** Register a fallback resolver. Resolvers are tried in order when normal lookup fails. */
  registerResolver(resolver: ResolverSpec): this {
    // Fail LOUD on a malformed resolver — a silent push would only surface later as a
    // "cannot read 'resolve'" crash at lookup time (symptom of a module-eval-time TDZ
    // capture, see polyglot.ts).
    invariant(
      resolver != null && typeof resolver.resolve === "function" && typeof resolver.id === "string",
      "registerResolver: resolver must have a string id and a resolve() function",
    );
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
   * (a name shadowed by a closer layer appears once). Unsorted — the caller imposes any
   * ordering/filtering.
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
   * (a pinned override can't be undone by a catch-all fallback in the same layer),
   * and BOTH must win over the parent (a closer module shadows a deeper dependency).
   * A resolver returns `undefined` to mean "not mine, keep looking" — never a found nil.
   */
  _lookupWithResolvers(name: string | symbol): EnvironmentValue | undefined {
    if (Object.hasOwn(this.__env__, name as string)) {
      return this.__env__[name as string];
    }

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
    return this.inherit(name, env.__env__);
  }

  /**
   * T0b NOTE (not extracted here — T3 territory): `get()`'s `patch_value(directValue)` call
   * below is the SAME storage-membrane class of work as `set()`'s (former) auto-boxing —
   * every read gets coerced (pair → `quote(mark_cycles(...))`, else `box(value)`) on the way
   * out, mirroring the box-on-the-way-in `set()` used to do. Unlike `set()`'s boxing, this
   * coercion isn't a narrow-the-signature fix: it runs on the READ path for every lookup hit
   * (own bindings, resolver hits, and parent-chain hits alike), so moving it to "the caller's
   * boundary" isn't a single call-site rewrite — it would need every `get()`/`lookupSettled()`/
   * `_lookupWithResolvers` consumer to apply its own patch, or a wrapping read-membrane type
   * (`Frame`/`BakedBase` per the decomposition options doc, Option A/C) that owns "coerce on
   * read" as a declared responsibility instead of a per-call incidental. That's the T1/T3
   * territory (frames vs. baked roots as distinct types), not a T0 no-regret move.
   */
  get(symbol: BindingName, options: { throwError?: boolean } = {}): EnvironmentValue | undefined {
    // `:key` keyword accessors aren't special-cased here: a `:`-prefixed symbol is never
    // a binding, so it falls through to `_lookupWithResolvers` where the polyglot
    // capability's `keyword-accessor` resolver (membrane.ts) maps it to the `@`-alias
    // pluck — exactly like the `c[ad]+r` catchall. One catchall path.
    const { throwError = true } = options;

    let name: string | symbol = symbol as string | symbol;
    if (symbol instanceof ASymbol || symbol instanceof AString) {
      name = symbol.valueOf();
    }

    // Direct lookup for the literal symbol (handles names like %as.data)
    const directValue = this._lookupWithResolvers(name);
    if (directValue !== undefined) {
      return patch_value(directValue);
    }

    if (throwError) {
      throw unboundVariableError(name.toString());
    }
    return undefined;
  }

  /**
   * Storage-membrane face (T0b, docs/working-proposals/environment-decomposition-options.md
   * bucket 4): `set()` accepts `EnvironmentValue` ONLY — an honest signature. A caller that
   * used to pass a raw JS `number`/`bigint` and rely on Environment auto-boxing it into
   * AExact/AInexact must now box at ITS OWN boundary before calling `set` (via `fromJS`/
   * `jsToScheme` per context) — storage is inside the membrane, not a second door into it.
   */
  set(name: BindingName, value: EnvironmentValue): this {
    let storedValue: EnvironmentValue;

    if (isSchemeValue(value)) {
      storedValue = value;
    }
    // Bare-value purge (A4/P4): a raw JS boolean/string/symbol used to pass through
    // unboxed here — a P4 violation (the membrane's world ends at the frame boundary;
    // storage IS inside). Falls to the `fromJS` branch below, which boxes it
    // (boolean→ABool, string→AString, a registered symbol→keyword ASymbol, a unique
    // symbol→#void+warn) exactly like every other non-scheme JS value entering storage.
    // Membrane wrapping happens at interop points, not storage
    else if (typeof value === "function") {
      storedValue = value as EnvironmentValue;
    }
    // Unwrapped for exception handling (R7RSError, etc.)
    else if (value instanceof Error) {
      storedValue = value as EnvironmentValue;
    }
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

  has(name: string): boolean {
    return Object.hasOwn(this.__env__, name);
  }
}
