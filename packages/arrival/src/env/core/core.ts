// @here.build/arrival/core — the irreducible scheme core pack.
//
// The base-most scheme defs that every other pack expands against: the essential
// constants, the kernel keywords, and `gensym`. Pure scheme (the three
// `symbol.define` constants below) + native (`gensym`) + keyword markers
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
// KEYWORD-SYNTAX — the 20 `symbol.keyword` entries in `symbols` below, every
// `SPECIAL_FORMS` entry (evaluator.ts) made first-class and value-carried — are
// `KEYWORD_SYNTAX_BASELINE` (`common/symbols/define-bake.ts`) itself: an
// UNCONDITIONAL allowlist member for every OTHER capability's bake free-variable
// check, precisely because it lives here. `gensym` is the one native binding.
// `true`/`false`/`NaN` are the only pure-scheme constants this pack defines — no
// `define-macro` forms live here.
//
// `scheme/core` has no `deps`: it is dep-free by construction, the clean
// precedence floor every other base pack composes against. (A `single`
// predicate once lived here and pulled in `equality` for `pair?`/`not` — a
// LIPS-heritage, non-SRFI/non-R7RS predicate with an always-`#f` body that
// predated the nil/false split and had zero call sites; removing it as dead
// code restored the dep-free floor.)

import { EnvCapability } from "../../common/capability.js";
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { gensym } from "../../reader/values-repr.js";

/** The irreducible scheme core pack: constants, kernel keywords, gensym.
 *  Module-singleton capability; the dep-free precedence floor every base pack deps. */
export default new EnvCapability("scheme/core", {
  // `gensym` resolves at macro-EXPANSION time, so binding it on this precedence-floor pack
  // (assembled first among the base packs) reaches every consumer — including user/test
  // scheme that calls `(gensym …)` for hygiene names, and the inference-plane `cut`/`cute`
  // copy in initBridge, which reads `gensym` off the user_env chain post-assembly. Native:
  // the impl is the shared `reader/values-repr` gensym, bound raw.
  symbols: {
    // Kernel KEYWORDS — special forms made first-class (symbol.keyword markers). The
    // evaluator resolves a call head through the env and dispatches SPECIAL_FORMS[name]
    // when it resolves to one of these — so `(define => lambda)` aliases the form and
    // lexical shadowing un-specials it (the dual of cxr; see values/Keyword.ts). A
    // kernel special form becomes a keyword for two reasons: (1) first-class,
    // value-carried dispatch — `(define => lambda)` aliases the form, the dual of cxr;
    // and (2) the HYGIENE engine resolves a renamed template identifier (`if` → `#:if`)
    // by binding the gensym to the original name's ENV VALUE (syntax-rules.ts rename())
    // — a name-only special form has no env value, so a USER syntax-rules macro
    // expanding to it could not resolve. cond/case/when/unless stay evaluator SPECIAL
    // FORMS (evalCond/… — TCO-correct, unlike the nested-genRun syntax-rules path), but
    // are ALSO keywords so all control forms are uniformly first-class and reachable
    // from macro templates. let*/letrec/letrec*/and/or are keyworded for the same
    // hygiene reason: a syntax-rules template expanding to one of these renames the
    // head to a gensym, and only a keyworded form has an env value for rename() to
    // copy onto it. define-macro/do/while/try complete the set: every SPECIAL_FORMS
    // entry (evaluator.ts) is a keyword marker, so a hygiene-renamed head can never
    // miss dispatch for lack of a copyable env value.
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

    // ── Essential constants: true / false / NaN. (`single`, once a fourth
    // constant here, is deleted — see the file header.) ──────────────────────

    // Both CONSTANT defines (a bare ZodType contract, not a Contract<I,O>
    // record) — `z.boolean` validates the literal ONCE at bake, then binds the
    // plain value (no call-boundary wrapper; there is no call boundary).
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
  },
});
