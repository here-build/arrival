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
import { rosettaTypesOf } from "./env-registries.js";
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
 * record with a `__parent__` link. One `__parent__`-linked chain is a scope.
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
 * ENV T1 (docs/working-proposals/environment-resolution-chain.md §T1, Option C
 * extraction 1 of docs/working-proposals/environment-decomposition-options.md):
 * fallback resolvers used to live on EVERY Environment instance, even though only
 * the baked capability roots (`global_env`/`user_env`, env-roots.ts) ever have any
 * registered in production — every let/lambda/letrec frame carried a dead-weight
 * `__resolvers__: []` and paid an empty loop on every lookup miss. Resolvers now
 * live ONLY on {@link ResolvingEnvironment} (below); a plain `Environment` frame's
 * `_lookupWithResolvers` is own-bindings → parent, no middle leg. Polymorphic
 * dispatch means a plain lexical frame chaining up to a `ResolvingEnvironment` root
 * (`__parent__`-linked) still consults that root's resolvers correctly — the walk
 * is unchanged end-to-end, only the per-frame cost of frames that never had
 * resolvers to begin with. GLASS mode (a caller-supplied custom env chain) is
 * unaffected: it keeps the exact walk it always had, resolver-capable at whichever
 * layer was constructed as `ResolvingEnvironment`.
 *
 * INTERNAL-ONLY: not on the public surface (see index.ts). Cross-package consumers
 * type against the structural `SchemeEnv` contract (common/scheme-env.ts), never
 * this concrete class — so the name "Environment" is an impl detail under the
 * Resolver/LexicalScope/Capabilities model, deliberately NOT renamed to "Scope"
 * (which {@link LexicalScope} owns) or "Frame".
 */
export class Environment {
  static [CLASS] = "environment";

  constructor(
    // `string | symbol`: a merge-frame's identity IS `Symbol.for("merge")`
    // (Syntax.__merge_env__), and LexicalScope.kind compares it by symbol-IDENTITY
    // — coercing to string would break hygiene. Display sites (toString, the
    // Resolver/Capabilities reprs, the StackFrame name) wrap it in `String(...)`.
    public __name__: string | symbol = "anonymous",
    public __env__: Record<string | symbol, EnvironmentValue> = {},
    public __parent__: Environment | null = null,
  ) {}

  defineRosetta(name: string, config: RosettaFunction): void {
    const wrapper = createRosettaWrapper(config);
    this.set(name, wrapper);
    // `config.pure` is consumed INSIDE createRosettaWrapper (the runtime mint gate,
    // `mintsPoint = pure !== true`) — no static side-table records it any more; the
    // static classifier reads the declared `.provenanceRole` off baked bound values
    // instead (values/lineage-classifier-from-env.ts, Q3). Legacy-registered names
    // carry no role and fall to the classifier's `undefined` default.
    if (config.type !== undefined) rosettaTypesOf(this).set(name, config.type);
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
   * Resolve a name within one env layer before yielding to its parent. Own bindings win
   * over the parent (a closer module shadows a deeper dependency) — the resolver leg
   * that used to sit between them lives only on {@link ResolvingEnvironment} now (ENV T1);
   * a plain frame is own → parent, full stop.
   */
  _lookupWithResolvers(name: string | symbol): EnvironmentValue | undefined {
    if (Object.hasOwn(this.__env__, name as string)) {
      return this.__env__[name as string];
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

/**
 * ENV T1 extraction (docs/working-proposals/environment-resolution-chain.md §T1):
 * the BAKED-ROOT specialization of {@link Environment} — the only place fallback
 * resolvers live. Exactly the two production producer classes register here (see the
 * design doc §0): the kernel's phase-gated prelude-scope resolver
 * (`common/kernel.ts`'s `assembleEnv`, via the `registerResolver` duck-type probe) and
 * pack-declared `EnvCapability.resolvers` (`common/capability.ts:383`). Both apply
 * targets are, and must stay, `ResolvingEnvironment` instances: `env-roots.ts`'s
 * `global_env`/`user_env`, and any env built by `.inherit()`ing off one of those (e.g.
 * `generator-exec.ts`'s per-call `exec-capabilities` base) — `inherit()` is overridden
 * below to keep that subtype, so a capability-augmented base built on top of `user_env`
 * stays resolver-capable without the caller doing anything special.
 *
 * Plain lexical frames (let/lambda/letrec/… — `Environment.inherit`, `defaultLexicalRoot`)
 * are deliberately NOT `ResolvingEnvironment`: per the design's ambient/lexical boundary,
 * only the baked capability base is "ambient" middleware territory; the lexical chain a
 * program introduces is cut from it. A GLASS caller (custom `{ env }`) that wants a layer
 * of its own chain to answer via resolver must build that layer as a `ResolvingEnvironment`
 * explicitly — the current walk otherwise stays byte-identical (a resolver-less layer in a
 * glass chain just falls straight through to its parent, same as any other name miss).
 */
export class ResolvingEnvironment extends Environment implements SchemeEnv {
  private readonly __resolvers__: ResolverSpec[] = [];

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

  /** Remove a registered resolver by id — the kernel's SEAL hook (ENV T2, design §1):
   *  the bake-scoped `preludeOnly` overlay registers for the C3 loop's duration and
   *  unregisters here, so no spent machinery survives assembly on any env. No-op for
   *  an unknown id. */
  unregisterResolver(id: string): this {
    const at = this.__resolvers__.findIndex((r) => r.id === id);
    if (at !== -1) this.__resolvers__.splice(at, 1);
    return this;
  }

  /** Seal-time read for the chain compiler (eval/CompiledResolutionChain.ts): the
   *  registered resolver specs in registration (= C3 apply) order. Live view — the
   *  compiler snapshots position at seal; callers must not mutate. */
  resolverSpecs(): readonly ResolverSpec[] {
    return this.__resolvers__;
  }

  /**
   * The full direct-bindings → resolvers → parent precedence contract (unchanged from
   * pre-T1 `Environment`): a module's explicit binding wins over its own lazy resolver
   * (a pinned override can't be undone by a catch-all fallback in the same layer), and
   * BOTH win over the parent (a closer module shadows a deeper dependency). A resolver
   * returns `undefined` to mean "not mine, keep looking" — never a found nil.
   */
  override _lookupWithResolvers(name: string | symbol): EnvironmentValue | undefined {
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

  /** Covariant override: a `ResolvingEnvironment`'s child stays resolver-capable (e.g. the
   *  per-call `exec-capabilities` base built by `.inherit()`ing off `user_env`). */
  override inherit(
    name: string | symbol = `child of ${String(this.__name__) || "unknown"}`,
    obj: Record<string, EnvironmentValue> = {},
  ): ResolvingEnvironment {
    return new ResolvingEnvironment(name, obj, this);
  }
}
