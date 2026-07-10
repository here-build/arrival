// @here.build/arrival/polyglot-clojure — the Clojure dialect pack (see
// polyglot.ts's header for the sibling-pack map).
//
// Two families:
//   THREADING — `->`/`->>` (Clojure thread-first/thread-last) and `comp` (Clojure's
//   name for the shared-core `compose`, aliased back onto it).
//   STDLIB COMPLETION — famous Clojure symbols that are PURE functions over
//   primitives already bound in the shared core / R7RS / SRFI-1: str, get-in,
//   assoc-in, update-in, zipmap, frequencies, group-by, partial, juxt, mapv,
//   filterv, conj, into, rest, empty?. An LLM (or human) reaching for a
//   well-known Clojure symbol gets a REAL binding, not a teaching-stub door —
//   when the semantics are implementable without IO/mutation/macro machinery.
//   (The genuinely-impure cousin — println — is doored instead, in
//   env/polyglot-stubs.ts's Clojure section.)
//
// NOTE: `first` (SRFI-1), `flatten` (r7rs/lists.ts, LIPS extension) and `curry`
// (SRFI-235-adjacent, srfi-235.ts) are ALREADY bound elsewhere — deliberately not
// redefined here.
//
// ATTRIBUTE JUDGMENT for `->`/`->>`: every argument position is ORDINARY
// EXPRESSION SPACE — `x` is an evaluated seed, each form is either a call form
// (whose elements are expressions the expansion preserves verbatim, merely
// splicing the threaded value in) or a bare symbol (a function REFERENCE the
// expansion applies). Nothing binds (contrast `receive`/`and-let*`'s formals →
// "binder") and nothing is a positional token consumed by the expander (contrast
// `cut`'s `<>` → "opaque"). So the validator legitimately WALKS the arguments:
// `(-> x undefined-fn)` REPORTS unbound-symbol at parse phase. Keyword accessors
// in thread position (`(->> p :versions)`) stay clean for free: keyword-shaped
// names never enter the FV walk by construction.
//
// DEPS: cross-capability free names (the FV-locality rule is stated once in
// polyglot.ts's header) —
//   scheme/polyglot (core) — @ @keys dict %interleave compose
//   srfi-1                 — filter reduce
//   equality               — null? pair? string? repr dict?
//   numeric                — + =
//   strings                — string-append string-length
//   vectors                — vector? vector-length vector->list list->vector
//   lists                  — map apply append cons length
// deps order matches base-packs.ts's C3 tail-block order (dependents before
// dependencies) — see base-packs.ts's own header.
// polyglot-racket.ts depends on THIS pack (for `str`, the door messages of
// dict-set/dict-update, and the runtime binding `~>`/`~>>` expand into); see
// polyglot-racket.ts's own header.

import { EnvCapability } from "../common/capability.js";
import { symbol } from "../common/symbol.js";
import * as z from "../common/scheme-zod.js";
import polyglot from "./polyglot.js";
import equality from "./r7rs/equality.js";
import numeric from "./r7rs/numeric.js";
import strings from "./r7rs/strings.js";
import vectors from "./r7rs/vectors.js";
import lists from "./r7rs/lists.js";
import srfi1 from "./srfi/srfi-1.js";

// See polyglot.ts's own note: a one-line local const is cheaper than a cross-pack
// named export for a pure contract-vocabulary helper. Same definition, same
// reasoning (keyword accessors are first-class functions in this idiom family).
const applicable = z.union([z.lambda, z.symbol]);

