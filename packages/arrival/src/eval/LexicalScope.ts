import { CLASS } from "../well-known-symbols.js";
import type { BindingName, Environment, EnvironmentValue } from "../Environment.js";

/**
 * The LEXICAL binding chain — let/lambda/letrec/do/catch frames, the names a
 * program introduces. In the eventual (3b) split this is the part of a scope
 * that is CUT from the capability base: a closure captures its lexical chain,
 * and resolution falls through to {@link Capabilities} only when the lexical
 * chain misses.
 *
 * In 3b.2 this is STILL a glass over the base-linked {@link Environment} — the
 * lexical frames and the capability base are one `__parent__`-linked chain — but
 * it now carries the real method surface the hygiene engine (syntax-rules.ts)
 * consults: `refFrame` (which frame OWNS a name, stopping below `global_env`),
 * plus the merge-frame plumbing (`kind`/`ownSymbolEntries`/`parent`/`define`).
 * Each is a byte-identical pass-through over the env today; 3b.3 swaps the
 * IMPLEMENTATION (own `#bindings`, root parent `null`) without re-touching the
 * engine. The genuine decoupling is 3b.3; this type names the target.
 */
const MERGE_SCOPE: symbol = Symbol.for("merge"); // ≡ Syntax.__merge_env__ (registered symbol)

/**
 * Stable wrapper-per-env so `LexicalScope.for(e) === LexicalScope.for(e)`. The
 * hygiene literal check compares `refFrame(name) === defResolver.scope` by IDENTITY,
 * so the wrapper a `refFrame` walk returns for a frame must be the SAME object the
 * `.scope` getter hands back for that same frame. WeakMap so a frame's wrapper is
 * GC'd with the frame. (3b.2-only bridge: 3b.3 constructs LexicalScopes directly.)
 */
const wrappers = new WeakMap<Environment, LexicalScope>();

export class LexicalScope {
  static [CLASS] = "lexical-scope";

  /** The memoized wrapper for `env` (see {@link wrappers}). */
  static for(env: Environment): LexicalScope {
    let w = wrappers.get(env);
    if (w === undefined) {
      w = new LexicalScope(env);
      wrappers.set(env, w);
    }
    return w;
  }

  constructor(readonly env: Environment) {}

  /**
   * The semantic role of this frame. Today only "merge" is consulted (the
   * syntax-rules 2-level-nesting copy-up); a non-merge frame returns undefined.
   * ≡ the old `env.__name__ === Syntax.__merge_env__` check.
   */
  get kind(): "merge" | undefined {
    return (this.env.__name__ as string | symbol) === MERGE_SCOPE ? "merge" : undefined;
  }

  /** This frame's parent as a LexicalScope (memoized), or null at the root. ≡ `env.__parent__`. */
  get parent(): LexicalScope | null {
    return this.env.__parent__ ? LexicalScope.for(this.env.__parent__) : null;
  }

  /**
   * The owning frame of `name` walking the LEXICAL chain — every frame EXCEPT the
   * chain root (the capability base / `global_env`, identified structurally as the
   * parent-less root rather than by an env-roots import, which would cycle through
   * this early-loaded module). `undefined` on a lexical miss (the Resolver then
   * consults {@link Capabilities}; it does NOT fall through here — the 3b.3 contract,
   * byte-identical today because the hygiene chain always roots at global_env). Own
   * bindings only (no resolvers / no synth), exactly like `Environment.ref`.
   */
  refFrame(name: string): LexicalScope | undefined {
    for (let e: Environment | null = this.env; e && e.__parent__; e = e.__parent__) {
      if (e.has(name)) return LexicalScope.for(e);
    }
    return undefined;
  }

  /** This frame's OWN symbol-keyed bindings as [symbol, value] pairs. ≡ `getOwnPropertySymbols(env.__env__)` + reads. */
  ownSymbolEntries(): [symbol, EnvironmentValue][] {
    const env = this.env.__env__;
    return Object.getOwnPropertySymbols(env).map((s) => [s, env[s]] as [symbol, EnvironmentValue]);
  }

  /** Bind a name in THIS frame. ≡ `env.set` (same value-processing). */
  define(name: BindingName, value: EnvironmentValue): void {
    this.env.set(name, value);
  }

  toString(): string {
    return `#<lexical-scope:${String(this.env.__name__)}>`;
  }
}
