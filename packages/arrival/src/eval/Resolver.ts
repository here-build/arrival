/**
 * Resolver — the evaluator's name-resolution + scope-construction facade.
 *
 * Holds a {@link LexicalScope} and a {@link Capabilities} base as TWO separate
 * fields; resolution COMPOSES them (`scope.lookup(name) ?? capabilities.lookup(name)`,
 * with the keyword/cxr synth wrapping that same composed lookup). Two modes,
 * one code path:
 *
 *   GLASS (custom-env + bare-ctx fallback): no explicit base, so `capabilities`
 *     wraps the SAME base-linked env the scope wraps. The scope walk already reaches
 *     the base, so the `?? capabilities` half never fires on a hit and the composition
 *     collapses to `env_get(env, sym)`.
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
import { AValue } from "../values/primitives/AValue.js";
import { ANativeProcedure } from "../values/primitives/ACallable.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { type BindingName, AmbientRuntime, type AmbientValue, mintFrame } from "../AmbientRuntime.js";
import type { RunContext } from "../values/primitives/RunContext.js";
import type { SchemeValue } from "../values/types.js";
import { LexicalScope } from "./LexicalScope.js";
import { Capabilities } from "./Capabilities.js";
import type { CompiledResolutionChain } from "./CompiledResolutionChain.js";
import { unboundVariableError } from "../unbound-variable.js";
import { attachOffendingValue } from "../errors.js";
import { tf } from "../values/tagless-final.js";

// ============================================================================
// AmbientRuntime lookup without lips runtime dependency
// ============================================================================
//
// c[ad]+r is car/cdr COMPOSITION — the kernel unfolds it by composing each receiver's OWN
// tagless-final car/cdr algebra (innermost letter first), threading the run ctx. car/cdr are
// the 1-step base case; cadr…caddddr are the deeper compositions. No "aside" resolver, no
// field-access/typecheck duplication — composites inherit the atoms' nil-tolerance (ANil reads
// runCtx.strict), provenance (APair re-stamps), and the totalic "primitive does not support
// car" throw for free.
const CXR_RE = /^c[ad]+r$/;
/** Memoized per name so `(eq? cadr cadr)` holds across two resolution misses — reference
 *  identity IS the equality contract for callables (ACallable's `arrival/tagless-final/equals`),
 *  and `withProvenance` on a callable is an identity-preserving no-op. */
const cxrCache = new Map<string, ANativeProcedure>();
function cxrUnfold(name: string): ANativeProcedure | undefined {
  if (!CXR_RE.test(name)) return undefined;
  const cached = cxrCache.get(name);
  if (cached !== undefined) return cached;
  const steps = [...name.slice(1, -1)].reverse(); // innermost (rightmost) letter applied first
  // The synthesized accessor is an ANativeProcedure, never a bare fn returned into
  // value space. Every
  // invocation route (evaluator call-head, `call_function`'s callable-value branch, HOFs
  // via `applyCallback`) dispatches the apply term with an EXPLICIT runCtx — the old
  // `this?.runCtx ?? CONSTANT_CTX` apology (a HOF calling with `this === undefined`
  // silently degraded strict mode) is structurally impossible now.
  const proc = new ANativeProcedure({
    name,
    arity: { min: 1, max: 1 },
    contract: undefined,
    impl: ([arg], runCtx) => {
      let v: unknown = arg;
      for (const t of steps) {
        const m = (v as Partial<Record<symbol, unknown>> | null | undefined)?.[tf(t === "a" ? "car" : "cdr")];
        // MODEL-REACHABLE door — (cadr 5) is one keystroke away, so per Rule 0 this
        // throws plain: an `invariant` here would prefix "Invariant failed: ", which
        // reads like an engine bug rather than a program mistake (see the not-callable
        // doors note in evaluator.ts).
        if (typeof m !== "function") {
          throw attachOffendingValue(
            new TypeError(
              `${name}: the ${v instanceof AValue ? v.kind : v == null ? String(v) : typeof v} primitive does not support ${t === "a" ? "car" : "cdr"} (no ${t === "a" ? "arrival/tagless-final/car" : "arrival/tagless-final/cdr"}).`,
            ),
            v,
          );
        }
        v = (m as (...a: unknown[]) => unknown).call(v, runCtx);
      }
      // The walk's result is the receivers' own car/cdr algebra output — scheme values by
      // construction; typed `unknown` by the spine-walk convention, narrowed once at this
      // boundary (same convention as applyCallback's arg cast).
      return v as SchemeValue;
    },
  });
  cxrCache.set(name, proc);
  return proc;
}

