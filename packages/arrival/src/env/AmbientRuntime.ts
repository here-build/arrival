import { type ResolverSpec, type SchemeEnv } from "../common/scheme-env.js";
import type { EOF } from "../values/primitives/EOF.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import type { Macro } from "../eval/Macro.js";
import type { SchemeValue } from "../values/types.js";
import { createRosettaWrapper, type RosettaFunction } from "../membrane/rosetta.js";
import type { Syntax } from "../eval/Syntax.js";
import invariant from "tiny-invariant";
import { fromJS, isSchemeValue } from "../membrane/membrane.js";
import { quote } from "../values/values-repr.js";
import { APair } from "../values/primitives/APair.js";
import type { RunContext } from "../run/RunContext.js";
import { unboundVariableError } from "../unbound-variable.js";
import { RawCrossingError } from "../errors.js";
import { INTEROP_BOUNDARY } from "../membrane/interop-access.js";

/** A name usable to look up values in an environment: string, symbol, ASymbol, or AString. */
export type BindingName = string | symbol | ASymbol | AString;

/** Anything storable in an environment: SchemeValues plus runtime types (Macro, Syntax, etc).
 *  Bare host functions are NOT ambient — callables are ACallable AValues already inside
 *  SchemeValue. */
export type AmbientValue = SchemeValue | Macro | Syntax | EOF | AmbientRuntime | RegExp;

/** Own string keys + own symbols of a binding record — what list() enumerates. */
function ownProps(obj: object): (string | symbol)[] {
  return [...(Object.keys(obj) as (string | symbol)[]), ...Object.getOwnPropertySymbols(obj)];
}

/**
 * RAW frame minters — module-internal (NOT barrel-exported; same discipline as
 * {@link bindValue}). Constructor arm is not on the public type; assigned from each
 * class's static block (only scope a protected constructor is callable from).
 * Production birth: {@link mintFrame} (subtype-preserving child) or null-parent here
 * (isolated root). Storage-law tests reach these raws for exact chain shapes.
 */
export let mintPlainFrame!: (
  name?: string | symbol,
  bindings?: Record<string | symbol, AmbientValue>,
  parent?: AmbientRuntime | null,
) => AmbientRuntime;
export let mintResolvingFrame!: (
  name?: string | symbol,
  bindings?: Record<string | symbol, AmbientValue>,
  parent?: AmbientRuntime | null,
) => ResolvingAmbient;

/**
 * Lexical FRAME STORAGE: `__name__` / `__env__` / `__parent__`. One parent-linked chain
 * is a scope. Storage the evaluator's resolution model wraps — NOT the model itself:
 *
 *   - {@link LexicalScope} — let/lambda/letrec frames a program introduces
 *   - {@link Capabilities} — assembled base (builtins / preludes / host resolvers)
 *   - {@link Resolver} — `scope.lookup ?? capabilities.lookup`; the evaluator threads
 *     `EvalContext.resolver`; `resolver.env` is the underlying lexical frame
 *
 * Fallback resolvers live ONLY on {@link ResolvingAmbient}. A plain frame is
 * own-bindings → parent. Production resolvers sit on baked capability roots, so
 * program-introduced frames carry no resolver array. A plain frame parented under a
 * `ResolvingAmbient` still consults that root's resolvers via polymorphic walk.
 *
 * INTERNAL-ONLY (index.ts). Cross-package consumers type against structural `SchemeEnv`
 * (common/scheme-env.ts), never this class. Name is deliberate: not "Scope"
 * ({@link LexicalScope}) or "Frame".
 *
 * HERMETIC FROM JS (docs/environments.md §HERMETIC). No public birth: no `inherit()` /
 * `merge()`, no public constructor arm. Frame birth is module-internal
 * {@link mintFrame} / {@link mintPlainFrame} / {@link mintResolvingFrame} — same
 * not-exported discipline as {@link bindValue}.
 */
export class AmbientRuntime {
  // Outside the AValue/ArrivalError families (interop-access.ts FAMILY RULEs); own stamp.
  static [INTEROP_BOUNDARY] = true;
  // Module-dup-robust brand for `isAmbientRuntime` — plain STRING key survives Vite HMR
  // multi-instance loads where `instanceof` fails across copies.
  static ["arrival/is-environment"] = true;

  protected constructor(
    // `string | symbol`: merge-frame identity is `Symbol.for("merge")`
    // (Syntax.__merge_env__); LexicalScope.kind compares by symbol identity —
    // string coercion would break hygiene. Display sites wrap with `String(...)`.
    public __name__: string | symbol = "anonymous",
    public __env__: Record<string | symbol, AmbientValue> = {},
    public __parent__: AmbientRuntime | null = null,
  ) {}

  /** Capture the protected constructor for the raw minter; public type has no birth arm. */
  static {
    mintPlainFrame = (name, bindings, parent) => new AmbientRuntime(name, bindings, parent);
  }

  list(): (string | symbol)[] {
    return ownProps(this.__env__);
  }

