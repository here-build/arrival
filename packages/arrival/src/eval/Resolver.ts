/**
 * Resolver — the evaluator's name-resolution + scope-construction facade.
 *
 * EJECTION P3, phase 3a: this is a thin wrapper over the existing base-linked
 * {@link Environment} chain, so behavior is byte-identical to threading a raw
 * `Environment`. The mapping is exact:
 *
 *   resolve(sym) ≡ env_get(env, sym)            (the throwing, synth-aware lookup)
 *   lookup(name) ≡ env._lookupWithResolvers     (the raw, undefined-on-miss walk)
 *   define(n, v) ≡ env.set(n, v)                (innermost-frame rebind)
 *   child(name)  ≡ new Resolver(env.inherit())  (a fresh nested frame)
 *
 * The point of the facade is NOT to change resolution (3a changes nothing — the
 * gate stays green throughout) but to give the evaluator ONE object to thread
 * instead of a raw env, so 3b can swap the *implementation* (cut the lexical
 * chain from the capability base, rewrite hygiene) without re-touching every
 * evaluator site. The {@link LexicalScope}/{@link Capabilities} accessors name
 * the eventual 3b split; in 3a both wrap the same base-linked `env`.
 *
 * IMMUTABILITY: arrival is a pure-dataflow interpreter — `set!` is doored
 * (PurityError). There is deliberately NO `assign`/`ref`/`set!` method here;
 * `define` is a frame rebind (let/lambda/letrec/define), not value mutation.
 */
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import type { RunContext } from "../values/primitives/RunContext.js";
import { AValue } from "../values/primitives/AValue.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { Environment, type BindingName, type EnvironmentValue } from "../Environment.js";
import { resolveMemberPath } from "../member-walk.js";
import type { SchemeValue } from "../values/types.js";
import { LexicalScope } from "./LexicalScope.js";
import { Capabilities } from "./Capabilities.js";

// ============================================================================
// Environment lookup without lips runtime dependency
// ============================================================================
//
// c[ad]+r is car/cdr COMPOSITION — the kernel unfolds it by composing each receiver's OWN
// tagless-final car/cdr algebra (innermost letter first), threading the run ctx. car/cdr are
// the 1-step base case; cadr…caddddr are the deeper compositions. No "aside" resolver, no
// field-access/typecheck duplication — composites inherit the atoms' nil-tolerance (ANil reads
// runCtx.strict), provenance (APair re-stamps), and the totalic "primitive does not support
// car" throw for free. __withCtx so the apply boundary hands it the run ctx.
const CXR_RE = /^c[ad]+r$/;
function cxrUnfold(name: string): SchemeValue | undefined {
  if (!CXR_RE.test(name)) return undefined;
  const steps = [...name.slice(1, -1)].reverse(); // innermost (rightmost) letter applied first
  const fn = (arg: unknown, ctx?: unknown): unknown => {
    const runCtx = (ctx as { runCtx?: RunContext } | undefined)?.runCtx ?? CONSTANT_CTX;
    let v: unknown = arg;
    for (const t of steps) {
      const method = t === "a" ? "arrival/tagless-final/car" : "arrival/tagless-final/cdr";
      const m = (v as Record<string, unknown> | null | undefined)?.[method];
      if (typeof m !== "function") {
        const kind = v instanceof AValue ? v.kind : v == null ? String(v) : typeof v;
        throw new TypeError(`${name}: the ${kind} primitive does not support ${t === "a" ? "car" : "cdr"} (no ${method}).`);
      }
      v = (m as (...a: unknown[]) => unknown).call(v, runCtx);
    }
    return v;
  };
  (fn as { __withCtx?: boolean }).__withCtx = true;
  return fn as SchemeValue;
}

/**
 * Look up a symbol in the environment without requiring lips runtime.
 * This uses _lookupWithResolvers directly to avoid patch_value.
 * For keyword symbols (:name), delegates to env.get() which creates accessor functions.
 */
