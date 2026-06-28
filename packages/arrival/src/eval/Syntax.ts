import { CLASS } from "../well-known-symbols.js";
import type { MacroInvokeContext } from "./Macro.js";

// Type for syntax object (can be Syntax or Function)
type SyntaxLike = Syntax | Function;

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

  constructor(fn: Function, env: unknown) {
    this.__name__ = "";
    this.__fn__ = fn;
    this.__env__ = env;
    // allow macroexpand
    this.__defmacro__ = true;
  }

  invoke(code: unknown, { error, env, use_dynamic, runCtx }: MacroInvokeContext, macro_expand: unknown): unknown {
    const args = {
      error,
      env,
      use_dynamic,
      dynamic_env: this.__env__,
      macro_expand,
      runCtx,
    };
    return this.__fn__.call(env, code, args, this.__name__ || "syntax");
  }

  toString(): string {
    if (this.__name__) {
      return `#<syntax:${this.__name__}>`;
    }
    return "#<syntax>";
  }
}