/**
 * The synth tail shared by the glass {@link env_get} and the composed
 * {@link Resolver.resolve}: after a DIRECT binding miss, synthesize c[ad]+r
 * composition (no env binding, no resolver — the family IS car/cdr composition over
 * the unified tagless-final algebra). Else throw Unbound.
 *
 * Dotted-path resolution (`foo.bar.baz` sugar → member-walk) is deliberately not
 * supported: it would be a side-door bypassing BOTH the membrane face and the
 * provenance field-step classification. `@`/`:key` are THE member-access surface.
 * A dotted identifier resolves as an ordinary (unbound) symbol — the normal
 * unbound-variable door.
 */
function resolveSynth(
  name: string | symbol,
  vocabulary: () => Iterable<string | symbol>,
): AmbientValue | undefined {
  if (typeof name === "string") {
    const cxr = cxrUnfold(name);
    if (cxr !== undefined) return cxr;
  }
  // The PLAIN unbound wall + typo suggestions from the caller's ACTUAL vocabulary (a
  // thunk — enumerated only on the throwing path, never for a cxr hit). No curated
  // name tables here: well-known-but-absent names are declared `symbol.notImplemented`
  // doors that the ordinary lookup above already found (see unbound-variable.ts).
  throw unboundVariableError(String(name), vocabulary());
}

/**
 * Look up a symbol in the environment — the raw storage walk, no read-settling
 * (a stored pair is handed back as-is; `AmbientRuntime.get` owns the quote-on-read face).
 * For keyword symbols (:name), self-evaluates.
 * The single-env glass form; {@link Resolver.resolve} is the composed (cut) form.
 */
export function env_get(env: AmbientRuntime, sym: ASymbol, ctx?: RunContext): AmbientValue | undefined {
  const name = sym.__name__;

  // A keyword (`:name`) is self-evaluating — it carries its own `apply` (ASymbol.ts),
  // so it needs no environment lookup or synthesized accessor at all. Never bindable
  // (this branch always wins over any binding attempt), formalizing what was already
  // true de facto.
  if (typeof name === "string" && name.startsWith(":")) {
    return sym;
  }

  const value = env._lookupWithResolvers(name, ctx);
  if (value !== undefined) {
    return value;
  }

  return resolveSynth(name, () => env.allBoundNames());
}