export default new EnvCapability("scheme/polyglot-clojure", {
  // deps order matches base-packs.ts's C3 tail-block order (dependents before
  // dependencies) — see the header's DEPS list and base-packs.ts's own header.
  deps: [polyglot, srfi1, equality, numeric, strings, vectors, lists],
  symbols: {
    // ═══════════════════════════════════════════════════════════════════════════
    // THREADING MACROS (Clojure -> ->>) — `macroAttribute: "expression"`
    // ═══════════════════════════════════════════════════════════════════════════
    "->": symbol.defineSyntax`->: thread x as the FIRST argument through each form (Clojure thread-first) — (-> x (f a) g) => (g (f x a))`(
      `(lambda (x . forms)
         (if (null? forms)
             x
             (let ((form (car forms)))
               \`(-> ,(if (pair? form)
                          (cons (car form) (cons x (cdr form)))
                          (list form x))
                    ,@(cdr forms)))))`,
      { macroAttribute: "expression" },
    ),
    "->>": symbol.defineSyntax`->>: thread x as the LAST argument through each form (Clojure thread-last) — (->> x (f a) g) => (g (f a x))`(
      `(lambda (x . forms)
         (if (null? forms)
             x
             (let ((form (car forms)))
               \`(->> ,(if (pair? form)
                           (append form (list x))
                           (list form x))
                     ,@(cdr forms)))))`,
      { macroAttribute: "expression" },
    ),
    // comp — Clojure's name for compose (shared core). A CONSTANT define: the RHS
    // is the bare identifier `compose`, bound by the `polyglot` dep — the contract
    // is the single value schema z.lambda (the value IS the bound compose
    // procedure), same shape as srfi-235's `always` alias.
    comp: symbol.define`comp: Clojure's name for compose — a back-compat alias binding the same procedure`(
      z.lambda,
      `compose`,
    ),

    // ═══════════════════════════════════════════════════════════════════════════
    // STDLIB COMPLETION — pure functions over primitives already bound elsewhere
    // ═══════════════════════════════════════════════════════════════════════════
    // str — Clojure: concatenate the display form of every arg. Strings pass
    // through as-is; everything else prints via `repr` (the external-representation
    // protocol, r7rs/equality.ts) before concatenating with string-append.
    // Genuinely variadic-any input (any value has a display form); the output
    // is unconditionally a string.
    str: symbol.define`str: Clojure — concatenate the display form of every arg (strings as-is, everything else via repr)`(
      { input: [], inputRest: z.value, output: [z.string] },
      `(lambda args
         (apply string-append (map (lambda (x) (if (string? x) x (repr x))) args)))`,
    ),
    // get-in — Clojure: read a value nested ks-deep through dicts (or anything
    // `@` reads), nil if any step misses. `obj` is origin-agnostic BY DESIGN (the
    // `@` read protocol's whole point) and the result is whatever is stored — both
    // honestly `z.value`.
    "get-in": symbol.define`get-in: Clojure — read a value nested ks-deep through dicts (or anything @ reads); nil if any step misses`(
      { input: [z.value, z.list()], output: [z.value] },
      `(lambda (obj ks)
         (if (null? ks)
             obj
             (get-in (@ obj (car ks)) (cdr ks))))`,
    ),
    // assoc-in — Clojure: a NEW obj with the value at nested path ks set to v,
    // building missing intermediate dicts as needed (see %dict-set). Output is
    // `z.value`, not `z.dict()`: with an EMPTY path the result is v itself —
    // any value — by definition.
    "assoc-in": symbol.define`assoc-in: Clojure — a NEW obj with the value at nested path ks set to v, minting missing intermediate dicts on demand`(
      { input: [z.value, z.list(), z.value], output: [z.value] },
      `(lambda (obj ks v)
         (if (null? ks)
             v
             (if (null? (cdr ks))
                 (%dict-set obj (car ks) v)
                 (%dict-set obj (car ks) (assoc-in (@ obj (car ks)) (cdr ks) v)))))`,
    ),
    // update-in — Clojure: assoc-in the result of applying f to the current value.
    // `f` is applied directly by this body → `applicable` (a keyword accessor is a
    // legal updater exactly like any fn).
    "update-in": symbol.define`update-in: Clojure — assoc-in the result of applying f to the value currently at nested path ks`(
      { input: [z.value, z.list(), applicable], output: [z.value] },
      `(lambda (obj ks f)
         (assoc-in obj ks (f (get-in obj ks))))`,
    ),
    // zipmap — Clojure: a dict pairing each key with the value at the same
    // position in vs.
    zipmap: symbol.define`zipmap: Clojure — a dict pairing each key in ks with the value at the same position in vs`(
      { input: [z.list(), z.list()], output: [z.dict()] },
      `(lambda (ks vs) (apply dict (%interleave ks vs)))`,
    ),
    // frequencies — Clojure: a dict of each distinct element to its occurrence
    // count. Non-string elements key by their `repr` (dict keys are strings).
    // `coll` stays `z.value`: the body delegates to `reduce` (srfi-1's tagless
    // term dispatcher), so any reduce-capable receiver (list, vector, nil) is
    // legal — a `z.list()` contract would narrow the real surface.
    frequencies: symbol.define`frequencies: Clojure — a dict of each distinct element to its occurrence count (non-string elements key by repr)`(
      { input: [z.value], output: [z.dict()] },
      `(lambda (coll)
         (reduce
           (lambda (x acc)
             (let* ((k (if (string? x) x (repr x)))
                    (cur (@ acc k)))
               (%dict-set acc k (if (null? cur) 1 (+ cur 1)))))
           (dict)
           coll))`,
    ),
    // group-by — Clojure: a dict of (f element) to the list of elements that
    // produced it, in original order. `f` applied directly → applicable; `coll`
    // term-dispatched via reduce → z.value (same reasoning as frequencies).
    "group-by": symbol.define`group-by: Clojure — a dict of (f element) to the list of elements that produced it, in original order`(
      { input: [applicable, z.value], output: [z.dict()] },
      `(lambda (f coll)
         (reduce
           (lambda (x acc)
             (let* ((k0 (f x))
                    (k (if (string? k0) k0 (repr k0)))
                    (cur (@ acc k)))
               (%dict-set acc k (append (if (null? cur) '() cur) (list x)))))
           (dict)
           coll))`,
    ),
    // partial — Clojure: fix the leading args of f, returning a function of the
    // rest. `f` applied (later) by the minted closure → applicable; the fixed
    // args are genuinely anything.
    partial: symbol.define`partial: Clojure — fix the leading args of f, returning a function of the rest`(
      { input: [applicable], inputRest: z.value, output: [z.lambda] },
      `(lambda (f . args)
         (lambda more (apply f (append args more))))`,
    ),
    // juxt — Clojure: a function that applies every fn to the same args,
    // collecting the results into a list (in fn order).
    juxt: symbol.define`juxt: Clojure — a function applying every fn to the same args, collecting the results into a list in fn order`(
      { input: [], inputRest: applicable, output: [z.lambda] },
      `(lambda fns
         (lambda args
           (map (lambda (f) (apply f args)) fns)))`,
    ),
    // mapv / filterv — Clojure: map/filter with a vector result instead of a list.
    // `f`/`pred` PASS THROUGH to map/filter's own dispatch (which owns the
    // callable-or-matcher polymorphism — filter accepts a RegExp, per its own doc),
    // so they stay `z.value`; the trailing lists must be real list spines for the
    // list->vector lift to hold, so those are `z.list()`; the output is
    // unconditionally a vector.
    mapv: symbol.define`mapv: Clojure — map with a vector result instead of a list`(
      { input: [z.value], inputRest: z.list(), output: [z.vector()] },
      `(lambda (f . lists) (list->vector (apply map (cons f lists))))`,
    ),
    filterv: symbol.define`filterv: Clojure — filter with a vector result instead of a list`(
      { input: [z.value, z.list()], output: [z.vector()] },
      `(lambda (pred lst) (list->vector (filter pred lst)))`,
    ),
    // %conj-list — conj's list arm (private helper). `z.value` both sides —
    // self-recursive per item (the %interleave perf reasoning) and coll is the
    // accumulating polymorphic result.
    "%conj-list": symbol.define`%conj-list: conj's list arm — cons each item onto coll in order, so the LAST item passed ends up FIRST (private helper)`(
      { input: [z.value, z.value], output: [z.value] },
      `(lambda (coll items)
         (if (null? items)
             coll
             (%conj-list (cons (car items) coll) (cdr items))))`,
    ),
    // conj — Clojure: add items to a collection in its natural growth position —
    // the front for a list (each successive item conj'd onto the accumulating
    // result, so the LAST item passed ends up FIRST), the end for a vector.
    // GENUINELY SHAPELESS: coll is list-or-vector and the result is in coll's
    // OWN representation — no single richer type is honest.
    conj: symbol.define`conj: Clojure — add items at the collection's natural growth position (front for a list, end for a vector)`(
      { input: [z.value], inputRest: z.value, output: [z.value] },
      `(lambda (coll . items)
         (if (vector? coll)
             (list->vector (append (vector->list coll) items))
             (%conj-list coll items)))`,
    ),
    // into — Clojure: pour every element of from into to via conj, in from's
    // order. SHAPELESS carve-out on both collections (conj's representation
    // polymorphism + reduce's term dispatch).
    into: symbol.define`into: Clojure — pour every element of from into to via conj, in from's order`(
      { input: [z.value, z.value], output: [z.value] },
      `(lambda (to from)
         (reduce (lambda (x acc) (conj acc x)) to from))`,
    ),
    // rest — Clojure: cdr that tolerates a non-pair (nil) instead of erroring.
    // The `z.value` input IS the semantics (tolerance is the whole binding).
    rest: symbol.define`rest: Clojure — cdr that tolerates a non-pair (returns '()) instead of erroring`(
      { input: [z.value], output: [z.value] },
      `(lambda (xs) (if (pair? xs) (cdr xs) '()))`,
    ),
    // empty? — Clojure: #t iff the list / string / vector / dict has no elements.
    // (`@keys` returns a raw JS array, not a scheme list — `length` accepts it
    // directly as a ".length carrier", r7rs/lists.ts, so no array->list needed here.)
    // OUTPUT is `z.boolean`: every cond arm returns a boxed ABool — the `#t`/`#f`
    // literals and the null?/pair?/dict? verdicts obviously, AND the
    // `=`-driven string?/vector?/dict? arms too (`nativeNumericOp`'s
    // `applyNumeric` boxes every boolean result, r7rs/numeric.ts, so `(= 0 0)`
    // and every `=`-arm of `empty?` return ABool, never a raw JS boolean).
    // Matches the sibling `dict-has-key?` (racket), also `z.boolean`.
    "empty?": symbol.define`empty?: Clojure — #t iff the list / string / vector / dict has no elements`(
      { input: [z.value], output: [z.boolean] },
      `(lambda (xs)
         (cond
           ((null? xs) #t)
           ((pair? xs) #f)
           ((string? xs) (= (string-length xs) 0))
           ((vector? xs) (= (vector-length xs) 0))
           ((dict? xs) (= (length (@keys xs)) 0))
           (else #f)))`,
    ),
    // %dict-set — a dict with key k rebuilt to value v, everything else preserved
    // (dicts are immutable — see HASH_TABLE_REASON in srfi-stubs.ts). Applied to nil
    // it builds a fresh single-key dict (@keys nil = '()), which is exactly what
    // assoc-in needs to create missing intermediate maps on demand — so `d` is
    // honestly `z.value` (dict OR nil), never `z.dict()`. `@keys` returns a raw JS
    // array (not a scheme list — filter/map need the term protocol), so
    // `vector->list` (R7RS §6.8 — a raw JS array is representation-blind as a
    // vector here, per z.vector) lifts it first.
    // k v are placed LAST (not first): `dict`'s own key resolution (stringify, strip a
    // leading `:`) normalizes a keyword / symbol / string key to the
    // SAME underlying JS-object key as an already-stored string key — a plain `equal?`
    // comparison can't see that (a pluck closure is never `equal?` to a string), but
    // sequential `obj[key] = value` assignment naturally dedupes on the LAST write. So
    // no explicit exclusion is needed: k v simply overwrite whatever ks/vs already wrote.
    "%dict-set": symbol.define`%dict-set: a NEW dict with key k set to v, everything else preserved; applied to nil it mints a fresh single-key dict (private helper)`(
      // k: keyword/symbol/string (dict's own normalization is the semantics);
      // v: anything. Output IS unconditionally a dict.
      { input: [z.value, z.value, z.value], output: [z.dict()] },
      `(lambda (d k v)
         (let* ((ks (vector->list (@keys d)))
                (vs (map (lambda (key) (@ d key)) ks)))
           (apply dict (append (%interleave ks vs) (list k v)))))`,
    ),
  },
});
