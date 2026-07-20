import { CLASS } from "../well-known-symbols.js";
import type { AmbientRuntime } from "../env/AmbientRuntime.js";
import type { SchemeValue } from "../values/types.js";
import type { MacroInvokeContext } from "./Macro.js";
import type { Resolver } from "./Resolver.js";

type SyntaxLike = Syntax | Function;

/**
 * The result of expanding a `Syntax`: the transcribed FORM plus the hygiene
 * scope it must evaluate in. A transformer is Exp→Exp — it returns a form, never
 * a value. This shape is determined by the CLASS (always, for `Syntax`), not by
 * any flag: `env/macros.ts` returns it unconditionally (`void macro_expand`).
 */
interface MacroExpansion {
  expr: SchemeValue;
  scope: AmbientRuntime;
}

/**
 * A `syntax-rules` transformer. NOT a `Macro`: a `Macro` is a runtime value (a
 * bound, callable fexpr), whereas a `Syntax` is an EXPAND-TIME rewriter — it
 * captures its definition env (`__env__`) for hygiene and returns a
 * quoted-already expansion (evaluatePair forwards Syntax results without
 * re-evaluating — see the `is_syntax` branch there). The two share a duck shape
 * (`__name__`/`__fn__`/`__defmacro__`/`invoke`) the evaluator treats uniformly
 * via `is_macro`, but neither is-a the other — hence no `extends`.
 *
 * Lineage: a hygienic macro transformer (Kohlbecker et al. 1986; Clinger & Rees,
 * "Macros That Work", POPL 1991); the nested `Parameter` is SRFI-139 syntax
 * parameters.
 */
export class Syntax {
  static [CLASS] = "syntax";
  static __merge_env__ = Symbol.for("merge");
  // SRFI-139
  static Parameter = class SyntaxParameter {
    static [CLASS] = "syntax-parameter";

    _syntax!: SyntaxLike; // Definite assignment - set via Object.defineProperty
    constructor(syntax: SyntaxLike) {
      Object.defineProperty(this, "_syntax", {
        value: syntax,
        configurable: true,
        enumerable: false,
      });
      Object.defineProperty(syntax, "_param", {
        value: true,
        configurable: true,
        enumerable: false,
      });
    }
  };

  __name__: string;
  __fn__: Function;
  __defmacro__: boolean;
  __env__: unknown;
  /**
   * The original macro FORM this transformer was built from (the
   * `(syntax-rules …)` operands), stashed by the syntax-rules constructor in
   * env/macros.ts for inspection/printing. A Scheme form, not a value the
   * transformer ever returns — held on the transformer object, outside the
   * value channel.
   */
  __code__?: SchemeValue;
  /**
   * The def-time Resolver — wraps `__env__`, the hygiene identity root. Captured
   * here and closed over by the transformer in env/macros.ts; currently a glass
   * over the same base-linked def env, so hygiene still reaches base through it.
   */
  __resolver__: Resolver | undefined;

  constructor(fn: Function, env: unknown, resolver?: Resolver) {
    this.__name__ = "";
    this.__fn__ = fn;
    this.__env__ = env;
    this.__resolver__ = resolver;
    this.__defmacro__ = true;
  }

  // A `syntax-rules` transformer is Exp→Exp: it always returns the transcribed
  // form + hygiene scope (`MacroExpansion`), never a value — hence `expand`, not
  // a boolean-switched `invoke`. `macro_expand` is pinned `true`; the transformer
  // in env/macros.ts ignores it, kept only for fexpr-arg parity with `Macro.invoke`.
  expand(code: unknown, { error, env, use_dynamic, runCtx, resolver }: MacroInvokeContext): MacroExpansion {
    const args = {
      error,
      env,
      use_dynamic,
      dynamic_env: this.__env__,
      macro_expand: true,
      runCtx,
      // Use-site resolver (from the dispatch) + the def-time one captured on this
      // Syntax; the transformer closes over its own def Resolver for hygiene, so
      // passing both changes nothing observable yet.
      resolver,
      defResolver: this.__resolver__,
    };
    return this.__fn__.call(env, code, args, this.__name__ || "syntax") as MacroExpansion;
  }

  toString(): string {
    if (this.__name__) {
      return `#<syntax:${this.__name__}>`;
    }
    return "#<syntax>";
  }
}