export function env_get(env: Environment, sym: ASymbol): SchemeValue {
  const name = sym.__name__;

  // Handle keyword symbols (e.g., :name, :projects) — delegate to env.get()
  // which creates Clojure-style property accessor functions
  if (typeof name === "string" && name.startsWith(":")) {
    return env.get(sym);
  }

  const value = env._lookupWithResolvers(name);
  if (value !== undefined) {
    return value;
  }

  // c[ad]+r — synthesized by the kernel on a binding miss (car/cdr + every composite). No env
  // binding, no resolver: the family IS car/cdr composition over the unified tagless-final algebra.
  if (typeof name === "string") {
    const cxr = cxrUnfold(name);
    if (cxr !== undefined) return cxr;
  }

  // Direct lookup missed. Dot-notation — `foo.bar.baz` source sugar, or syntax-rules gensyms
  // carrying their property path on `ASymbol.object` — resolve the base NAME in scope, then walk
  // members through the membrane. Environment.get no longer does this (ejection P1: get is pure
  // name-resolution); name-resolution lives here, member-access in member-walk.ts.
  const objectParts = (sym as unknown as { [key: symbol]: string[] | undefined })[ASymbol.object];
  const parts: string[] | undefined =
    objectParts ?? (typeof name === "string" && name.includes(".") ? name.split(".").filter(Boolean) : undefined);
  if (parts && parts.length > 1) {
    const [first, ...rest] = parts;
    const base = env._lookupWithResolvers(first);
    if (base !== undefined) return resolveMemberPath(base, rest);
  }
  throw Object.assign(new Error(`Unbound variable \`${String(name)}'`), {
    publicMessage: `symbol ${String(name)} does not exist - look at list of available functions at tool description`,
  });
}

/**
 * The semantic role of a nested frame. In 3a this is metadata only (every frame
 * is an `env.inherit`, identically); 3b reads it to decide which frames belong to
 * the lexical chain vs the capability base. Mirrors the existing debug-name passed
 * to `Environment.inherit`.
 */
export type ScopeKind =
  | "lambda"
  | "macro"
  | "syntax"
  | "let"
  | "let*"
  | "letrec"
  | "named-let"
  | "do"
  | "catch"
  | "user";

export class Resolver {
  /**
   * In 3a the wrapped env IS both the lexical chain and the capability base (one
   * `__parent__`-linked chain). 3b splits them; until then `env` is the single
   * source of truth and `scope`/`capabilities` are glass over it.
   */
  constructor(
    readonly env: Environment,
    readonly kind?: ScopeKind,
  ) {}

  /** The lexical-binding view (3b target). Lazy — the hot path never reads it. */
  get scope(): LexicalScope {
    return new LexicalScope(this.env);
  }

  /** The capability-base view (3b target). Lazy — the hot path never reads it. */
  get capabilities(): Capabilities {
    return new Capabilities(this.env);
  }

  /**
   * Full name resolution — the throwing, synth-aware lookup (`:key` accessors,
   * c[ad]+r composition, dotted member walk). Byte-identical to `env_get(env, sym)`.
   */
  resolve(sym: ASymbol): SchemeValue {
    return env_get(this.env, sym);
  }

  /**
   * The raw direct-bindings → resolvers → parent walk; `undefined` on miss, no
   * synth. Used by the keyword/special-form dispatch, which must distinguish a
   * miss (fall through to string-keyed SPECIAL_FORMS) from a found value.
   * Byte-identical to `env._lookupWithResolvers(name)`.
   */
  lookup(name: string | symbol): EnvironmentValue | undefined {
    return this.env._lookupWithResolvers(name);
  }

  /** Bind a name in the innermost frame (let/lambda/letrec/define). ≡ `env.set`. */
  define(name: BindingName, value: EnvironmentValue | number | bigint): void {
    this.env.set(name, value);
  }

  /** A fresh nested frame. ≡ `new Resolver(env.inherit(name))`. */
  child(name?: string, kind?: ScopeKind): Resolver {
    return new Resolver(this.env.inherit(name), kind);
  }

  /** Whether `name` is bound in THIS frame (not the chain). ≡ `env.has`. */
  has(name: string): boolean {
    return this.env.has(name);
  }

  toString(): string {
    return `#<resolver:${this.env.__name__}>`;
  }
}
