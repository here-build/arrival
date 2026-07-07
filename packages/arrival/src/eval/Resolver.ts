/**
 * Resolver — the evaluator's name-resolution + scope-construction facade.
 *
 * EJECTION P3, phase 3b.3: the Resolver holds a {@link LexicalScope} and a
 * {@link Capabilities} base as TWO separate fields, and resolution COMPOSES them
 * (`scope.lookup(name) ?? capabilities.lookup(name)`, with the keyword/cxr/dotted
 * synth wrapping that same composed lookup). Two modes, one code path:
 *
 *   GLASS (custom-env + bare-ctx fallback): no explicit base, so `capabilities`
 *     wraps the SAME base-linked env the scope wraps. The scope walk already reaches
 *     the base, so the `?? capabilities` half never fires on a hit and the composition
 *     collapses to `env_get(env, sym)` — byte-identical to 3b.2.
 *   CUT (the default exec path): an explicit assembled base + a null-rooted lexical
 *     root, so the scope resolves program names and the base resolves builtins —
 *     genuinely decoupled. The base propagates verbatim through {@link Resolver.child}.
 *
 * The facade gives the evaluator ONE object to thread, so the seam wiring (glass vs
 * cut) lives only at the exec entry — not at every evaluator site.
 *
 * IMMUTABILITY: arrival is a pure-dataflow interpreter — `set!` is doored
 * (PurityError). There is deliberately NO `assign`/`ref`/`set!` method here;
 * `define` is a frame rebind (let/lambda/letrec/define), not value mutation.
 */
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AValue } from "../values/primitives/AValue.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { type BindingName, Environment, type EnvironmentValue } from "../Environment.js";
import { resolveMemberPath } from "../member-walk.js";
import type { SchemeValue } from "../values/types.js";
import { LexicalScope } from "./LexicalScope.js";
import { Capabilities } from "./Capabilities.js";
import { unboundVariableError } from "../env/polyglot-rich-errors/registry.js";
import { ImplInvocationCtx } from "../common/symbols/_bake.js";
import { tf } from "../values/tagless-final.js";

// ============================================================================
// Environment lookup without lips runtime dependency
// ============================================================================
//
// c[ad]+r is car/cdr COMPOSITION — the kernel unfolds it by composing each receiver's OWN
// tagless-final car/cdr algebra (innermost letter first), threading the run ctx. car/cdr are
// the 1-step base case; cadr…caddddr are the deeper compositions. No "aside" resolver, no
// field-access/typecheck duplication — composites inherit the atoms' nil-tolerance (ANil reads
// runCtx.strict), provenance (APair re-stamps), and the totalic "primitive does not support
// car" throw for free.
const CXR_RE = /^c[ad]+r$/;
function cxrUnfold(name: string): SchemeValue | undefined {
  if (!CXR_RE.test(name)) return undefined;
  const steps = [...name.slice(1, -1)].reverse(); // innermost (rightmost) letter applied first
  return function (this: ImplInvocationCtx, arg: unknown): unknown {
    // `this?.` (not just `this.ctx?.`): a native HOF (`map`/`vector-map`) invokes this
    // synthesized accessor as a plain callback with `this === undefined`, so reading
    // `this.ctx` would throw before the `?.` on `.ctx` could guard it.
    const runCtx = this?.ctx?.runCtx ?? CONSTANT_CTX;
    let v: unknown = arg;
    for (const t of steps) {
      const m = v?.[tf(t === "a" ? "car" : "cdr")];
      TypeError.invariant(
        typeof m === "function",
        () =>
          `${name}: the ${v instanceof AValue ? v.kind : v == null ? String(v) : typeof v} primitive does not support ${t === "a" ? "car" : "cdr"} (no ${t === "a" ? "arrival/tagless-final/car" : "arrival/tagless-final/cdr"}).`,
      );
      v = (m as (...a: unknown[]) => unknown).call(v, runCtx);
    }
    return v;
  } satisfies SchemeValue;
}

