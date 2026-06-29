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
import { global_env } from "./env-roots.js";
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
// box() / patch_value / quote relocated to reader/values-repr.ts (the value-representation
// leaf). They are surfaced on the package barrel directly from that leaf by src/index.ts —
// no longer laundered through this module.

// ----------------------------------------------------------------------
// :: Stub macros for let/let*/letrec - generator evaluator handles these as special forms
// :: These stubs exist only for LIPS evaluate compatibility during bootstrap
// ----------------------------------------------------------------------
// let_macro removed — let/let*/letrec/letrec* now delegate to generator evaluator via genMacroWrapper

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
// The native root's inline-builtin `Object.assign` is GONE. Its last surviving
// entry, `repr`, moved to the scheme/equality pack (env/r7rs/equality.ts) — the
// home for value-domain-agnostic natives relocated out of this husk; everything
// else had already migrated to a pack (the block was pure comments around it).
// `global_env` is created EMPTY in env-roots.ts and is now populated ENTIRELY by
// the assembled capability packs (NATIVE_PACKS / BASE_PACKS via assembleEnv), so
// this module no longer mutates it at load — the last module-eval side-effect here
// is dissolved. global_env / user_env are sourced from env-roots.ts directly by the
// package barrel + inference-env; this module is not their home.


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
// evaluator.ts. The package barrel surfaces `exec` directly from generator-exec;
// it is no longer re-exported through this module.
// -------------------------------------------------------------------------
