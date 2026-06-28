/**
 * Forked from LIPS.js - Scheme-based Lisp interpreter
 * Copyright (c) 2018-2024 Jakub T. Jankiewicz <https://jcubic.pl/me>
 * Released under the MIT license
 * https://github.com/jcubic/lips
 */
import invariant from "tiny-invariant";
import { CONSTANT_CTX } from "./values/primitives/RunContext.js";
import { withInputProvenance } from "./values/op-helpers.js";
import { Environment, type EnvironmentValue } from "./Environment.js";
import { global_env, user_env } from "./env-roots.js";
import { eof } from "./values/primitives/EOF.js";
import { Lexer } from "./reader/Lexer.js";

import {
  is_nil,
  is_plain_object,
} from "./eval/guards.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import { restore_data_gensyms, extract_patterns, transform_syntax } from "./eval/syntax-rules.js";
import { toString, map_object, symbolize } from "./printer.js";
import {
  complex_bare_re,
  complex_re,
  float_re,
  int_bare_re,
  int_re,
  rational_bare_re,
  rational_re,
} from "./values/primitives.js";
import { nil } from "./values/primitives/ANil.js";
import * as specials from "./reader/specials.js";
import { type, typecheck, typeErrorMessage } from "./utils/typecheck.js";
import { parse_complex, parse_float, parse_integer, parse_rational } from "./utils/parsing.js";
import { Values } from "./values/primitives/Values.js";
import { Macro } from "./eval/Macro.js";
import { Syntax } from "./eval/Syntax.js";

import { ABool } from "./values/primitives/ABool.js";
import { keywordAccessorResolver } from "./membrane.js";
import { collapseProvenance, taintString } from "./provenance-collapse.js";


// Type definitions for dynamic Scheme values
// Scheme is inherently dynamic - these use `any` intentionally for interpreter interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemeValue = any;

// -------------------------------------------------------------------------

// Dev-only structured tracer for the syntax-rules expander. Gated by the per-run
// `debug` interpreter option (RunContext.debug) — threaded to the expander via the
// macro invoke's runCtx, NOT a Scheme `DEBUG` variable and NOT module debug-state, so
// it is inert by default and hermetic across concurrent runs. Mirrors the console API
// so traces NEST (group/groupEnd) and are TIMED; `debugFmt` renders SchemeValues with
// full depth, JS-string args passing through as labels.
/* c8 ignore start */
let debugSeq = 0;
function debugFmt(x: SchemeValue): unknown {
  return typeof x === "string"
    ? x
    : is_plain_object(x)
      ? map_object(x, (value: SchemeValue) => toString(value, true))
      : toString(x, true);
}
// `makeDebugTracer(on)` returns the tracer the expander uses; `on` is this run's
// RunContext.debug. Off ⇒ every method is a no-op, so the expander stays silent.
function makeDebugTracer(on: boolean) {
  return {
    log: (...args: SchemeValue[]): void => {
      if (on) console.log(...args.map(debugFmt));
    },
    dir: (x: unknown): void => {
      if (on) console.dir(x, { depth: null });
    },
    group: (label: SchemeValue): void => {
      if (on) console.group(debugFmt(label));
    },
    groupEnd: (): void => {
      if (on) console.groupEnd();
    },
    time: (label: string): void => {
      if (on) console.time(label);
    },
    timeEnd: (label: string): void => {
      if (on) console.timeEnd(label);
    },
  };
}
/* c8 ignore stop */

// symbol_to_string relocated to printer.ts (used only by its function_to_string).

// ----------------------------------------------------------------------
specials.on(["remove", "append"], function () {
  Lexer._cache.valid = false;
  Lexer._cache.rules = null;
});

// reader machinery (tokenize / tokens / _parse) lives in reader/ leaves now.

// Re-export unpromise from utils/promises
export { unpromise } from "./utils/promises.js";

// `matcher` relocated to env/arrival-extensions.ts (with `find`, its only user).

// `to_array` / `list->array` / `isProperList` / `mapImpl` relocated to env/r7rs/lists.ts
// alongside `for-each` (their last stdlib user). The pack carries its own byte-identical
// to_array/listToArray/isProperList; mapImpl moved verbatim.

// Old Pair prototype methods are now in the Pair class above

// The value→string printer — `toString`, its repr registry (get_instances /
// get_native_types / user_repr / function_to_string / the `repr` map + str_mapping),
// plus `symbolize` and the `unbox` / `map_object` helpers — relocated to printer.ts.
// It is a top-level module beside stdlib (it must know every printable type, incl.
// Environment/Macro/Values, so it is not a values/ leaf); imported above for the
// builtins/tracer that print. Never exported, so it is not on the public barrel.

// ----------------------------------------------------------------------
// eq/eqv moved to structural-equal.ts; the macro engine (macro_expand /
// extract_patterns / restore_data_gensyms / transform_syntax / self_evaluated)
// moved to syntax-rules.ts (keystone K3) and is imported above.
// ----------------------------------------------------------------------

