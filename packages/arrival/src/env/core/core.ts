// @here.build/arrival/core — the irreducible scheme core pack.
//
// The base-most scheme defs that every other pack expands against: the essential
// constants, the kernel keywords, `gensym`, and the `single` helper. Pure scheme
// (the four `symbol.define` entries below) + native (`gensym`) + keyword markers
// (the 20 special-form aliases) — the precedence floor of the base stdlib, so
// every other base pack (polyglot / r7rs / srfi / …) depends on it.
//
// The syntax-binding forms (define-syntax / let-syntax / letrec-syntax) are NOT
// here — they are guardless R7RS aliases in `env/r7rs/syntax.ts`.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack FIRST (it is the C3
// precedence floor every other BASE_PACKS member sits on), so this module is the
// sole definition site — the same pattern the SRFI / r7rs / polyglot packs
// already follow.
//
// MIGRATED off the text-blob `prelude` (docs/working-proposals/symbol-define-
// static-program-validation.md, wave W4): the FULL inventory, done honestly per
// the task brief's caution against treating a bootstrap pack's keyword table as a
// migration target —
//
//   • KEYWORD-SYNTAX (NOT prelude, NOT a migration target): the 20 `symbol.keyword`
//     entries in `symbols` below — every `SPECIAL_FORMS` entry (evaluator.ts) made
//     first-class, value-carried. These are `KEYWORD_SYNTAX_BASELINE`
//     (`common/symbols/define-bake.ts:91`) itself — the design doc's own §2.1
//     rev2 fix treats this exact set as an UNCONDITIONAL allowlist member for
//     every OTHER capability's bake FV law, precisely because it lives here.
//     Unchanged by this migration; touching it is out of scope by the doc's own
//     accounting (§4.4's residue table never lists `symbols` entries as dying).
//   • ALREADY-MIGRATED: `gensym`, a `symbol.native` — not `prelude:` text, no
//     Pass 1/2 work applies.
//   • THE ACTUAL PRELUDE (4 forms, ~960 lines of the doc's 23-pack census'
//     smallest contributor): `true`/`false`/`NaN` (constants) + `single` (one
//     procedure). NO `define-macro` forms — the doc's "attribute case law"
//     (§3.4's macroAttribute) does not apply to this pack; every migrated entry
//     below is `symbol.define`, none `symbol.defineSyntax`.
//
// THE LIVE CATCH (design doc §2.1's "live catch" class, srfi-43/-235/-189's
// precedent — same bug, found here for the first time in the pack every other
// pack's FV law treats as its OWN unconditional baseline): `single`'s body calls
// `pair?` and `not` — both `scheme/r7rs/equality` exports (`cdr` is the
// resolver-synth `c[ad]+r` family, covered by `define-bake.ts`'s `CXR_RE`
// allowlist branch with NO dep needed). This worked, pre-migration, purely
// because `env-roots.ts`'s two-phase bootstrap (NATIVE_PACKS → global_env, THEN
// BASE_PACKS → user_env) guarantees `scheme/equality` is already bound by the
// time ANY BASE_PACKS prelude runs — equality.ts's OWN `not` doc says so
// explicitly ("This native pack binds onto global_env BEFORE the scheme/core
// prelude that calls `not` at macro-define time"). A RUNTIME guarantee, not a
// declared one — the bake FV law doesn't (and shouldn't) consult it, so `single`
// needed the same fix as every other live catch: `deps: [equality]` below. Named
// loud per the task brief: `scheme/core` is the one capability every base pack
// depends ON — it declaring a dep of its OWN might look backwards, but `equality`
// is a NATIVE_PACKS member (assembled in bootstrap phase 1, `global_env`), never
// a BASE_PACKS array entry (phase 2, `user_env`) — so this is NOT a cycle and
// needs NO `base-packs.ts` repositioning (identical reasoning to srfi-43/-235/
// -189's own `deps: [equality, …]`, `env/srfi/srfi-43.ts`'s header). `core`
// stays the BASE_PACKS precedence floor; its ONE dependency reaches down into
// the OTHER phase, not sideways into a BASE_PACKS sibling.
//
// A SECOND finding, preserved not fixed (§4.2's "semantic equivalence, not
// byte-identity" gate — this migration ports behavior exactly, it does not
// repair it): `single`'s body, `(and (pair? list) (not (cdr list)))`, is
// LIVE-VERIFIED (a direct `exec` probe against the pre-migration pack) to
// return `#f` for EVERY input, including a genuine one-element list — R7RS
// `not` is `#f`-only-falsy (equality.ts's own doc, same comment cited above:
// "only #f is falsy... nil no longer reach[es] here"), so `(cdr '(a))` — the
// nil terminator, NOT `#f` — makes `(not (cdr '(a)))` evaluate to `#f`, not
// `#t`. `single` predates that nil/false split (LIPS heritage, where the two
// were conflated) and was never updated; it has zero call sites anywhere else
// in the codebase (grep-verified) and ships as public vocabulary, not internal
// plumbing. Migrated AS-IS — its contract (`z.value → z.boolean`) validates the
// (always-`#f`) return honestly; fixing the logic is a separate, deliberate
// change this migration does not make.

