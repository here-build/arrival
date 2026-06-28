import { CLASS } from "../well-known-symbols.js";
import type { Environment } from "../Environment.js";

/**
 * The CAPABILITY base — the builtins/preludes/host-supplied resolvers a run is
 * armed with (today, everything reachable from `global_env`/`user_env`). In the
 * eventual (3b) split this is the shared root that a {@link LexicalScope} falls
 * through to: lexical names resolve in the frame chain, everything else (car,
 * map, `:key` accessors, the polyglot resolvers) resolves here.
 *
 * In 3a this is a thin nominal wrapper over the still-base-linked
 * {@link Environment} — the lexical chain and the capability base are literally
 * the SAME `__parent__`-linked env, so both wrap it. 3b severs them; this type
 * exists now only to name the target. Keep it minimal — do not grow a resolution
 * API here until 3b actually needs one.
 */
export class Capabilities {
  static [CLASS] = "capabilities";

  constructor(readonly env: Environment) {}

  toString(): string {
    return `#<capabilities:${this.env.__name__}>`;
  }
}
