import { TF_EXPAND } from "../values/tagless-final.js";
import { INTEROP_BOUNDARY } from "../membrane/interop-access.js";
import type { RunContext } from "../run/RunContext.js";
import type { SchemeValue } from "../values/types.js";
import type { APair } from "../values/primitives/APair.js";
import type { AmbientRuntime } from "../env/AmbientRuntime.js";
import type { Resolver } from "./Resolver.js";

/**
 * Uniform result of the `TF_EXPAND` term — a transcribed FORM plus, for a
 * hygienic transformer, the scope it must evaluate in. `Syntax.expand` always
 * supplies `scope` (its MacroExpansion); a Macro fexpr never does (evaluates
 * in the use-site resolver). `expr` may be a promise at runtime — a
 * define-macro `__fn__` can be async — which the evaluator awaits before
 * evaluating (thin sync wrapper; trampoline owns the await).
 */
export interface Expansion {
  expr: SchemeValue;
  scope?: AmbientRuntime;
}

export interface MacroInvokeContext {
  env: unknown;
  /** Per-run context, threaded to the macro engine's mint door
   *  (eval/syntax-rules.ts) so expander-minted values charge the allocation
   *  meter. REQUIRED: is_macro dispatch always holds a live EvalContext.runCtx;
   *  optional would reopen a `?? CONSTANT_CTX` silent-unmeter fallback. */
  runCtx: RunContext;
  /** Use-site resolver (synced to `env`). The expander uses the def-time
   *  Resolver a Syntax captures instead. Optional — define-macro fexprs ignore it. */
  resolver?: Resolver;
  [key: string]: unknown;
}

/**
 * A define-macro fexpr: receives UNEVALUATED code and returns a replacement
 * form. `Syntax` (syntax-rules) is a sibling, not a subclass. `__defmacro__`
 * marks instances that `macroexpand` may expand.
 *
 * Lineage: fexpr — first-class operative with UNEVALUATED operands (Pitman
 * 1980; Shutt 2010).
 */
export class Macro {
  // Outside the AValue/ArrivalError families that FAMILY RULEs cover — own stamp
  // (membrane.ts is_macro_value dispatch can reach the interop read path).
  static [INTEROP_BOUNDARY] = true;
  // Value-layer downward-readable macro identity — is_macro_value (value-guards.ts)
  // with no value→eval runtime edge.
  readonly ["arrival/is-macro"] = true;

  __name__: string;
  __fn__: Function;
  __doc__?: string;
  __defmacro__?: boolean;
  /** Ternary static-walk attribute, stamped by `symbol.defineSyntax`'s bind arm
   *  (common/symbols/define-bake.ts) from `DefineSyntaxSymbolDef.macroAttribute`.
   *  `undefined` (prelude-era / JS-authored transformers) reads as `"opaque"` —
   *  the safe under-report default the validator's firewall assumes
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

  // Exp→Exp: returns a replacement FORM (SchemeValue), never an expansion
  // record — that is Syntax.expand's job. Body runs with `env` as `this`.
  invoke(code: unknown, { env, ...rest }: MacroInvokeContext, macro_expand: boolean = false): SchemeValue {
    return this.__fn__.call(env, code, { ...rest, macro_expand }, this.__name__) as SchemeValue;
  }

  // RAW-ARG dispatch term (head gate via is_expandable). Consumes keyword-stripped
  // operands (`code.cdr`); produces a scope-less Expansion (use-site resolver).
  // Thin sync wrapper: possibly-async invoke result rides `expr`; trampoline awaits.
  [TF_EXPAND](code: APair<SchemeValue, SchemeValue>, ctx: MacroInvokeContext): Expansion {
    return { expr: this.invoke(code.cdr, ctx, false) };
  }

  toString(): string {
    return `#<macro:${this.__name__}>`;
  }
}
