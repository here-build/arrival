import { CLASS } from "../well-known-symbols.js";
import type { Environment } from "../Environment.js";

/**
 * The LEXICAL binding chain — let/lambda/letrec/do/catch frames, the names a
 * program introduces. In the eventual (3b) split this is the part of a scope
 * that is CUT from the capability base: a closure captures its lexical chain,
 * and resolution falls through to {@link Capabilities} only when the lexical
 * chain misses.
 *
 * In 3a this is a thin nominal wrapper over the still-base-linked
 * {@link Environment} — `glass` over the existing chain, with zero semantic
 * change. The genuine decoupling (cut lexical→base, so a frame no longer
 * inherits the builtins by `__parent__`) is 3b; this type exists now only so the
 * Resolver facade and the macro seam can name the eventual target while still
 * bottoming out in `env`.
 */
export class LexicalScope {
  static [CLASS] = "lexical-scope";

  constructor(readonly env: Environment) {}

  toString(): string {
    return `#<lexical-scope:${this.env.__name__}>`;
  }
}
