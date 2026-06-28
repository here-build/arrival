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

import { is_nil } from "./eval/guards.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import { printValue } from "./values/print.js";
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

import { ABool } from "./values/primitives/ABool.js";
import { collapseProvenance, taintString } from "./provenance-collapse.js";


// Type definitions for dynamic Scheme values
// Scheme is inherently dynamic - these use `any` intentionally for interpreter interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemeValue = any;

// -------------------------------------------------------------------------

// Dev-only structured tracer for the syntax-rules expander. Gated by the per-run
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

// The value→string printer dissolved into the per-value `["arrival/print"]()` protocol
// (values/print.ts: `printValue` dispatches, each AValue self-renders, the leaf handles the
// non-AValue residual). `repr` below calls `printValue` directly — there is no printer module.

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
    // `syntax-rules` relocated to env/macros.ts (scheme/macros pack), bound via the new
    // symbol.macro def-kind — the last macro-family member out of this husk blob.
    // ------------------------------------------------------------------
    // `list` relocated to env/r7rs/lists.ts (R7RS §6.4, next to cons/make-list).
    repr: function repr(obj) {
      return printValue(obj);
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


// NOTE: Numeric operations from bridge.ts should be applied by calling initBridge()
// This cannot be done at module load time due to circular dependency
// See: src/bridge.ts initBridge()

// The `:key` keyword accessor is owned by the scheme/polyglot capability (its
// `resolvers`); global_env no longer registers it directly (remove-and-check —
// nothing resolves a `:key` at bare global_env, the gate confirms).

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
