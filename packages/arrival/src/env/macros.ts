// @here.build/arrival/macros — the scheme/macros pack: syntax-rules.
//
// syntax-rules was the last macro-family member stuck in the stdlib husk blob (a raw
// `new Syntax` bound directly into global_env). It moves here, bound via `symbol.macro`
// — a non-evaluating form carrying a raw JS transformer (the gap that blocked the move:
// `keyword` dispatches to the evaluator, `native`/`rosetta` evaluate their args, prelude
// is scheme source). The hygienic-expansion ENGINE stays a leaf (eval/syntax-rules.ts);
// the generic `is_macro`/`is_syntax` eval hook is untouched. `define-syntax`/`let-syntax`
// (scheme/core) keep resolving `syntax-rules` from the assembled env.

import { EnvCapability } from "../common/capability.js";
import { symbol } from "../common/symbol.js";
import { Macro } from "../eval/Macro.js";
import { Syntax } from "../eval/Syntax.js";
import { Environment } from "../Environment.js";
import { global_env } from "../env-roots.js";
import { extract_patterns, transform_syntax, restore_data_gensyms } from "../eval/syntax-rules.js";
import { is_nil } from "../values/value-guards.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { Resolver } from "../eval/Resolver.js";

// Scheme is inherently dynamic — these use `any` intentionally for interpreter interop.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemeValue = any;

// The syntax-rules transformer-constructor, relocated VERBATIM from the stdlib husk (was the
// `global_env.__env__` blob). Invoked as `(syntax-rules (literals) (pattern template)…)` → returns
// a Syntax that rewrites a matching form via the engine. `this` is the define-syntax invocation
// env; global_env supplies the hygiene identity root.
const syntaxRules = new Macro(
  "syntax-rules",
  function (this: Environment, macro: SchemeValue, options: SchemeValue) {
    const { use_dynamic, error } = options;
    // TODO: find identifiers and freeze the scope when defined #172
    const env = this;
    // The def-time Resolver (P3 3a.4) — wraps the define-syntax env, the hygiene
    // identity root. The transformer derives its `scope`/`define` through this
    // facade; in 3a it bottoms out in the same base-linked env, so hygiene is
    // byte-identical. 3b swaps the algorithm behind this seam.
    const defResolver = new Resolver(env);

    function get_identifiers(node: SchemeValue) {
      const symbols: SchemeValue[] = [];
      while (!is_nil(node)) {
        const x = node.car;
        symbols.push(x.valueOf());
        node = node.cdr;
      }
      return symbols;
    }

    function validate_identifiers(node) {
      while (!is_nil(node)) {
        const x = node.car;
        TypeError.invariant(x instanceof ASymbol, "syntax-rules: wrong identifier");
        node = node.cdr;
      }
    }

    if (macro.car instanceof ASymbol) {
      validate_identifiers(macro.cdr.car);
    } else {
      validate_identifiers(macro.car);
    }
    const syntax = new Syntax(function (this: Environment, code: SchemeValue, { macro_expand }: SchemeValue) {
      // Hygiene scope derived via the def-time Resolver pass-through (P3 3a.4):
      // `defResolver.child("syntax").env` ≡ `env.inherit("syntax")`.
      const scope = defResolver.child("syntax").env;
      const dynamic_env = scope;
      let var_scope: Environment = this;
      // for macros that define variables used in macro (2 levels nestting)
      if ((var_scope.__name__ as string | symbol) === Syntax.__merge_env__) {
        // copy refs for defined gynsyms
        const props = Object.getOwnPropertySymbols(var_scope.__env__);
        for (const symbol of props) {
          var_scope.__parent__!.set(symbol, var_scope.__env__[symbol]);
        }
        var_scope = var_scope.__parent__!;
      }
      const eval_args = { env: scope, dynamic_env, use_dynamic, error };
      let ellipsis, rules, symbols;
      if (macro.car instanceof ASymbol) {
        ellipsis = macro.car;
        symbols = get_identifiers(macro.cdr.car);
        rules = macro.cdr.cdr;
      } else {
        ellipsis = "...";
        symbols = get_identifiers(macro.car);
        rules = macro.cdr;
      }
      try {
        while (!is_nil(rules)) {
          const rule = rules.car.car;
          let expr = rules.car.cdr.car;
          const bindings = extract_patterns(rule, code, symbols, ellipsis, {
            expansion: this,
            // def env via the Resolver pass-through (≡ env); identity-stable for
            // the engine's `ref === define` literal check.
            define: defResolver.env,
            globalEnv: global_env,
          });
          if (bindings) {
            // name is modified in transform_syntax
            const names = [];
            const new_expr = transform_syntax({
              bindings,
              expr,
              symbols,
              scope,
              lex_scope: var_scope,
              names,
              ellipsis,
            });
            // TODO: if expression is undefined throw an error
            if (new_expr) {
              expr = new_expr;
            }
            const new_env = var_scope.merge(scope, Syntax.__merge_env__ as unknown as string);
            // FORM-RETURNING (always): hand back the transcribed FORM + its hygiene scope.
            // The evaluator yields this form into the flat trampoline (tail position) and the
            // macroexpand traverse re-expands it — the transformer NEVER evaluates inside
            // itself, so a macro in tail position stays tail-proper (no nested run() frame).
            // restore_data_gensyms un-renames the template's DATA-position gensyms (under
            // quote/quasiquote) so quote yields literal symbols with no post-eval fixup.
            // `macro_expand` no longer changes the return — both callers want the form.
            void macro_expand;
            return { expr: restore_data_gensyms(expr, names), scope: new_env };
          }
          rules = rules.cdr;
        }
      } catch (error_) {
        (error_ as Error).message += `\nin macro:\n  ${macro.toString()}`;
        throw error_;
      }
      throw new Error(`syntax-rules: no matching syntax in macro ${code.toString()}`);
    }, env, defResolver);
    (syntax as SchemeValue).__code__ = macro;
    return syntax;
  },
);

/** scheme/macros — the macro family that carries a JS expander; today, syntax-rules. */
export default new EnvCapability("scheme/macros", {
  symbols: { "syntax-rules": symbol.macro(syntaxRules) },
});