  /**
   * Every name bound up the `__parent__` chain, de-duplicated (shadowed names once).
   * Unsorted — caller orders/filters.
   */
  allBoundNames(): (string | symbol)[] {
    const names = new Set<string | symbol>();
    for (let env: AmbientRuntime | null = this; env; env = env.__parent__) {
      for (const name of env.list()) names.add(name);
    }
    return [...names];
  }

  /**
   * One layer before parent. Own bindings win (closer module shadows). Resolver leg
   * lives only on {@link ResolvingAmbient}; plain frame is own → parent.
   */
  _lookupWithResolvers(name: string | symbol, ctx?: RunContext): AmbientValue | undefined {
    if (Object.hasOwn(this.__env__, name as string)) {
      return this.__env__[name as string];
    }

    return this.__parent__?._lookupWithResolvers(name, ctx);
  }

  toString(): string {
    return `#<environment:${String(this.__name__)}>`;
  }

  /**
   * Read face — INVARIANT DOOR (docs/environments.md §HERMETIC): storage is inside the
   * membrane; writers box before {@link bindValue}. A raw JS scalar on read means a writer
   * bypassed the membrane — teach and refuse, never silently re-box.
   *
   * APair: cycle-mark + quote so host/hygiene reads get DATA the evaluator won't
   * re-evaluate (read-settling, not membrane coercion).
   */
  get(symbol: BindingName, options: { throwError?: boolean; ctx?: RunContext } = {}): AmbientValue | undefined {
    // `:`-prefixed symbols are not bindings; they fall through to the polyglot
    // keyword-accessor resolver (same catchall path as `c[ad]+r`).
    const { throwError = true, ctx } = options;

    let name: string | symbol = symbol as string | symbol;
    if (symbol instanceof ASymbol || symbol instanceof AString) {
      name = symbol.valueOf();
    }

    const directValue = this._lookupWithResolvers(name, ctx);
    if (directValue !== undefined) {
      if (directValue instanceof APair) {
        directValue.mark_cycles();
        return quote(directValue);
      }
      assertNotRawInStorage(directValue, name, `environment ${String(this.__name__)}`);
      return directValue;
    }

    if (throwError) {
      // Unbound wall + typo suggestions from THIS chain only. Well-known-but-absent
      // names are capability doors (`symbol.notImplemented`), resolved like any binding.
      throw unboundVariableError(name.toString(), this.allBoundNames());
    }
    return undefined;
  }

  has(name: string): boolean {
    return Object.hasOwn(this.__env__, name);
  }
}

/** JS leaf types that must never surface from inside the membrane. */
function isRawJsScalar(value: unknown): value is string | number | bigint | boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "bigint" || t === "boolean";
}

/**
 * Storage membrane door: raw JS scalar on read ⇒ writer bypass. Fires on READ so the
 * message names the binding; fix is always at the writer (docs/environments.md §HERMETIC).
 */
function assertNotRawInStorage(value: unknown, name: string | symbol, where: string): void {
  if (isRawJsScalar(value)) throw new RawCrossingError("storage", String(name), typeof value, where);
}

/**
 * Resolver-boundary door: a {@link ResolverSpec} must hand back a BOXED scheme value
 * (or membrane primitive), never a raw JS scalar. Shared by the live walk
 * ({@link ResolvingAmbient}) and the sealed chain (eval/CompiledResolutionChain.ts).
 */
export function assertResolvedBinding(value: unknown, name: string | symbol, resolverId: string): void {
  if (isRawJsScalar(value)) throw new RawCrossingError("resolver", String(name), typeof value, resolverId);
}

/**
 * THE ONE storage write — module-internal, NOT barrel-exported, NOT a method
 * (docs/environments.md §HERMETIC: no JS-side write surface). Legitimate writers, all
 * inside the membrane:
 *
 *   • evaluator frame binds (`define`/let/lambda/letrec/catch)
 *   • capability assembly (symbol bind + define-bake Pass 2)
 *   • {@link bindRosetta} (replay playback frame)
 *
 * CARVE-OUTS:
 *   • `Error` — catch-frame bind of a raised condition (R7RSError extends host `Error`,
 *     not AValue; `isSchemeValue` misses it)
 *   • `fromJS` tail — bake-time boxing for `{ value }` defs / require leaves (assembly
 *     is pre-run; run-neutral mint is correct)
 *
 * Bare host functions are DOORED. Env-resident callables are ACallable values.
 * `bindRosetta` mints ARosettaProcedure before this door.
 */
export function bindValue(env: AmbientRuntime, name: BindingName, value: AmbientValue): void {
  let storedValue: AmbientValue;

  if (typeof value === "function") {
    throw new TypeError(
      `bindValue: bare host function refused for "${String(name instanceof ASymbol ? name.__name__ : name instanceof AString ? name.valueOf() : name)}" — mint an ANativeProcedure / ARosettaProcedure (createRosettaWrapper / hostFnToCallable) instead`,
    );
  }

  if (isSchemeValue(value)) {
    storedValue = value;
  } else if (value instanceof Error) {
    storedValue = value; // Error carve-out — see preamble
  } else {
    storedValue = fromJS(value) as AmbientValue;
  }

  let key: string | symbol;
  if (name instanceof ASymbol) {
    key = name.__name__;
  } else if (name instanceof AString) {
    key = name.valueOf();
  } else {
    key = name;
  }
  env.__env__[key as string] = storedValue;
}

