// scheme/macros — the macro family that carries a JS expander; today, syntax-rules.
//
// syntax-rules binds via `symbol.macro`: a non-evaluating form carrying a raw JS
// transformer. No other symbol kind fits — `keyword` dispatches to the evaluator,
// `native`/`rosetta` evaluate their args, prelude is scheme source. The
// hygienic-expansion ENGINE stays a leaf (eval/syntax-rules.ts); the generic
// `is_macro`/`is_syntax` eval hook is untouched. define-syntax / let-syntax
// (scheme/core) resolve `syntax-rules` from the assembled env.
//
// The transformer-constructor is invoked as `(syntax-rules (literals) (pattern
// template)…)` → returns a Syntax that rewrites a matching form via the engine.
// `this` is the define-syntax invocation env.
import { EnvCapability } from "../../common/capability.js";
import { Syntax } from "../../eval/Syntax.js";
import { AmbientRuntime } from "../AmbientRuntime.js";
import { restore_data_gensyms } from "../../eval/syntax-rules.js";
import { extract_patterns } from "../../eval/syntax-rules/match.js";
import { transform_syntax } from "../../eval/syntax-rules/transcribe.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { APair } from "../../values/primitives/APair.js";
import { SyntaxRulesError } from "../../eval/syntax-rules/error.js";
import { ArrivalError, EvalError, isHostRuntimeBug } from "../../errors.js";
import { Resolver } from "../../eval/Resolver.js";
import type { LexicalScopeWithInternals } from "../../eval/LexicalScope.js";
import type { TransformerArgs } from "../../eval/Macro.js";
import type { SchemeValue } from "../../values/types.js";
import { ANil } from "../../values/primitives/ANil.js";

/** Source location of a macro USE (a bare atom form carries none). */
function useSiteLocation(code: SchemeValue) {
  return code instanceof APair ? code.location : undefined;
}

/** The macro's rule patterns as written — what the "no matching syntax" door teaches. */
function ruleShapes(macro: SchemeValue): string {
  const shapes: string[] = [];
  let rules: SchemeValue = macro instanceof APair ? macro.cdr : macro;
  if (macro instanceof APair && macro.car instanceof ASymbol && macro.cdr instanceof APair) rules = macro.cdr.cdr;
  for (; rules instanceof APair; rules = rules.cdr) {
    if (rules.car instanceof APair) shapes.push(rules.car.car.toString());
  }
  return shapes.join(" | ");
}

