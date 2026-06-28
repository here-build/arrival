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
    // `resolver` is the EVALUATOR's resolver at define-syntax time (threaded through
    // Macro.invoke), carrying the run's capability base. (D2)
    const { use_dynamic, error, resolver: defSiteResolver } = options;
    // TODO: find identifiers and freeze the scope when defined #172
    const env = this;
    // The def-time Resolver — scope = the define-syntax env (the hygiene identity
    // root), capabilities = the EVALUATOR's threaded base (NOT re-derived from `env`
    // via chainRoot: under the 3b.3 cut `env` is null-rooted, so chainRoot would
    // return the lexical root, not the base, and `globalRoot` would be wrong). Under
    // glass `defSiteResolver.capabilities` and `new Capabilities(env)` share the same
    // `globalRoot` (global_env), so this is byte-identical.
    const defResolver = new Resolver(env, defSiteResolver?.capabilities);

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
    const syntax = new Syntax(function (this: Environment, code: SchemeValue, { macro_expand, resolver: useSiteResolver }: SchemeValue) {
      // The use-site Resolver — the EVALUATOR's resolver at expansion time (threaded
      // through Syntax.invoke), carrying the run's capability base. NOT a fresh glass
      // `new Resolver(this)`, which under the 3b.3 cut would re-derive a wrong globalRoot
      // from the null-rooted `this`. Its env IS `this` (the expansion env), so the
      // merge-frame plumbing below is unchanged; under glass byte-identical. (D1)
      const useResolver = useSiteResolver ?? new Resolver(this);
      // The def-time syntax-child Resolver: `defResolver.child("syntax")` ≡ `env.inherit("syntax")`.
      // Its env is the hygiene scope, shared by-ref into the merge return below.
      const defChild = defResolver.child("syntax");
      const scope = defChild.env;
      const dynamic_env = scope;
      // for macros that define variables used in macro (2 levels nestting): if `this` is itself a
      // merge frame (from an outer expansion), copy its symbol-keyed gensyms up into the parent and
      // unwrap. Routed through the LexicalScope surface (kind/ownSymbolEntries/parent.define) — a
      // byte-identical pass-through over the env today (P3 3b.2).
      let useScope = useResolver.scope;
      if (useScope.kind === "merge") {
        for (const [sym, value] of useScope.ownSymbolEntries()) {
          useScope.parent!.define(sym, value);
        }
        useScope = useScope.parent!;
      }
      const var_scope: Environment = useScope.env;
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
            // Hygiene-identity handles: use-site Resolver, the captured def Resolver, and its
            // capabilities (globalRoot = the unshadowed-base identity). See P3 3b.2.
            useResolver,
            defResolver,
            capabilities: defResolver.capabilities,
          });
          if (bindings) {
            // name is modified in transform_syntax
            const names = [];
            const new_expr = transform_syntax({
              bindings,
              expr,
              symbols,
              scope: defChild,
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