/**
 * BAKED-ROOT specialization — the only place fallback resolvers live
 * (docs/environments.md §PRELUDE). Production producers: kernel prelude-scope resolver
 * and pack-declared `EnvCapability.resolvers`. Apply targets stay `ResolvingAmbient`
 * (`mintFrame` preserves parent class, so a capability-augmented base stays resolver-capable).
 *
 * Plain lexical frames are deliberately NOT `ResolvingAmbient` — only the baked capability
 * base is ambient middleware. A glass caller that wants a resolver layer builds that layer
 * as `ResolvingAmbient` explicitly; otherwise a miss falls through to parent.
 */
export class ResolvingAmbient extends AmbientRuntime implements SchemeEnv {
  private readonly __resolvers__: ResolverSpec[] = [];

  static {
    mintResolvingFrame = (name, bindings, parent) => new ResolvingAmbient(name, bindings, parent);
  }

  /** Register a fallback resolver; tried in order when normal lookup fails. */
  registerResolver(resolver: ResolverSpec): this {
    // Fail loud — silent push surfaces later as "cannot read 'resolve'" at lookup.
    invariant(
      resolver != null && typeof resolver.resolve === "function" && typeof resolver.id === "string",
      "registerResolver: resolver must have a string id and a resolve() function",
    );
    if (!this.__resolvers__.some((r) => r.id === resolver.id)) {
      this.__resolvers__.push(resolver);
    }
    return this;
  }

  /** Unregister by id — seal hook: bake-scoped `preludeOnly` overlay unregisters so no
   *  spent machinery survives assembly. No-op for unknown id. */
  unregisterResolver(id: string): this {
    const at = this.__resolvers__.findIndex((r) => r.id === id);
    if (at !== -1) this.__resolvers__.splice(at, 1);
    return this;
  }

  /** Seal-time read for the chain compiler: specs in registration (= C3 apply) order.
   *  Live view — compiler snapshots; callers must not mutate. */
  resolverSpecs(): readonly ResolverSpec[] {
    return this.__resolvers__;
  }

  /**
   * Direct bindings → resolvers → parent. Explicit binding wins over own lazy resolver
   * (pinned override not undone by same-layer catch-all); both win over parent.
   * Resolver returns `undefined` = "not mine" — never a found nil.
   */
  override _lookupWithResolvers(name: string | symbol, ctx?: RunContext): AmbientValue | undefined {
    if (Object.hasOwn(this.__env__, name as string)) {
      return this.__env__[name as string];
    }

    for (const resolver of this.__resolvers__) {
      const result = resolver.resolve(String(name), ctx);
      if (result !== undefined) {
        assertResolvedBinding(result, name, resolver.id);
        return result as AmbientValue;
      }
    }

    return this.__parent__?._lookupWithResolvers(name, ctx);
  }
}

/**
 * THE ONE frame-birth door — module-internal, NOT barrel-exported, NOT a method
 * (docs/environments.md §HERMETIC: public `inherit()`/`merge()` would be capability
 * composition in disguise). Subtype-preserving: ResolvingAmbient parent → resolver-capable
 * child; plain parent → plain lexical frame.
 *
 * Live callers (all inside the membrane): root layering (env-roots / inference-env);
 * assembly (`generator-exec` exec-capabilities base); evaluator frame chain
 * (`Resolver.child` / merge frame / `LexicalScope.child` — including provenance replay
 * frames via `LexicalScope.child`).
 */
export function mintFrame(
  parent: ResolvingAmbient,
  name?: string | symbol,
  bindings?: Record<string, AmbientValue>,
): ResolvingAmbient;
export function mintFrame(
  parent: AmbientRuntime,
  name?: string | symbol,
  bindings?: Record<string, AmbientValue>,
): AmbientRuntime;
export function mintFrame(
  parent: AmbientRuntime,
  name: string | symbol = `child of ${String(parent.__name__) || "unknown"}`,
  bindings: Record<string, AmbientValue> = {},
): AmbientRuntime {
  return parent instanceof ResolvingAmbient
    ? mintResolvingFrame(name, bindings, parent)
    : mintPlainFrame(name, bindings, parent);
}

/**
 * Mint ARosettaProcedure and store it — sole producer is `replay.ts` playback-frame op
 * registration. Module-internal; not part of `SchemeEnv`. No bare-fn env resident.
 */
export function bindRosetta(env: AmbientRuntime, name: string, config: RosettaFunction): void {
  bindValue(env, name, createRosettaWrapper(config));
}

/**
 * Brand check replacing `instanceof AmbientRuntime`. Vite HMR multi-instance loads make
 * `instanceof` fail across copies; the string brand on the constructor is universal.
 * Inherited by `ResolvingAmbient` via static inheritance.
 */
export function isAmbientRuntime(value: unknown): value is AmbientRuntime {
  if (typeof value !== "object" || value === null) return false;
  const ctor: unknown = Reflect.get(value, "constructor");
  return typeof ctor === "function" && Reflect.get(ctor, "arrival/is-environment") === true;
}