/**
 * The synth tail shared by the glass {@link env_get} and the composed
 * {@link Resolver.resolve}: after a DIRECT binding miss, synthesize. First c[ad]+r
 * composition (no env binding, no resolver — the family IS car/cdr composition over
 * the unified tagless-final algebra). Then dot-notation — `foo.bar.baz` source sugar,
 * or syntax-rules gensyms carrying their property path on `ASymbol.object` — resolving
 * the base NAME through the SAME `lookup` (load-bearing under the cut: a dotted/cxr base
 * that is a let-bound lexical name must still resolve), then walking members through the
 * membrane. Else throw Unbound. `lookup` is the raw bindings probe: a single-env
 * `_lookupWithResolvers` for the glass standalone, `scope.lookup ?? capabilities.lookup`
 * for the Resolver. Environment.get no longer does the member walk (ejection P1: get is
 * pure name-resolution); name-resolution lives here, member-access in member-walk.ts.
 */
function resolveSynth(
  sym: ASymbol,
  name: string | symbol,
  lookup: (n: string | symbol) => EnvironmentValue | undefined,
): EnvironmentValue | undefined {
  if (typeof name === "string") {
    const cxr = cxrUnfold(name);
    if (cxr !== undefined) return cxr;
  }

  const objectParts = (sym as unknown as { [key: symbol]: string[] | undefined })[ASymbol.object];
  const parts: string[] | undefined =
    objectParts ?? (typeof name === "string" && name.includes(".") ? name.split(".").filter(Boolean) : undefined);
  if (parts && parts.length > 1) {
    const [first, ...rest] = parts;
    const base = lookup(first);
    if (base !== undefined) return resolveMemberPath(base, rest);
  }
  throw unboundVariableError(String(name));
}

/**
 * Look up a symbol in the environment without requiring lips runtime.
 * This uses _lookupWithResolvers directly to avoid patch_value.
 * For keyword symbols (:name), self-evaluates — see keyword-tagless-apply.md.
 * The single-env glass form; {@link Resolver.resolve} is the composed (cut) form.
 */
