import { CLASS } from "../well-known-symbols.js";
import { bindValue, Environment, ResolvingEnvironment } from "../Environment.js";
import type { BindingName, EnvironmentValue } from "../Environment.js";
import type { RunContext } from "../values/primitives/RunContext.js";

/**
 * The LEXICAL binding chain — let/lambda/letrec/do/catch frames, the names a
 * program introduces. This is the part of a scope that is CUT from the
 * capability base: a closure captures its lexical chain, and resolution falls
 * through to {@link Capabilities} only when the lexical chain misses.
 *
 * Currently a glass over the base-linked {@link Environment} — the lexical
 * frames and the capability base are one `__parent__`-linked chain — but it
 * carries the real method surface the hygiene engine (syntax-rules.ts)
 * consults: `refFrame` (which frame OWNS a name, stopping below `global_env`),
 * plus the merge-frame plumbing (`kind`/`ownSymbolEntries`/`parent`/`define`).
 * Each is a byte-identical pass-through over the env today; a future cut swaps
 * the IMPLEMENTATION (own `#bindings`, root parent `null`) without re-touching
 * the engine.
 */
const MERGE_SCOPE: symbol = Symbol.for("merge"); // ≡ Syntax.__merge_env__ (registered symbol)

/**
 * Stable wrapper-per-env so `LexicalScope.for(e) === LexicalScope.for(e)`. The
 * hygiene literal check compares `refFrame(name) === defResolver.scope` by IDENTITY,
 * so the wrapper a `refFrame` walk returns for a frame must be the SAME object the
 * `.scope` getter hands back for that same frame. WeakMap so a frame's wrapper is
 * GC'd with the frame.
 */
const wrappers = new WeakMap<Environment, LexicalScope>();

export class LexicalScope<E extends Environment = Environment> {
  static [CLASS] = "lexical-scope";

  /** The memoized wrapper for `env` (see {@link wrappers}). */
  static for<E extends Environment>(env: E): LexicalScope<E> {
    let w = wrappers.get(env);
    if (w === undefined) {
      w = new LexicalScope(env);
      wrappers.set(env, w);
    }
    // Sound by construction: the memoized wrapper was minted from THIS exact env, so its
    // `.env` IS `env` (the WeakMap erases the generic; identity restores it). Not `any`.
    return w as LexicalScope<E>;
  }

  /**
   * A fresh, ISOLATED lexical root (a null-rooted frame — no `__parent__`, so no
   * base-chain walk) for `exec({ scope })`. Closes the one gap the instance
   * surface's retirement leaves open (arrival-environment-privatization.md §II.1):
   * before this, the only public way to mint an isolated scope was routing through
   * `sandboxedEnv.inherit()` — i.e. isolation itself required the instance surface
   * being retired. Every call mints a NEW root (unlike `.for()`, this is never
   * memoized — there is no env identity to memoize against; that's the point).
   * The returned scope's builtins still resolve through the run's capability base
   * (`scope.lookup ?? capabilities.lookup`, generator-exec.ts) — only the LEXICAL
   * chain is isolated, exactly like every other `LexicalScope`.
   *
   * The root frame is a {@link ResolvingEnvironment} — the machinery-target frame class —
   * so `scope.env` carries the full structural `SchemeEnv` write contract: a SESSION owner
   * (a chain extension registrar, the runtime `(require/extension …)` assembler) registers
   * packs against the scope frame it holds, exactly as it did against the pre-privatization
   * instance env. A plain lexical frame would silently drop that contract (V4's chain-env
   * migration is the consumer that proved it load-bearing).
   */
  static fresh(name: string | symbol = "session"): SessionScope {
    return LexicalScope.for(new ResolvingEnvironment(name, {}, null));
  }

  constructor(readonly env: E) {}

  /**
   * The semantic role of this frame. Today only "merge" is consulted (the
   * syntax-rules 2-level-nesting copy-up); a non-merge frame returns undefined.
   * ≡ the old `env.__name__ === Syntax.__merge_env__` check.
   */
  get kind(): "merge" | undefined {
    // `__name__` is `string | symbol`, so the merge-frame's `Symbol.for("merge")`
    // identity compares directly — no cast needed (Environment.ts widening).
    return this.env.__name__ === MERGE_SCOPE ? "merge" : undefined;
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
   * consults {@link Capabilities}; it does NOT fall through here). Own bindings
   * only (no resolvers / no synth), exactly like `Environment.ref`.
   */
  refFrame(name: string): LexicalScope | undefined {
    for (let e: Environment | null = this.env; e && e.__parent__; e = e.__parent__) {
      if (e.has(name)) return LexicalScope.for(e);
    }
    return undefined;
  }

  /**
   * The raw LEXICAL bindings walk (`undefined` on a miss, no synth) — the lexical
   * half of the Resolver's composed `scope.lookup(name) ?? capabilities.lookup(name)`.
   * Currently the env is still base-linked, so this walks through to the base too;
   * the Resolver's `?? capabilities.lookup` is then never reached on a hit.
   */
  lookup(name: string | symbol, ctx?: RunContext): EnvironmentValue | undefined {
    return this.env._lookupWithResolvers(name, ctx);
  }

  /** This frame's OWN symbol-keyed bindings as [symbol, value] pairs. ≡ `getOwnPropertySymbols(env.__env__)` + reads. */
  ownSymbolEntries(): [symbol, EnvironmentValue][] {
    const env = this.env.__env__;
    return Object.getOwnPropertySymbols(env).map((s) => [s, env[s]] as [symbol, EnvironmentValue]);
  }

  /** Bind a name in THIS frame — the EVALUATOR's frame-bind (let/lambda/letrec/define/
   *  catch land here), routed through the module-internal storage write (`bindValue`,
   *  Environment.ts). Inside the membrane by definition: the values arriving here are
   *  evaluation results, already boxed. */
  define(name: BindingName, value: EnvironmentValue): void {
    bindValue(this.env, name, value);
  }

  toString(): string {
    return `#<lexical-scope:${String(this.env.__name__)}>`;
  }
}

/** The scope type {@link LexicalScope.fresh} mints — a `LexicalScope` whose root frame is a
 *  `ResolvingEnvironment`, i.e. whose `.env` satisfies the structural `SchemeEnv` pack-write
 *  contract. Named so session products (`ArrivalSession` in arrival-run, chain-env's `ChainEnv`)
 *  can state the refinement without reaching for the internal class name. */
export type SessionScope = LexicalScope<ResolvingEnvironment>;
