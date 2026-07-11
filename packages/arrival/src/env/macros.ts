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
import { bindValue, AmbientRuntime, mintFrame } from "../AmbientRuntime.js";
import { extract_patterns, restore_data_gensyms, transform_syntax } from "../eval/syntax-rules.js";
import { is_nil } from "../values/value-guards.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { APair } from "../values/primitives/APair.js";
import { Resolver } from "../eval/Resolver.js";
import type { MacroInvokeContext } from "../eval/Macro.js";
import type { SchemeValue } from "../values/types.js";
import { ANil } from "../values/primitives/ANil.js";

// The syntax-rules transformer-constructor. Invoked as `(syntax-rules (literals) (pattern
// template)…)` → returns a Syntax that rewrites a matching form via the engine. `this` is the
// define-syntax invocation env; global_env supplies the hygiene identity root.

/** scheme/macros — the macro family that carries a JS expander; today, syntax-rules. */
export default new EnvCapability("scheme/macros", {
  symbols: {
    "syntax-rules": symbol.macro`syntax-rules`(function (
      this: AmbientRuntime,
      macro: SchemeValue,
      // `resolver` is the EVALUATOR's resolver at define-syntax time (threaded through
      // Macro.invoke), carrying the run's capability base. (D2)
      { use_dynamic, error, resolver: defSiteResolver }: MacroInvokeContext,
    ) {
      // TODO: find identifiers and freeze the scope when defined #172

      // The def-time Resolver — scope = the define-syntax env (the hygiene identity
      // root), capabilities = the EVALUATOR's threaded base (NOT re-derived from `env`
      // via chainRoot: `env` is null-rooted at expansion time, so chainRoot would
      // return the lexical root, not the base, and `globalRoot` would be wrong). Under
      // glass `defSiteResolver.capabilities` and `new Capabilities(env)` share the same
      // `globalRoot` (global_env), so this is byte-identical.
      const defResolver = new Resolver(this, defSiteResolver?.capabilities);

      function get_identifiers(node: unknown) {
        // `node` is typed `unknown` — the honest contract for an arbitrary datum (and for
        // `APair.car`'s default). The walk narrows internally with the slot-typed `is_pair`
        // shadow, so `node.car` / `node.cdr` descend as scheme values with no per-site cast.
        // Collects the unwrapped identifier NAMES (string | symbol from each ASymbol's
        // valueOf), consumed downstream as a name-list via `.includes`.
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
          // `runCtx` is the EXPANDING run's live context (threaded through Syntax.expand
          // from the evaluator's is_macro dispatch) — expansion runs live and its minted
          // cells charge THAT run's meter, never the defining run's (the constant-ctx
          // audit's §2.1 ruling: expansion output is NOT parse-ctx territory).
          { macro_expand, resolver: useSiteResolver, runCtx }: MacroInvokeContext,
        ) {
          // The use-site Resolver — the EVALUATOR's resolver at expansion time (threaded
          // through Syntax.expand), carrying the run's capability base. NOT a fresh glass
          // `new Resolver(this)`, which would re-derive a wrong globalRoot from the
          // null-rooted `this`. Its env IS `this` (the expansion env), so the
          // merge-frame plumbing below is unchanged; under glass byte-identical.
          const useResolver = useSiteResolver ?? new Resolver(this);
          // The def-time syntax-child Resolver: `defResolver.child("syntax")` ≡ a `mintFrame(env, "syntax")` child.
          // Its env is the hygiene scope, shared by-ref into the merge return below.
          const defChild = defResolver.child("syntax");
          // for macros that define variables used in macro (2 levels nestting): if `this` is itself a
          // merge frame (from an outer expansion), copy its symbol-keyed gensyms up into the parent and
          // unwrap. Routed through the LexicalScope surface (kind/ownSymbolEntries/parent) + the internal bindValue — a
          // byte-identical pass-through over the env today.
          let useScope = useResolver.scope;
          if (useScope.kind === "merge") {
            for (const [sym, value] of useScope.ownSymbolEntries()) {
              bindValue(useScope.parent!.env, sym, value);
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
              // `expr` is a TEMPLATE HANDLE, not a proven SchemeValue: it is the template
              // form read from the rule, fed straight into `transform_syntax` (whose
              // `TransformOptions.expr` is `unknown`) and `restore_data_gensyms` (untyped
              // node). `transform_syntax` also returns `unknown` (its `traverse` yields
              // scheme forms OR intermediate arrays), so the reassignment below is `unknown`
              // → `unknown`. Typing it `unknown` is the honest contract — no `as SchemeValue`.
              let expr: unknown = rules.car.cdr.car;
              const bindings = extract_patterns(rule, code, symbols, ellipsis, {
                // Hygiene-identity handles: use-site Resolver, the captured def Resolver, and its
                // capabilities (globalRoot = the unshadowed-base identity).
                useResolver,
                defResolver,
                capabilities: defResolver.capabilities,
                // The live run's ctx — matcher accumulation mints through the engine's
                // metered mint door.
                ctx: runCtx,
              });
              if (bindings) {
                // name is modified in transform_syntax
                const names = [];
                const new_expr = transform_syntax({
                  bindings,
                  // `expr` stays `unknown` above (the reassignment loop's honest contract);
                  // transform_syntax's own domain is SchemeValue — assert at this ONE call
                  // boundary rather than widening the reassignment's deliberate unknown.
                  expr: expr as SchemeValue,
                  symbols,
                  scope: defChild,
                  names,
                  ellipsis,
                  ctx: runCtx,
                });
                // TODO: if expression is undefined throw an error
                if (new_expr) {
                  expr = new_expr;
                }
                const new_env = mintFrame(var_scope, Syntax.__merge_env__, defChild.env.__env__);
                // FORM-RETURNING (always): hand back the transcribed FORM + its hygiene scope.
                // The evaluator yields this form into the flat trampoline (tail position) and the
                // macroexpand traverse re-expands it — the transformer NEVER evaluates inside
                // itself, so a macro in tail position stays tail-proper (no nested run() frame).
                // restore_data_gensyms un-renames the template's DATA-position gensyms (under
                // quote/quasiquote) so quote yields literal symbols with no post-eval fixup.
                // `macro_expand` no longer changes the return — both callers want the form.
                void macro_expand;
                return { expr: restore_data_gensyms(expr, names, runCtx), scope: new_env };
              }
              rules = rules.cdr;
            }
          } catch (error_) {
            (error_ as Error).message += `\nin macro:\n  ${macro.toString()}`;
            throw error_;
          }
          throw new Error(`syntax-rules: no matching syntax in macro ${code.toString()}`);
        },
        this,
        defResolver,
      );
      syntax.__code__ = macro;
      return syntax;
    }),
  },
});