export function env_get(env: Environment, sym: ASymbol): EnvironmentValue | undefined {
  const name = sym.__name__;

  // A keyword (`:name`) is self-evaluating — it carries its own `apply` (ASymbol.ts),
  // so it needs no environment lookup or synthesized accessor at all. Never bindable
  // (this branch always wins over any binding attempt), formalizing what was already
  // true de facto.
  if (typeof name === "string" && name.startsWith(":")) {
    return sym;
  }

  const value = env._lookupWithResolvers(name);
  if (value !== undefined) {
    return value;
  }

  return resolveSynth(sym, name, (n) => env._lookupWithResolvers(n));
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
  /** The lexical-binding chain (let/lambda/letrec/… frames). */
  readonly scope: LexicalScope;
  /** The capability base (builtins/preludes/polyglot resolvers) the scope falls through to. */
  readonly capabilities: Capabilities;

  /**
   * Hold the lexical scope and the capability base SEPARATELY. WITH an explicit
   * `capabilities` (the cut) → `scope` wraps the given (post-cut: null-rooted) lexical
   * env, `capabilities` is the assembled base, propagated unchanged to every child.
   * WITHOUT (glass) → `capabilities = new Capabilities(scopeEnv)`, the SAME base-linked
   * env the scope wraps, so the composed `scope.lookup ?? capabilities.lookup` collapses
   * to one `scopeEnv._lookupWithResolvers` walk (byte-identical to 3b.2 — the scope walk
   * already reaches the base, so the `??` half never fires on a hit). `scope` is memoized
   * per env ({@link LexicalScope.for}) so hygiene's `refFrame(name) === defResolver.scope`
   * identity compare holds.
   */
  constructor(
    scopeEnv: Environment,
    capabilities?: Capabilities,
    readonly kind?: ScopeKind,
  ) {
    this.scope = LexicalScope.for(scopeEnv);
    this.capabilities = capabilities ?? new Capabilities(scopeEnv);
  }

  /** The lexical frame env — the ride-along consumers' `resolver.env` expectation (removed at P5). */
  get env(): Environment {
    return this.scope.env;
  }

  /**
   * Full name resolution — the throwing, synth-aware lookup (`:key` accessors,
   * c[ad]+r composition, dotted member walk) over the COMPOSED `scope.lookup ??
   * capabilities.lookup`. Glass: `scope.env === capabilities.env`, so this is
   * byte-identical to `env_get(env, sym)`. Cut: the lexical chain wins for program
   * names, the base for builtins; the keyword/cxr/dotted synth wraps the SAME
   * composed lookup, so a `:key` accessor or a dotted base resolves against the base
   * even though the lexical root is null-rooted.
   */
  resolve(sym: ASymbol): EnvironmentValue | undefined {
    const name = sym.__name__;
    // A keyword (`:name`) is self-evaluating — see keyword-tagless-apply.md. No lexical
    // or capability lookup at all; this is the one call site every symbol-position
    // evaluation funnels through (plain-symbol AND call-head fast path both call
    // `resolve()`), so this single branch covers both.
    if (typeof name === "string" && name.startsWith(":")) {
      return sym;
    }
    const lookup = (n: string | symbol): EnvironmentValue | undefined =>
      this.scope.lookup(n) ?? this.capabilities.lookup(n);
    const value = lookup(name);
    if (value !== undefined) return value;
    return resolveSynth(sym, name, lookup);
  }

  /**
   * The raw direct-bindings → resolvers → parent walk; `undefined` on miss, no
   * synth. Used by the keyword/special-form dispatch, which must distinguish a
   * miss (fall through to string-keyed SPECIAL_FORMS) from a found value. The
   * composed `scope.lookup ?? capabilities.lookup`; glass collapses to
   * `env._lookupWithResolvers(name)`.
   */
  lookup(name: string | symbol): EnvironmentValue | undefined {
    return this.scope.lookup(name) ?? this.capabilities.lookup(name);
  }

  /**
   * The frame that OWNS `name` for hygiene IDENTITY — walk the lexical scope frames,
   * then the capability base. Returns a stable {@link LexicalScope} for a lexical owner
   * (so `=== defResolver.scope` compares the captured def frame) or the base
   * {@link Capabilities.globalRoot} env for an unshadowed builtin (so `=== globalRoot`),
   * `undefined` if unbound. Own bindings only — no resolvers, no synth — exactly like the
   * old `Environment.ref` walk it replaces. NOT a value read and NOT a mutation path.
   */
  refFrame(name: string): LexicalScope | Environment | undefined {
    return this.scope.refFrame(name) ?? this.capabilities.refFrame(name);
  }

  /**
   * A SETTLED value read — the bound value of `name` (scope then capabilities),
   * patch_value-settled, resolver-aware, NON-synth, `undefined` on a miss (never throws).
   * ≡ `env.get(name, { throwError: false })`. Used by hygiene's gensym rename to copy a
   * bound value onto its gensym; distinct from {@link resolve} (which synthesizes c[ad]+r
   * and throws on a miss), so a template-introduced (unbound) identifier yields undefined.
   */
  lookupSettled(name: BindingName): EnvironmentValue | undefined {
    return this.env.get(name, { throwError: false });
  }

  /** Bind a name in the innermost frame (let/lambda/letrec/define). ≡ `env.set`. */
  define(name: BindingName, value: EnvironmentValue | number | bigint): void {
    this.env.set(name, value);
  }

  /**
   * A fresh nested lexical frame carrying the SAME capability base. ★The linchpin:
   * children no longer re-derive the base from their (post-cut: null-rooted) env —
   * `this.capabilities` propagates verbatim, so the macro/hygiene seam keeps a stable
   * `globalRoot` across expansion frames. ≡ `new Resolver(env.inherit(name), caps, kind)`.
   */
  child(name?: string | symbol, kind?: ScopeKind): Resolver {
    return new Resolver(this.env.inherit(name), this.capabilities, kind);
  }

  /** Whether `name` is bound in THIS frame (not the chain). ≡ `env.has`. */
  has(name: string): boolean {
    return this.env.has(name);
  }

  toString(): string {
    return `#<resolver:${String(this.env.__name__)}>`;
  }
}