/**
 * The semantic role of a nested frame. Currently metadata only (every frame is a
 * `mintFrame` child identically) — future work reads it to distinguish the lexical
 * chain from the capability base. Mirrors the debug-name passed to the frame mint.
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
   * `capabilities` (the cut) → `scope` wraps the given null-rooted lexical env,
   * `capabilities` is the assembled base, propagated unchanged to every child.
   * WITHOUT (glass) → `capabilities = new Capabilities(scopeEnv)`, the SAME base-linked
   * env the scope wraps, so the composed `scope.lookup ?? capabilities.lookup` collapses
   * to one `scopeEnv._lookupWithResolvers` walk (the scope walk already reaches the base,
   * so the `??` half never fires on a hit). `scope` is memoized per env
   * ({@link LexicalScope.for}) so hygiene's `refFrame(name) === defResolver.scope`
   * identity compare holds.
   */
  constructor(
    scopeEnv: AmbientRuntime,
    capabilities?: Capabilities,
    readonly kind?: ScopeKind,
  ) {
    this.scope = LexicalScope.for(scopeEnv);
    this.capabilities = capabilities ?? new Capabilities(scopeEnv);
  }

  /** The lexical frame env — kept for consumers that still expect `resolver.env`. */
  get env(): AmbientRuntime {
    return this.scope.env;
  }

  /**
   * Full name resolution — the throwing, synth-aware lookup (`:key` accessors,
   * c[ad]+r composition) over the COMPOSED `scope.lookup ?? capabilities.lookup`.
   * Glass: `scope.env === capabilities.env`, so this is byte-identical to
   * `env_get(env, sym)`. Cut: the lexical chain wins for program names, the base for
   * builtins; the keyword/cxr synth wraps the SAME composed lookup, so a `:key`
   * accessor resolves against the base even though the lexical root is null-rooted.
   */
  resolve(sym: ASymbol, ctx?: RunContext): AmbientValue | undefined {
    const name = sym.__name__;
    // A keyword (`:name`) is self-evaluating. No lexical
    // or capability lookup at all; this is the one call site every symbol-position
    // evaluation funnels through (plain-symbol AND call-head fast path both call
    // `resolve()`), so this single branch covers both.
    if (typeof name === "string" && name.startsWith(":")) {
      return sym;
    }
    const value = this.lookup(name, ctx);
    if (value !== undefined) return value;
    return resolveSynth(name, () => this.allBoundNames());
  }

  /**
   * Every name this resolver's composed walk could have found — the lexical chain's
   * bindings plus the capability base's enumerable vocabulary (assembled: the sealed
   * chain's merged static names; resolver-synthesized names are absent by design),
   * de-duplicated. The typo-suggestion source for {@link resolveSynth}'s unbound
   * throw; glass mode double-covers the one shared chain and dedups to it.
   */
  allBoundNames(): (string | symbol)[] {
    const names = new Set<string | symbol>(this.scope.env.allBoundNames());
    for (const name of this.capabilities.allBoundNames()) names.add(name);
    return [...names];
  }

  /**
   * The raw direct-bindings → resolvers → parent walk; `undefined` on miss, no
   * synth. Used by the keyword/special-form dispatch, which must distinguish a
   * miss (fall through to string-keyed SPECIAL_FORMS) from a found value. The
   * composed `scope.lookup ?? capabilities.lookup`; glass collapses to
   * `env._lookupWithResolvers(name)`.
   */
  lookup(name: string | symbol, ctx?: RunContext): AmbientValue | undefined {
    return this.scope.lookup(name, ctx) ?? this.capabilities.lookup(name, ctx);
  }

  /**
   * The frame that OWNS `name` for hygiene IDENTITY — walk the lexical scope frames,
   * then the capability base. Returns a stable {@link LexicalScope} for a lexical owner
   * (so `=== defResolver.scope` compares the captured def frame), the
   * {@link Capabilities.globalRoot} sentinel for an unshadowed builtin (so `===
   * globalRoot`) — GLASS: a live `AmbientRuntime`; ASSEMBLED: the sealed
   * `CompiledResolutionChain` (BakedBase) itself — or `undefined` if unbound. Own
   * bindings only — no resolvers, no synth — exactly like the old `AmbientRuntime.ref`
   * walk it replaces. NOT a value read and NOT a mutation path.
   */
  refFrame(name: string): LexicalScope | AmbientRuntime | CompiledResolutionChain | undefined {
    return this.scope.refFrame(name) ?? this.capabilities.refFrame(name);
  }

  /**
   * A SETTLED value read — the bound value of `name` (scope then capabilities),
   * read-settled by `AmbientRuntime.get` (pair → quote; raw-in-storage doors),
   * resolver-aware, NON-synth, `undefined` on a miss (never throws).
   * ≡ `env.get(name, { throwError: false })`. Used by hygiene's gensym rename to copy a
   * bound value onto its gensym; distinct from {@link resolve} (which synthesizes c[ad]+r
   * and throws on a miss), so a template-introduced (unbound) identifier yields undefined.
   */
  lookupSettled(name: BindingName): AmbientValue | undefined {
    return this.env.get(name, { throwError: false });
  }

  /**
   * A fresh nested lexical frame carrying the SAME capability base — `this.capabilities`
   * propagates verbatim (never re-derived from the child env), so the macro/hygiene seam
   * keeps a stable `globalRoot` across expansion frames. The frame mint is the
   * module-internal `mintFrame` (AmbientRuntime.ts) — `define` left this class in the
   * monadic-birth ruling; the evaluator's frame-binds go straight through `bindValue`.
   */
  child(name?: string | symbol, kind?: ScopeKind): Resolver {
    return new Resolver(mintFrame(this.env, name), this.capabilities, kind);
  }

  /** Whether `name` is bound in THIS frame (not the chain). ≡ `env.has`. */
  has(name: string): boolean {
    return this.env.has(name);
  }

  toString(): string {
    return `#<resolver:${String(this.env.__name__)}>`;
  }
}
