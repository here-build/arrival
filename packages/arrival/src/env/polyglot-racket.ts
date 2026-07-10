// @here.build/arrival/polyglot-racket — the Racket dialect pack, split out of
// the former monolithic `scheme/polyglot` (V, 2026-07-10 — see polyglot.ts's
// header for the full split rationale and the sibling-pack map).
//
// Two families:
//   THREADING — `~>`/`~>>` (Racket's thread-first/thread-last spellings), ALIASES
//   expanding to Clojure's `->`/`->>` (polyglot-clojure.ts). JUDGMENT (V's table,
//   "deps on clojure OR the expansion moves shared — judge honestly"): this pack
//   DEPENDS ON polyglot-clojure rather than re-implementing the expansion
//   independently. `->`/`->>` are referenced only as quasiquoted DATA inside
//   `~>`/`~>>`'s own macro bodies (`\`(-> ,x ,@forms)`), so the static bake FV
//   walker does NOT force this edge (collect-references.ts: quasiquote space is
//   data except under unquote) — but the RESULTING expansion is a runtime
//   Unbound-variable trap unless `->`/`->>` are actually bound, so the edge is
//   declared anyway for honest standalone composition. Consequence: base-packs.ts
//   positions this pack BEFORE polyglot-clojure in the C3 tail (dependents
//   before dependencies).
//   DICT ACCESSOR FAMILY (Racket's dict library) — grain-completion: MCP-Atlas
//   trajectory autopsy found models reaching for `dict-ref` to read a field off a
//   dict-shaped tool result and getting stranded (Unbound variable). `@`/`:key`
//   already read ANYTHING member-shaped (dict / membrane-foreign / array —
//   origin-agnostic, see polyglot.ts's header), but a model trained on Racket's
//   dict library reaches for its actual name. This family is that name, PLUS the
//   value `@` doesn't have: dict-ref/dict-keys/… are dict-SPECIFIC — they guard
//   the dict shape (see %dict-guard) so a wrong-shaped argument fails loudly
//   (door: fact + why + action) instead of silently reading nil through `@`'s
//   origin-agnostic fallback. `assoc-ref` (Guile/Emacs Lisp) rides with this
//   family — an accessor-name alias of `dict-ref`, not a second read convention.
//
// %dict-guard — MOVED here from the shared core (polyglot.ts's header explains
// the judgment): its only consumers are this pack's own dict-* family, so it
// travels with them rather than sitting in core as a single-consumer helper.
//
// CONTRACT JUDGMENT for the whole dict-* family: `d` is `z.value` ON PURPOSE,
// never `z.dict()` — the %dict-guard TEACHING DOOR is this pack's own
// errors-as-doors surface (fact + why + action, naming `@` as the origin-agnostic
// alternative), and a `z.dict()` input contract would preempt it with a bare zod
// boundary error, destroying the door. The guard IS the validator here; the
// contract stays out of its way. (Pinned by the pre-split suite's own "errors
// with a door on a non-dict" rows, run unmodified.)
//
// DEPS (§2.1's bake FV locality law): every cross-capability free name in the
// define bodies below is a declared edge —
//   scheme/polyglot-clojure — str (dict-set/dict-update's door message,
//                              %dict-guard's door message), and the ~>/~>>
//                              runtime-binding reason above
//   scheme/polyglot (core)  — @ @? @keys dict nil %interleave
//   equality                — dict? pair? string? null? procedure?
//   numeric                 — number?
//   vectors                 — vector? vector->list
//   lists                   — map cons length apply
//   exceptions              — error
// `scheme/polyglot-clojure` itself declares `deps: [polyglot, srfi1, equality,
// numeric, strings, vectors, lists]` (polyglot-clojure.ts) — a DIRECT dependent
// of `polyglot`/`equality`/`numeric`/`vectors`/`lists`, every one of which is
// ALSO listed directly below — so C3's "dependents before dependencies WITHIN a
// deps array too" rule (srfi-235.ts's precedent) puts it FIRST, ahead of
// `polyglot` (core) itself (which `scheme/polyglot-clojure` also depends on).
//
// `exceptions` needs a LESS obvious placement, found empirically
// (AssembleLinearizationError on the first draft of this file): `scheme/
// polyglot-clojure` depends on `srfi-1`, whose OWN `deps` array orders
// `[equality, numeric, binding, exceptions, lists]` — `exceptions` BEFORE
// `lists`/`vectors`. That forces `exceptions` to precede `vectors`/`lists` in
// `L(polyglot-clojure)` too (C3 propagates a dependency's internal order into
// every dependent's linearization), even though nothing in polyglot-clojure.ts
// itself references `error`. Since THIS pack's own array lists `clojure`
// alongside `exceptions`/`vectors`/`lists` directly, it must NOT contradict that
// forced order — `exceptions` is listed right after `numeric`, before
// `vectors`/`lists`, not after them.