// ----------------------------------------------------------------------
// :: Function utilities
// ----------------------------------------------------------------------
// box() relocated to reader/values-repr.ts (the value-representation leaf,
// alongside quote/patch_value); imported above. Re-exported below for the barrel.

// ----------------------------------------------------------------------
// patch_value relocated to reader/values-repr.ts; re-exported to preserve the
// public barrel surface (mirrors the quote re-export below).
export { box, patch_value } from "./reader/values-repr.js";

// ----------------------------------------------------------------------
// :: Stub macros for let/let*/letrec - generator evaluator handles these as special forms
// :: These stubs exist only for LIPS evaluate compatibility during bootstrap
// ----------------------------------------------------------------------
// let_macro removed — let/let*/letrec/letrec* now delegate to generator evaluator via genMacroWrapper

// -------------------------------------------------------------------------
// :: Quote function used to pause evaluation from Macro
// -------------------------------------------------------------------------
// quote moved to values-repr.ts; re-exported here to preserve the public barrel.
export { quote } from "./reader/values-repr.js";

// `get` (the LIPS dot-notation accessor) + `native_lambda` (its `__code__` "[native
// code]" stub) DELETED — vestigial host-interop infra, NOT R7RS/SRFI. The `.` / `get`
// Scheme verbs were removed in the host-language sweep; Scheme reaches host data only via
// the polyglot `@`/`@?`/`@keys`/`:key` membrane reads, and Environment.get's dotted
// resolution calls accessMember (interop-access) directly. Neither had any runtime caller.

const internal_env = new Environment(
  "internal",
  {
    // those will be compiled by babel regex plugin
    "letter-unicode-regex": /\p{L}/u,
    "numeral-unicode-regex": /\p{N}/u,
    "space-unicode-regex": /\s/u,
  },
  undefined,
);
// ----------------------------------------------------------------------

const is_node = () => typeof process === "object" && !!process.env;

// -------------------------------------------------------------------------
// :: Thin wrapper: delegates a special form to the generator evaluator.
// :: LIPS evaluate dispatches to these Macros, which hand off to the
// :: generator's evaluate + run. This lets us delete the complex,
// :: poorly-typed LIPS Macro implementations for forms the generator
// :: already handles correctly.
// -------------------------------------------------------------------------
// genMacroWrapper removed — define/lambda are kernel keywords (symbol.keyword markers)
// on scheme/core; the evaluator dispatches them by resolved-marker value, no husk needed.

