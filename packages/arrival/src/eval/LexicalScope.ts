import { AmbientRuntime, mintFrame, mintResolvingFrame, ResolvingAmbient } from "../env/AmbientRuntime.js";
import type { AmbientValue } from "../env/AmbientRuntime.js";
import type { RunContext } from "../run/RunContext.js";
import { INTEROP_BOUNDARY } from "../membrane/interop-access.js";

/**
 * The LEXICAL binding chain — let/lambda/letrec/do/catch frames, the names a
 * program introduces. Cut from the capability base: a closure captures its
 * lexical chain, and resolution falls through to {@link Capabilities} only on
 * a lexical miss.
 *
 * Currently a glass over the base-linked {@link AmbientRuntime} — lexical
 * frames and capability base are one `__parent__`-linked chain — but it
 * carries the real method surface the hygiene engine (syntax-rules.ts)
 * consults: `refFrame` (which frame OWNS a name, stopping below the chain
 * root), plus merge-frame plumbing (`kind`/`ownSymbolEntries`/`parent`/
 * `define`). Each is a pass-through over the env today; a future cut can swap
 * the IMPLEMENTATION (own `#bindings`, root parent `null`) without re-touching
 * the engine.
 */
const MERGE_SCOPE: symbol = Symbol.for("merge"); // ≡ Syntax.__merge_env__ (registered symbol)

/**
 * Stable wrapper-per-env so `LexicalScope.for(e) === LexicalScope.for(e)`.
 * Hygiene literal check compares `refFrame(name) === defResolver.scope` by
 * IDENTITY, so the wrapper a `refFrame` walk returns must be the SAME object
 * the `.scope` getter hands back. WeakMap so a frame's wrapper is GC'd with
 * the frame.
 */
const wrappers = new WeakMap<AmbientRuntime, LexicalScope>();

export class LexicalScope<E extends AmbientRuntime = AmbientRuntime> {
  // Outside AValue/ArrivalError families — own interop stamp.
  static [INTEROP_BOUNDARY] = true;

  /** Memoized wrapper for `env` (see {@link wrappers}). */
  static for<E extends AmbientRuntime>(env: E): LexicalScope<E> {
    let w = wrappers.get(env);
    if (w === undefined) {
      w = new LexicalScope(env);
      wrappers.set(env, w);
    }
    // Sound by construction: memoized wrapper was minted from THIS env.
    // WeakMap erases the generic; identity restores it.
    return w as LexicalScope<E>;
  }

  /**
   * Fresh, ISOLATED lexical root (null-rooted — no `__parent__`) for
   * `exec({ scope })`. Every call mints a NEW root (unlike `.for()`, never
   * memoized — no env identity to memoize against). Builtins still resolve
   * through the run's capability base (`scope.lookup ?? capabilities.lookup`);
   * only the LEXICAL chain is isolated.
   *
   * Root frame is a {@link ResolvingAmbient} so `scope.env` carries the full
   * structural `SchemeEnv` write contract: a SESSION owner (chain extension
   * registrar, runtime `(require/extension …)` assembler) registers packs
   * against the scope frame it holds. A plain lexical frame would silently
   * drop that contract.
   */
  static fresh(name: string | symbol = "session"): SessionScope {
    return LexicalScope.for(mintResolvingFrame(name, {}, null));
  }

  constructor(readonly env: E) {}

  /**
   * Semantic role of this frame. Only "merge" is consulted today (syntax-rules
   * 2-level-nesting copy-up); a non-merge frame returns undefined.
   * ≡ `env.__name__ === Syntax.__merge_env__`.
   */
  get kind(): "merge" | undefined {
    // `__name__` is `string | symbol` — merge-frame's Symbol.for("merge") compares directly.
    return this.env.__name__ === MERGE_SCOPE ? "merge" : undefined;
  }

  /** Parent as LexicalScope (memoized), or null at the root. ≡ `env.__parent__`. */
  get parent(): LexicalScope | null {
    return this.env.__parent__ ? LexicalScope.for(this.env.__parent__) : null;
  }

  /**
   * Owning frame of `name` walking the LEXICAL chain — every frame EXCEPT the
   * chain root (capability base, identified structurally as the parent-less
   * root — no env-roots import, which would cycle through this early-loaded
   * module). `undefined` on a lexical miss (Resolver consults Capabilities).
   * Own bindings only (no resolvers / no synth), like `AmbientRuntime.ref`.
   */
  refFrame(name: string): LexicalScope | undefined {
    for (let e: AmbientRuntime | null = this.env; e && e.__parent__; e = e.__parent__) {
      if (e.has(name)) return LexicalScope.for(e);
    }
    return undefined;
  }

  /**
   * Raw LEXICAL bindings walk (`undefined` on miss, no synth) — the lexical
   * half of Resolver's composed `scope.lookup(name) ?? capabilities.lookup(name)`.
   * While the env is still base-linked, this walks through to the base too;
   * the Resolver's `?? capabilities.lookup` is then never reached on a hit.
   */
  lookup(name: string | symbol, ctx?: RunContext): AmbientValue | undefined {
    return this.env._lookupWithResolvers(name, ctx);
  }

  /** This frame's OWN symbol-keyed bindings as [symbol, value] pairs. */
  ownSymbolEntries(): [symbol, AmbientValue][] {
    const env = this.env.__env__;
    return Object.getOwnPropertySymbols(env).map((s) => [s, env[s]] as [symbol, AmbientValue]);
  }

  /**
   * Fresh CHILD frame of this scope — the public frame-BIRTH door for a
   * session owner (per-run scope above a long-lived session scope). Subtype-
   * preserving via `mintFrame`, so a {@link SessionScope}'s child keeps the
   * structural `SchemeEnv` pack-write contract. NO bindings parameter: the
   * child is born EMPTY, populated only by the evaluator (program `define`s)
   * or capability assembly — never by a JS-side record.
   */
  child(name?: string | symbol): LexicalScope<E> {
    // mintFrame is subtype-preserving over the two concrete frame classes.
    return LexicalScope.for(mintFrame(this.env, name) as E);
  }

  toString(): string {
    return `#<lexical-scope:${String(this.env.__name__)}>`;
  }
}

/** Scope type {@link LexicalScope.fresh} mints — root frame is ResolvingAmbient,
 *  so `.env` satisfies the structural SchemeEnv pack-write contract. Named so
 *  session products can state the refinement without the internal class name. */
export type SessionScope = LexicalScope<ResolvingAmbient>;