import { EnvCapability } from "../common/capability.js";
import { symbol } from "../common/symbol.js";
import * as z from "../common/scheme-zod.js";
import polyglotClojure from "./polyglot-clojure.js";
import polyglot from "./polyglot.js";
import equality from "./r7rs/equality.js";
import numeric from "./r7rs/numeric.js";
import vectors from "./r7rs/vectors.js";
import lists from "./r7rs/lists.js";
import exceptions from "./r7rs/exceptions.js";

export default new EnvCapability("scheme/polyglot-racket", {
  deps: [polyglotClojure, polyglot, equality, numeric, exceptions, vectors, lists],
  symbols: {
    // ═══════════════════════════════════════════════════════════════════════════
    // THREADING MACROS (Racket ~> ~>>) — aliases expanding to Clojure's -> ->>
    // ═══════════════════════════════════════════════════════════════════════════
    "~>": symbol.defineSyntax`~>: Racket's thread-first — an alias expanding to (-> …)`(
      `(lambda (x . forms) \`(-> ,x ,@forms))`,
      { macroAttribute: "expression" },
    ),
    "~>>": symbol.defineSyntax`~>>: Racket's thread-last — an alias expanding to (->> …)`(
      `(lambda (x . forms) \`(->> ,x ,@forms))`,
      { macroAttribute: "expression" },
    ),

    // ═══════════════════════════════════════════════════════════════════════════
    // RACKET — dict accessor family (Racket's dict library) — grain-completion
    // ═══════════════════════════════════════════════════════════════════════════
    // %dict-guard — internal: the dict? guard shared by the whole family below.
    "%dict-guard": symbol.define`%dict-guard: the dict? teaching guard shared by the dict-* family — returns d when dict-shaped, else throws the fact+why+action door (private helper)`(
      { input: [z.string, z.value], output: [z.dict()] },
      `(lambda (who d)
         (if (dict? d)
             d
             (error (str who ": expected a dict (native {…} / (dict …) record), got "
                         (cond ((pair? d) "a pair/list")
                               ((vector? d) "a vector")
                               ((string? d) "a string")
                               ((number? d) "a number")
                               ((null? d) "'() (empty list)")
                               ((procedure? d) "a procedure")
                               (else "a foreign/membrane value"))
                         " — " who " guards the dict shape so a wrong-shaped argument "
                         "fails loudly instead of silently reading nil; use @ for an "
                         "origin-agnostic read across dict/array/foreign values instead"))))`,
    ),
    // dict-ref — Racket: read the value at key, with an optional failure-result
    // when key is missing. Same missing-key convention as get-in/@ (nil when no
    // default is given — NOT a second convention); key may be a keyword (:key), a
    // quoted symbol, or a string, normalized identically to @/:key. `@?` (not a
    // bare `@` nil-check) distinguishes "key truly missing" from "key present with
    // a nil/'() value" before falling back. The optional default rides inputRest
    // (0-or-1 rest arg — the scheme rest-parameter shape).
    "dict-ref": symbol.define`dict-ref: Racket — the value at key in d, or the optional default (nil when absent and no default); keys normalize like @/:key`(
      { input: [z.value, z.value], inputRest: z.value, output: [z.value] },
      `(lambda (d key . default)
         (%dict-guard "dict-ref" d)
         (if (@? d key)
             (@ d key)
             (if (null? default) nil (car default))))`,
    ),
    // dict-has-key? — Racket: #t iff key resolves in d. A dict-guarded alias of @?
    // (whose verdict is the boxed schemeBool — hence a real z.boolean output).
    "dict-has-key?": symbol.define`dict-has-key?: Racket — #t iff key resolves in d; a dict-guarded alias of @?`(
      { input: [z.value, z.value], output: [z.boolean] },
      `(lambda (d key)
         (%dict-guard "dict-has-key?" d)
         (@? d key))`,
    ),
    // dict-keys — Racket: d's own keys as a proper scheme list. `@keys` alone
    // returns a raw JS array — composes with length, but not map/filter (see
    // %dict-set's comment in polyglot-clojure.ts) — so this lifts it via
    // vector->list once, the same move %dict-set already makes. Elements are the
    // boxed AString keys `@keys` mints → z.list(z.string).
    "dict-keys": symbol.define`dict-keys: Racket — d's own keys as a proper scheme list (the @keys array lifted via vector->list)`(
      { input: [z.value], output: [z.list(z.string)] },
      `(lambda (d)
         (%dict-guard "dict-keys" d)
         (vector->list (@keys d)))`,
    ),
    // dict-values — Racket: the value at each of d's keys, in dict-keys order.
    "dict-values": symbol.define`dict-values: Racket — the value at each of d's keys, in dict-keys order`(
      { input: [z.value], output: [z.list()] },
      `(lambda (d)
         (%dict-guard "dict-values" d)
         (map (lambda (k) (@ d k)) (dict-keys d)))`,
    ),
    // dict-count — Racket: the number of keys in d. `length` over a proper list
    // always yields an exact count (its own term boxes an AExact) → z.exact.
    "dict-count": symbol.define`dict-count: Racket — the number of keys in d`(
      { input: [z.value], output: [z.exact] },
      `(lambda (d)
         (%dict-guard "dict-count" d)
         (length (dict-keys d)))`,
    ),
    // dict->alist — d's entries as an alist of (key . value) pairs, in dict-keys
    // order. The inverse of alist->dict.
    "dict->alist": symbol.define`dict->alist: d's entries as an alist of (key . value) pairs, in dict-keys order — the inverse of alist->dict`(
      { input: [z.value], output: [z.list(z.pair)] },
      `(lambda (d)
         (%dict-guard "dict->alist" d)
         (map (lambda (k) (cons k (@ d k))) (dict-keys d)))`,
    ),
    // alist->dict — the inverse of dict->alist: build a dict from an alist of
    // (key . value) pairs. Each key may be a keyword/symbol/string — the same
    // normalization `dict` itself already applies to its own :key args. The one
    // dict-family input that IS a real typed spine: a proper list of pairs.
    "alist->dict": symbol.define`alist->dict: build a dict from an alist of (key . value) pairs — the inverse of dict->alist; keys normalize like dict's own`(
      { input: [z.list(z.pair)], output: [z.dict()] },
      `(lambda (alist)
         (apply dict (%interleave (map car alist) (map cdr alist))))`,
    ),
    // dict-set / dict-update — DOORS, not functions (V, 2026-07-04). This env is
    // immutable, and a "set"/"update" VERB reads as in-place mutation: a pure
    // implementation returning a new dict is a trap — the model believes it mutated
    // d, nothing changed, and the failure is silent (exactly the class the doors
    // program exists to delete). So the verbs exist only to teach the sanctioned
    // pure path: assoc-in/update-in + (define …). Same family as the SRFI-69
    // hash-table immutable-redirect stubs. SHAPELESS contracts (§1.2 carve-out,
    // one line each): the body unconditionally throws, so no input shape is ever
    // consumed and no output is ever produced — a fixed contract would be fiction.
    "dict-set": symbol.define`dict-set: a teaching DOOR — dicts are immutable here; build a NEW dict via assoc-in and bind it`(
      { input: [], inputRest: z.value, output: [z.value] },
      `(lambda _args
         (error (str "dict-set is not provided — dicts are immutable here, and a 'set' "
                     "verb implies in-place mutation, which never happens. Build a NEW "
                     "dict and bind it: (define d2 (assoc-in d (list :key) value)) — "
                     "the original d is unchanged.")))`,
    ),
    "dict-update": symbol.define`dict-update: a teaching DOOR — dicts are immutable here; build a NEW dict via update-in and bind it`(
      { input: [], inputRest: z.value, output: [z.value] },
      `(lambda _args
         (error (str "dict-update is not provided — dicts are immutable here, and an "
                     "'update' verb implies in-place mutation, which never happens. "
                     "Build a NEW dict and bind it: "
                     "(define d2 (update-in d (list :key) updater)) — "
                     "the original d is unchanged.")))`,
    ),

    // ═══════════════════════════════════════════════════════════════════════════
    // GUILE / EMACS LISP — accessor-name alias (rides with the dict family)
    // ═══════════════════════════════════════════════════════════════════════════
    // assoc-ref — Guile/Emacs Lisp: read by key, same polyglot-idiom principle as
    // the threading family — a model reaches for whichever accessor name it
    // already knows) — an alias of dict-ref, not a second read convention. Mirrors
    // dict-ref's contract exactly (including the z.value door-preserving d).
    "assoc-ref": symbol.define`assoc-ref: Guile/Emacs Lisp — read by key with an optional default; an alias of dict-ref, not a second read convention`(
      { input: [z.value, z.value], inputRest: z.value, output: [z.value] },
      `(lambda (d key . default)
         (apply dict-ref (cons d (cons key default))))`,
    ),
  },
});