export default EnvCapability.define("scheme/macros", {
  symbols: (symbol) => ({
    "syntax-rules": symbol.macro`syntax-rules`(function (
      this: AmbientRuntime,
      macro: SchemeValue,
      // `resolver` is the evaluator's resolver at define-syntax time (threaded through
      // Macro.invoke), carrying the run's capability base.
      { resolver: defSiteResolver }: TransformerArgs,
    ) {
      // deferred: freeze def-scope identifiers at definition time.
      // Def-time Resolver: define-syntax env is the hygiene identity root; capabilities
      // from the evaluator's threaded base. Not chainRoot(this) — expansion env is
      // null-rooted, so chainRoot would yield the lexical root, not the base.
      const defResolver = new Resolver(this, defSiteResolver?.capabilities);

      function get_identifiers(node: unknown) {
        // Returns unwrapped identifier NAMES (ASymbol.valueOf), consumed downstream via `.includes`.
        const symbols: unknown[] = [];
        while (node instanceof APair) {
          const x = node.car;
          symbols.push(x.valueOf());
          node = node.cdr;
        }
        return symbols;
      }

      function validate_identifiers(node) {
        while (!(node instanceof ANil)) {
          const x = node.car;
          TypeError.invariant(x instanceof ASymbol, "syntax-rules: wrong identifier");
          node = node.cdr;
        }
      }

      TypeError.invariant(macro instanceof APair, "syntax-rules: malformed macro form");
      if (macro.car instanceof ASymbol) {
        TypeError.invariant(macro.cdr instanceof APair, "syntax-rules: malformed macro form");
        validate_identifiers(macro.cdr.car);
      } else {
        validate_identifiers(macro.car);
      }
      const syntax = new Syntax(
        function (
          this: AmbientRuntime,
          code: SchemeValue,
          // `runCtx` is the EXPANDING run's live context (threaded through Syntax.expand):
          // expansion's minted cells charge THAT run's meter, never the defining run's.
          { macro_expand, resolver: useSiteResolver, runCtx }: TransformerArgs,
        ) {
          // Use-site Resolver: the evaluator's resolver at expansion time. NOT a fresh
          // `new Resolver(this)`, which would re-derive a wrong globalRoot from the null-rooted
          // `this`. Its env IS `this` (the expansion env).
          const useResolver = useSiteResolver ?? new Resolver(this);
          // defChild.env is the hygiene scope, shared by-ref into the merge return below.
          const defChild = defResolver.child("syntax");
          // Nested (2-level) expansion: if `this` is itself a merge frame from an outer
          // expansion, copy its symbol-keyed gensyms up into the parent and unwrap.
          let useScope = useResolver.scope;
          if (useScope.kind === "merge") {
            const parent = useScope.parent as LexicalScopeWithInternals;
            for (const [sym, value] of useScope.ownSymbolEntries()) {
              // Evaluator-frame-family write, not an assembly write (hermeticity audit P6):
              // this hoists an already-hygienic gensym binding one merge-frame up during
              // expansion, the same family as define/let/lambda frame binds — it just
              // happens to be authored from an env pack file rather than eval/. See
              // AmbientRuntime.ts's `.bind` preamble (S2a) for the family census this
              // site is counted in.
              parent.env.bind(sym, value);
            }
            useScope = useScope.parent!;
          }
          const var_scope: AmbientRuntime = useScope.env;
          let ellipsis, rules, symbols;
          TypeError.invariant(macro instanceof APair, "syntax-rules: malformed macro form");
          if (macro.car instanceof ASymbol) {
            ellipsis = macro.car;
            TypeError.invariant(macro.cdr instanceof APair, "syntax-rules: malformed macro form");
            symbols = get_identifiers(macro.cdr.car);
            rules = macro.cdr.cdr;
          } else {
            ellipsis = "...";
            symbols = get_identifiers(macro.car);
            rules = macro.cdr;
          }
          try {
            while (rules instanceof APair) {
              TypeError.invariant(rules.car instanceof APair, "syntax-rules: malformed rule");
              const rule = rules.car.car;
              TypeError.invariant(rules.car.cdr instanceof APair, "syntax-rules: malformed rule");
              let expr: SchemeValue = rules.car.cdr.car;
              const bindings = extract_patterns(rule, code, symbols, ellipsis, {
                // capabilities' globalRoot is the unshadowed-base hygiene identity.
                useResolver,
                defResolver,
                capabilities: defResolver.capabilities,
              });
              if (bindings) {
                const names = []; // transform_syntax appends the renamed template names
                const new_expr = transform_syntax({
                  bindings,
                  expr,
                  symbols,
                  scope: defChild,
                  names,
                  ellipsis,
                  ctx: runCtx,
                });
                // deferred: a template that expands to nothing (falsy new_expr) is silently
                // skipped here, keeping the prior expr. R7RS does not mandate an error for an
                // empty expansion; revisit if a real macro surfaces a confusing silent skip.
                if (new_expr) {
                  expr = new_expr;
                }
                const new_env = var_scope.child(Syntax.__merge_env__, defChild.env.__env__);
                // Form-returning (always): hand back the transcribed FORM + its hygiene scope.
                // The evaluator re-expands it in tail position — the transformer NEVER evaluates
                // inside itself, so a macro in tail position stays tail-proper (no nested run()
                // frame). restore_data_gensyms un-renames DATA-position gensyms (under
                // quote/quasiquote) so quote yields literal symbols with no post-eval fixup.
                void macro_expand;
                return { expr: restore_data_gensyms(expr, names, runCtx), scope: new_env };
              }
              rules = rules.cdr;
            }
          } catch (error_) {
            // Engine rejections become the syntax-rules door: an ArrivalError carrying the
            // hint and the USE-SITE location. Doors that are already ArrivalErrors (budget,
            // meter) and host-runtime defects pass through untouched.
            if (!(error_ instanceof Error) || error_ instanceof ArrivalError || isHostRuntimeBug(error_)) throw error_;
            throw new SyntaxRulesError(error_.message, {
              hint: error_ instanceof EvalError ? error_.hint : undefined,
              location: useSiteLocation(code),
              macro: macro.toString(),
              cause: error_,
            });
          }
          throw new SyntaxRulesError(`syntax-rules: no matching syntax in macro ${code.toString()}`, {
            hint: `this macro accepts: ${ruleShapes(macro)}`,
            location: useSiteLocation(code),
          });
        },
        this,
        defResolver,
      );
      syntax.__code__ = macro;
      return syntax;
    }),
  }),
});
