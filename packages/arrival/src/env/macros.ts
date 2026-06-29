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
import { Syntax } from "../eval/Syntax.js";
import { Environment } from "../Environment.js";
import { extract_patterns, restore_data_gensyms, transform_syntax } from "../eval/syntax-rules.js";
import { is_nil, is_pair as is_pair_raw } from "../values/value-guards.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { APair } from "../values/primitives/APair.js";
import { Resolver } from "../eval/Resolver.js";
import type { MacroInvokeContext } from "../eval/Macro.js";
import type { SchemeValue } from "../values/types.js";

// Macros-domain refinement of `is_pair` — the same shadow the evaluator uses.
// The shared `is_pair` (value-guards) narrows only to `APair<unknown, unknown>`
// because `APair` is generic over its slot types for the membrane/reader boundary.
// Every cons cell this pack walks (a macro form / its rules, emitted by the reader)
// is fully boxed — its car and cdr ARE `SchemeValue`s. This shadow makes that domain
// truth visible at the type level so each `.car`/`.cdr`/`.valueOf()` descent over a
// narrowed pair types as a scheme value WITHOUT a per-site cast. Same runtime
// predicate, same structural commitment, refined to this layer's slot truth.
const is_pair = (o: unknown): o is APair<SchemeValue, SchemeValue> => is_pair_raw(o);

// The syntax-rules transformer-constructor, relocated VERBATIM from the stdlib husk (was the
// `global_env.__env__` blob). Invoked as `(syntax-rules (literals) (pattern template)…)` → returns
// a Syntax that rewrites a matching form via the engine. `this` is the define-syntax invocation
// env; global_env supplies the hygiene identity root.
const syntaxRulesDef = symbol.macro`syntax-rules`(function (
  this: Environment,
  macro: SchemeValue,
  options: MacroInvokeContext,
) {
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

  function get_identifiers(node: unknown) {
    // `node` is typed `unknown` — the honest contract for an arbitrary datum (and for
    // `APair.car`'s default). The walk narrows internally with the slot-typed `is_pair`
    // shadow, so `node.car` / `node.cdr` descend as scheme values with no per-site cast.
    // Collects the unwrapped identifier NAMES (string | symbol from each ASymbol's
    // valueOf), consumed downstream as a name-list via `.includes`.
    const symbols: unknown[] = [];
    while (is_pair(node)) {
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

  TypeError.invariant(is_pair(macro), "syntax-rules: malformed macro form");
  if (macro.car instanceof ASymbol) {
    TypeError.invariant(is_pair(macro.cdr), "syntax-rules: malformed macro form");
    validate_identifiers(macro.cdr.car);
  } else {
    validate_identifiers(macro.car);
  }
  const syntax = new Syntax(
    function (this: Environment, code: SchemeValue, { macro_expand, resolver: useSiteResolver }: MacroInvokeContext) {
      // The use-site Resolver — the EVALUATOR's resolver at expansion time (threaded
      // through Syntax.expand), carrying the run's capability base. NOT a fresh glass
      // `new Resolver(this)`, which under the 3b.3 cut would re-derive a wrong globalRoot
      // from the null-rooted `this`. Its env IS `this` (the expansion env), so the
      // merge-frame plumbing below is unchanged; under glass byte-identical. (D1)
      const useResolver = useSiteResolver ?? new Resolver(this);
      // The def-time syntax-child Resolver: `defResolver.child("syntax")` ≡ `env.inherit("syntax")`.
      // Its env is the hygiene scope, shared by-ref into the merge return below.
      const defChild = defResolver.child("syntax");
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
      let ellipsis, rules, symbols;
      TypeError.invariant(is_pair(macro), "syntax-rules: malformed macro form");
      if (macro.car instanceof ASymbol) {
        ellipsis = macro.car;
        TypeError.invariant(is_pair(macro.cdr), "syntax-rules: malformed macro form");
        symbols = get_identifiers(macro.cdr.car);
        rules = macro.cdr.cdr;
      } else {
        ellipsis = "...";
        symbols = get_identifiers(macro.car);
        rules = macro.cdr;
      }
      try {
        while (is_pair(rules)) {
          TypeError.invariant(is_pair(rules.car), "syntax-rules: malformed rule");
          const rule = rules.car.car;
          TypeError.invariant(is_pair(rules.car.cdr), "syntax-rules: malformed rule");
          // `expr` is a TEMPLATE HANDLE, not a proven SchemeValue: it is the template
          // form read from the rule, fed straight into `transform_syntax` (whose
          // `TransformOptions.expr` is `unknown`) and `restore_data_gensyms` (untyped
          // node). `transform_syntax` also returns `unknown` (its `traverse` yields
          // scheme forms OR intermediate arrays), so the reassignment below is `unknown`
          // → `unknown`. Typing it `unknown` is the honest contract — no `as SchemeValue`.
          let expr: unknown = rules.car.cdr.car;
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
            const new_env = var_scope.merge(defChild.env, Syntax.__merge_env__);
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
    },
    env,
    defResolver,
  );
  syntax.__code__ = macro;
  return syntax;
});

/** scheme/macros — the macro family that carries a JS expander; today, syntax-rules. */
export default new EnvCapability("scheme/macros", {
  symbols: { "syntax-rules": syntaxRulesDef },
});