// -------------------------------------------------------------------------
// The native root's inline builtins. `global_env` is created EMPTY in the env-roots
// leaf so the evaluator entry + bridge can source the root without importing this
// monolith; we register the builtins onto it HERE, at the same module-load point the
// constructor used to occupy. `Object.assign` onto `__env__` is the faithful
// equivalent of the old `new Environment("global", {...})` — the ctor stores
// `__env__` and runs no logic, so the resulting binding set is byte-identical.
Object.assign(global_env.__env__, {
    undefined, // undefined as parser constant breaks most of the unit tests
    // ------------------------------------------------------------------
    // Spec §5.3 car/cdr element-only provenance.
    //
    // War story: previously `withInputProvenance([list], list.car)` unioned
    // the *container*'s provenance into the *element*'s — so `(car xs)`
    // returned a value stamped with every id that contributed to xs, even
    // those carried by sibling cdr elements or the spine itself. That violates
    // the spec §5.3 rule that car/cdr are *projections*: the result inherits
    // ONLY the element's own provenance, not the container's. The audit
    // surfaced this as the algebra gap behind a class of phantom-contributor
    // attributions in downstream consumers.
    //
    // Fix: pass `list.car` (resp. `list.cdr`) as the single provenance input.
    // - If element is an AValue, `withInputProvenance` re-stamps with its own
    //   provenance (effectively a no-op clone — preserves element identity).
    // - If element is raw JS (string/bool/number), `withInputProvenance`
    //   skips work because `inputs.length === 0`; the element is returned
    //   unchanged, which is correct because raw values have no container-
    //   borrowed provenance to incorrectly carry.
    //
    // `cons`, `list`, and `length` are CONSTRUCTORS / aggregations, not
    // projections — they correctly retain `withInputProvenance([car, cdr], …)`
    // unioning over all inputs.
    // `dict` relocated to env/polyglot.ts (the Scheme companion to its `:key` accessor).
    // ------------------------------------------------------------------
    // set-car! / set-cdr! / append! — OMITTED by the purity invariant (every
    // entity is frozen by design). Doored in r7rs/lists. See plan-2026-06-11.
    // set! / do / if / letrec / letrec* / let* / let / begin / parameterize —
    // VESTIGIAL global_env registrations of forms the evaluator's SPECIAL_FORMS
    // table already shadows before env lookup (parameterize is doored in r7rs/control).
    // Deleted: no first-class lookup reaches them, and macro_expand's traverse
    // only special-cases `lambda`/`define` by identity (the `let` family by name),
    // so the bindings are unreferenced. See husk-dissolution pass.
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // define / lambda — now KERNEL KEYWORDS (symbol.keyword markers) on the
    // scheme/core pack (env/core/core.ts), NOT genMacroWrapper husks here. The
    // evaluator resolves a call head through the env and dispatches on the marker
    // VALUE (SPECIAL_FORMS[kw.name]) — so special-ness travels with the value:
    // `(define => lambda)` aliases the marker, lexical shadowing un-specials it,
    // and macro_expand's `value === env.get("lambda")` identity check resolves to
    // the same marker by inheritance. No first-class husk needed here.
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // define-macro — VESTIGIAL: shadowed by the `define-macro` SPECIAL_FORM
    // (evalDefineMacro) before env lookup; no first-class reader. Deleted.
    // ------------------------------------------------------------------
    "syntax-rules": new Macro("syntax-rules", function (this: Environment, macro: SchemeValue, options: SchemeValue) {
      const { use_dynamic, error } = options;
      // TODO: find identifiers and freeze the scope when defined #172
      const env = this;

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
      const syntax = new Syntax(function (this: Environment, code: SchemeValue, { macro_expand, runCtx }: SchemeValue) {
        const debug = makeDebugTracer(runCtx?.debug === true);
        const trace = `syntax-expand #${++debugSeq}`;
        debug.group(code);
        debug.time(trace);
        debug.log("macro:", macro);
        const scope = env.inherit("syntax");
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
            debug.log("try rule:", rule);
            const bindings = extract_patterns(rule, code, symbols, ellipsis, {
              expansion: this,
              define: env,
              globalEnv: global_env,
            });
            if (bindings) {
              debug.group("match");
              debug.dir(symbolize(bindings));
              debug.log("pattern:", rule);
              debug.log("macro:", code);
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
              debug.log("output:", new_expr);
              debug.groupEnd();
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
          (error_ as Error).message += `\nin macro:\n  ${macro.toString(true)}`;
          throw error_;
        } finally {
          // Balances `debug.group(code)` opened at entry on every exit path — the two
          // returns and the catch-rethrow all run this; the no-match `throw` below is
          // reached only after `finally`, so its group is already closed.
          debug.timeEnd(trace);
          debug.groupEnd();
        }
        throw new Error(`syntax-rules: no matching syntax in macro ${code.toString(true)}`);
      }, env);
      (syntax as SchemeValue).__code__ = macro;
      return syntax;
    }),
    // ------------------------------------------------------------------
    // `list` relocated to env/r7rs/lists.ts (R7RS §6.4, next to cons/make-list).
    repr: function repr(obj, quote) {
      return toString(obj, quote);
    },
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // `vector` and `vector-append` live in bridge.ts (wrappedOps), minting boxed
    // SchemeVector. The former stdlib `vector` here was DEAD (initBridge applies
    // wrappedOps over global_env after stdlib builds, so bridge's always won) AND
    // wrong (it typecheck'd args as numbers — non-R7RS). Removed (boxing S7, R11).
    // ------------------------------------------------------------------
    // `find` relocated to env/arrival-extensions.ts (SRFI-1 + arrival regex extension).
    // `for-each` relocated to env/r7rs/lists.ts (R7RS §6.4, alongside map + its mapImpl).
  } satisfies Record<string, EnvironmentValue>);
export { global_env, user_env as env };

// -------------------------------------------------------------------------
function set_interaction_env(interaction, internal) {
  interaction.constant("**internal-env**", internal);
  interaction.doc(
    "**internal-env**",
    `**internal-env**

         Constant used to hide stdin, stdout and stderr so they don't interfere
         with variables with the same name. Constants are an internal type
         of variable that can't be redefined, defining a variable with the same name
         will throw an error.`,
  );
}

// -------------------------------------------------------------------------
set_interaction_env(user_env, internal_env);

// NOTE: Numeric operations from bridge.ts should be applied by calling initBridge()
// This cannot be done at module load time due to circular dependency
// See: src/bridge.ts initBridge()

// -------------------------------------------------------------------------
// The `:key` keyword accessor — a catchall sibling to c[ad]+r. Registered on
// global_env here (and on the inference env in inference-env.ts). Owned by the
// polyglot capability.
global_env.registerResolver(keywordAccessorResolver);

// -------------------------------------------------------------------------
// `exec` is the single canonical generator-trampoline entry — it lives in
// eval/generator-exec.ts (one bootstrap gate + budget/heap/signal bounds + the
// audit-#42 wrapOperator/TypeError surfacing, all in one place). The old
// stdlib-local `exec`/`exec_with_stacktrace` wrappers — and the legacy recursive
// `evaluate` they once drove — are gone; every evaluation now runs on
// evaluator.ts. Re-exported here so the historical `from "./stdlib"` consumers
// keep resolving.
export { exec } from "./eval/generator-exec.js";

// -------------------------------------------------------------------------


// Additional exports needed by Environment.ts
export { eof } from "./values/primitives/EOF.js";
