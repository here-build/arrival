import { CLASS } from "../well-known-symbols.js";
import type { RunContext } from "../values/primitives/RunContext.js";
import type { SchemeValue } from "../values/types.js";
import type { Resolver } from "./Resolver.js";

export interface MacroInvokeContext {
  env: unknown;
  error?: (e: Error) => void;
  use_dynamic?: boolean;
  dynamic_env?: unknown;
  /** The per-run context, threaded to the macro engine so every value the expander
   *  MINTS during a live expansion carries the run's identity and charges its
   *  allocation meter (eval/syntax-rules.ts's mint door). REQUIRED — the evaluator's
   *  `is_macro` dispatch (the only builder of this context) always holds a live
   *  `EvalContext.runCtx`, itself required since the constant-ctx wave-0 cut; an
   *  optional field here would just re-open the `?? CONSTANT_CTX` apology seam the
   *  wave-3 plumb closes (the CONSTANT_CTX audit §4). */
  runCtx: RunContext;
  /** The use-site resolver (synced to `env`). The expander uses the def-time
   *  Resolver a `Syntax` captures instead. Optional — define-macro fexprs ignore it. */
  resolver?: Resolver;
  [key: string]: unknown;
}

/**
 * A define-macro fexpr: a function that receives UNEVALUATED code and returns a
 * replacement form. `Syntax` (syntax-rules) subclasses this. `__defmacro__` marks
 * instances that `macroexpand` is allowed to expand.
 *
 * Lineage: a fexpr — a first-class operative that receives UNEVALUATED operands
 * (Pitman, "Special Forms in Lisp", 1980; Shutt, "Fexprs as the basis of Lisp
 * function application", 2010).
 */
export class Macro {
  static [CLASS] = "macro";

  __name__: string;
  __fn__: Function;
  __doc__?: string;
  __defmacro__?: boolean;
  /** The ternary static-walk attribute, stamped by `symbol.defineSyntax`'s bind arm
   *  (common/symbols/define-bake.ts) from the DECLARED `DefineSyntaxSymbolDef.macroAttribute`.
   *  `undefined` (every prelude-era macro, every JS-authored transformer) reads as
   *  `"opaque"` — the safe under-report default the validator's firewall assumes
   *  (static-validation/vocabulary.ts). */
  macroAttribute?: "opaque" | "expression" | "binder";

  constructor(name: string, fn: Function, doc?: string, dump?: boolean) {
    if (doc) {
      this.__doc__ = dump
        ? doc
        : doc
            .split("\n")
            .map((line) => line.trim())
            .join("\n");
    }
    this.__name__ = name;
    this.__fn__ = fn;
  }

  // A define-macro fexpr is Exp→Exp: it returns a replacement FORM (a
  // `SchemeValue`), never an expansion record — that is `Syntax.expand`'s job.
  // The fexpr body runs with `env` as `this`; `macro_expand` is threaded in so a
  // macro can recursively expand its own output.
  invoke(code: unknown, { env, ...rest }: MacroInvokeContext, macro_expand: boolean = false): SchemeValue {
    return this.__fn__.call(env, code, { ...rest, macro_expand }, this.__name__) as SchemeValue;
  }

  toString(): string {
    return `#<macro:${this.__name__}>`;
  }
}
