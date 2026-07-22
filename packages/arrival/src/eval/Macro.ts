import { CLASS } from "../well-known-symbols.js";
import { TF_EXPAND } from "../values/tagless-final.js";
import type { RunContext } from "../run/RunContext.js";
import type { SchemeValue } from "../values/types.js";
import type { APair } from "../values/primitives/APair.js";
import type { AmbientRuntime } from "../env/AmbientRuntime.js";
import type { Resolver } from "./Resolver.js";

/**
 * The uniform result of the `TF_EXPAND` term — a transcribed FORM plus, for a hygienic
 * transformer, the scope it must evaluate in. `Syntax.expand` always supplies `scope`
 * (its `MacroExpansion`); a `Macro` fexpr never does (its expansion evaluates in the
 * use-site resolver). `expr` may be a promise at runtime — a define-macro `__fn__` can
 * be async — which the evaluator awaits before evaluating (the term stays a thin sync
 * wrapper; the trampoline owns the await).
 */
export interface Expansion {
  expr: SchemeValue;
  scope?: AmbientRuntime;
}

export interface MacroInvokeContext {
  env: unknown;
  error?: (e: Error) => void;
  use_dynamic?: boolean;
  dynamic_env?: unknown;
  /** The per-run context, threaded to the macro engine's mint door (eval/syntax-rules.ts)
   *  so every value the expander mints during a live expansion carries the run's identity
   *  and charges its allocation meter. REQUIRED, never optional: `is_macro` dispatch (the
   *  only builder of this context) always holds a live `EvalContext.runCtx`, and an
   *  optional field would re-open a `?? CONSTANT_CTX` fallback that silently unmeters. */
  runCtx: RunContext;
  /** The use-site resolver (synced to `env`). The expander uses the def-time Resolver a
   *  `Syntax` captures instead. Optional — define-macro fexprs ignore it. */
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
   *  (common/symbols/define-bake.ts) from the declared `DefineSyntaxSymbolDef.macroAttribute`.
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

  // A define-macro fexpr is Exp→Exp: it returns a replacement FORM (a `SchemeValue`),
  // never an expansion record — that is `Syntax.expand`'s job. The fexpr body runs with
  // `env` as `this`; `macro_expand` lets a macro recursively expand its own output.
  invoke(code: unknown, { env, ...rest }: MacroInvokeContext, macro_expand: boolean = false): SchemeValue {
    return this.__fn__.call(env, code, { ...rest, macro_expand }, this.__name__) as SchemeValue;
  }

  // RAW-ARG dispatch term (the head gate reads it via `is_expandable`). A fexpr consumes the
  // keyword-STRIPPED operands (`code.cdr` — the `rest` the evaluator historically split off),
  // and produces a scope-less `Expansion` (it evaluates in the use-site resolver). `Syntax`
  // carries the sibling term returning `{ expr, scope }`. Kept a thin sync wrapper: the
  // possibly-async `invoke` result rides `expr` and the trampoline awaits it.
  [TF_EXPAND](code: APair<SchemeValue, SchemeValue>, ctx: MacroInvokeContext): Expansion {
    return { expr: this.invoke(code.cdr, ctx, false) };
  }

  toString(): string {
    return `#<macro:${this.__name__}>`;
  }
}