import { EnvCapability } from "../../common/capability.js";
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { gensym } from "../../reader/values-repr.js";
import equality from "../r7rs/equality.js";

/** The irreducible scheme core pack: constants, kernel keywords, gensym, `single`.
 *  Module-singleton capability; the precedence floor every base pack deps. Its OWN
 *  one dep (`equality`, below) reaches into bootstrap phase 1 (NATIVE_PACKS), never
 *  sideways into a BASE_PACKS sibling — see the file header's "live catch". */
export default new EnvCapability("scheme/core", {
  deps: [equality],
  // `gensym` resolves at macro-EXPANSION time, so binding it on this precedence-floor pack
  // (assembled first among the base packs) reaches every consumer — including user/test
  // scheme that calls `(gensym …)` for hygiene names, and the inference-plane `cut`/`cute`
  // copy in initBridge, which reads `gensym` off the user_env chain post-assembly. Native:
  // the impl is the shared `reader/values-repr` gensym, bound raw.
  symbols: {
    // Kernel KEYWORDS — special forms made first-class (symbol.keyword markers). The
    // evaluator resolves a call head through the env and dispatches SPECIAL_FORMS[name]
    // when it resolves to one of these — so `(define => lambda)` aliases the form and
    // lexical shadowing un-specials it (the dual of cxr; see values/Keyword.ts). The
    // genMacroWrapper define/lambda husks in stdlib.ts global_env are deleted in favor
    // of these. TWO reasons a kernel special form becomes a keyword: (1) first-class
    // value-carried dispatch — `(define => lambda)` aliases the form, the dual of cxr; and
    // (2) the HYGIENE engine resolves a renamed template identifier (`if` → `#:if`) by binding
    // the gensym to the original name's ENV VALUE (syntax-rules.ts rename()) — a name-only
    // special form has no env value, so a USER syntax-rules macro expanding to it could not
    // resolve. cond/case/when/unless stay evaluator SPECIAL FORMS (evalCond/… — TCO-correct,
    // unlike the nested-genRun syntax-rules path), now ALSO keywords so all control forms are
    // uniformly first-class and reachable from macro templates. let* / letrec / letrec* /
    // and / or now follow, keyworded for the same hygiene reason: a syntax-rules template
    // expanding to one of these (e.g. test-numeric-syntax's `(let* (…) …)`) renames the head
    // to a gensym, and only a keyworded form has an env value for rename() to copy onto it.
    // define-macro / do / while / try complete the set (bug batch 2 follow-up) — every
    // SPECIAL_FORMS entry (evaluator.ts) is now a keyword marker, so a hygiene-renamed head
    // can never miss dispatch for lack of a copyable env value. See
    // __tests__/do-while-try-define-macro-hygiene.test.ts for the macro-expansion coverage.
    lambda: symbol.keyword`lambda: create an anonymous procedure`,
    define: symbol.keyword`define: bind a name in the current scope`,
    "define-macro": symbol.keyword`define-macro: define a fexpr-style unhygienic macro`,
    let: symbol.keyword`let: bind locals over a body`,
    "let*": symbol.keyword`let*: bind locals sequentially, each seeing the prior bindings`,
    letrec: symbol.keyword`letrec: bind locals that may reference each other (mutual recursion)`,
    "letrec*": symbol.keyword`letrec*: like letrec, but bindings are evaluated in order`,
    and: symbol.keyword`and: evaluate left to right, short-circuiting on the first false`,
    or: symbol.keyword`or: evaluate left to right, short-circuiting on the first true`,
    if: symbol.keyword`if: conditional — evaluate the consequent or the alternative`,
    begin: symbol.keyword`begin: evaluate a sequence, yield the last`,
    quote: symbol.keyword`quote: the datum, unevaluated`,
    quasiquote: symbol.keyword`quasiquote: a template datum with unquote holes`,
    cond: symbol.keyword`cond: first true test wins; its body (or => application) is the value`,
    case: symbol.keyword`case: dispatch on a key via eqv? datum lists`,
    when: symbol.keyword`when: evaluate the body when the test passes`,
    unless: symbol.keyword`unless: evaluate the body when the test fails`,
    do: symbol.keyword`do: iterate stepped bindings until the test clause is true`,
    while: symbol.keyword`while: iterate the body while the test evaluates truthy`,
    try: symbol.keyword`try: body with an optional catch/finally handler`,
    // Contract mirrors gensym's real signature so the raw function binds cast-free:
    // the optional name hint is a raw symbol NAME (string/symbol/number), an ASymbol
    // wrapper, or null — NOT a boxed SchemeValue (gensym predates the union and threads
    // raw names). Output is the freshly-minted ASymbol.
    // `type`: `z.symbol` IS a registered leaf (schema-to-ts.ts's IMAGE_BY_NAME maps it to a
    // string image), so the harvest wouldn't degrade to the catch-all here. The explicit
    // `type:` still pins the exact model-facing shape: an optional string name hint in, a
    // fresh symbol (string image) out.
    gensym: symbol.native`gensym: a fresh uninterned symbol (optional name hint)`(
      {
        input: [z.symbol.optional()],
        output: [z.symbol],
        type: "(name?: string) => string",
      },
      gensym,
    ),

    // ── §4.2 Pass 1/2 decomposition of the former `prelude` text blob — 4 forms,
    // 1:1 off the original `(define true #t)` / `(define false #f)` /
    // `(define NaN +nan.0)` / `(define (single list) …)`. See the file header for
    // the `equality` dep this decomposition surfaced and the pre-existing `single`
    // bug it preserves rather than fixes. ──────────────────────────────────────

    // Essential constants. Both CONSTANT defines (§1.2: a bare ZodType contract,
    // not a Contract<I,O> record) — `z.boolean` validates the literal ONCE at
    // bake, then binds the plain value (no call-boundary wrapper; there is no
    // call boundary).
    true: symbol.define`true: the canonical scheme boolean truth constant`(z.boolean, `#t`),
    false: symbol.define`false: the canonical scheme boolean falsity constant`(z.boolean, `#f`),
    // `+nan.0` is a non-finite R7RS inexact real. `z.number`/`z.inexact` are the
    // STRICT rosetta-boundary codecs — both bottom out in bare zod's `z.number()`,
    // which EXCLUDES NaN/±Infinity (scheme-zod.ts's own documented finding,
    // confirmed against zod 4.3.6) — so either would throw at BAKE, decoding this
    // very constant. `z.looseNumber` is the permissive codec built for exactly
    // this domain (scheme-zod.ts: "permissive of non-finite values — +nan.0/
    // +inf.0/-inf.0 pass through AInexact's .real unchanged") — the honest
    // contract for a constant whose entire point is to BE non-finite.
    NaN: symbol.define`NaN: the canonical scheme not-a-number constant (+nan.0), a non-finite inexact real`(
      z.looseNumber,
      `+nan.0`,
    ),

    // Helper for macro-authoring bodies. `list` is genuinely any scheme value —
    // `pair?` (r7rs/equality, a declared dep) answers gracefully for a non-pair,
    // so `z.value` (representation-blind) is the honest input, matching
    // `pair?`/`null?`'s own type-predicate convention (equality.ts). Output is
    // always a real ABool (the whole body is an `and` of two boolean-returning
    // calls) — `z.boolean`. `cdr` needs no declared dep: the resolver-synth
    // `c[ad]+r` family (define-bake.ts's `CXR_RE`) covers it; `pair?`/`not` DO
    // need `equality` (the file header's live catch).
    single: symbol.define`single: #t iff list is a pair whose cdr is itself #f (helper for macro-authoring bodies — see the file header: this predates the nil/false split and is always #f on a real one-element list, preserved as-is, not fixed)`(
      { input: [z.value], output: [z.boolean] },
      `(lambda (list) (and (pair? list) (not (cdr list))))`,
    ),
  },
});
