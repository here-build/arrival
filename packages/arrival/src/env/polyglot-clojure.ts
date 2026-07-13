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
import dedent from "dedent";
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
    // comp — CONSTANT alias of compose (eq? identity). No Contract.type channel on constants.
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
    // update-in — f unary updater via applicable. type: pins 3-arg shape (callable would collapse).
    "update-in": symbol.define`update-in: Clojure — assoc-in the result of applying f to the value currently at nested path ks`(
      {
        input: [z.value, z.list(), applicable],
        output: [z.value],
        type: dedent`
          {
            (obj: unknown, ks: List<unknown>, f: (cur: unknown) => unknown): unknown;
          }
        `,
      },
      `(lambda (obj ks f)
         (assoc-in obj ks (f (get-in obj ks))))`,
    ),
    // zipmap — dict of ks→vs. type: string keys preferred; unknown keys still → string dict face.
    zipmap: symbol.define`zipmap: Clojure — a dict pairing each key in ks with the value at the same position in vs`(
      {
        input: [z.list(), z.list()],
        output: [z.dict()],
        type: dedent`
          {
            <V>(ks: List<string>, vs: List<V>): Record<string, V>;
            <V>(ks: List<unknown>, vs: List<V>): Record<string, V>;
          }
        `,
      },
      `(lambda (ks vs) (apply dict (%interleave ks vs)))`,
    ),
    // frequencies — reduce-dispatched coll (list|vector|nil). Keys via repr → string dict face.
    frequencies: symbol.define`frequencies: Clojure — a dict of each distinct element to its occurrence count (non-string elements key by repr)`(
      {
        input: [z.value],
        output: [z.dict()],
        type: dedent`
          {
            <T>(coll: List<T>): Record<string, number>;
            <T>(coll: readonly T[]): Record<string, number>;
          }
        `,
      },
      `(lambda (coll)
         (reduce
           (lambda (x acc)
             (let* ((k (if (string? x) x (repr x)))
                    (cur (@ acc k)))
               (%dict-set acc k (if (null? cur) 1 (+ cur 1)))))
           (dict)
           coll))`,
    ),
    // group-by — f → key; values always lists of elements. Record keys = string (repr floor).
    "group-by": symbol.define`group-by: Clojure — a dict of (f element) to the list of elements that produced it, in original order`(
      {
        input: [applicable, z.value],
        output: [z.dict()],
        type: dedent`
          {
            <T>(f: (x: T) => unknown, coll: List<T>): Record<string, List<T>>;
            <T>(f: (x: T) => unknown, coll: readonly T[]): Record<string, List<T>>;
          }
        `,
      },
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
    // partial — fix leading args; always returns a fn (unlike curry, which may fire).
    // type: zero-fix preserves full arity; fixed arms for 1–3; catch-all for deeper.
    partial: symbol.define`partial: Clojure — fix the leading args of f, returning a function of the rest`(
      {
        input: [applicable],
        inputRest: z.value,
        output: [z.lambda],
        type: dedent`
          {
            <A extends unknown[], R>(f: (...args: A) => R): (...args: A) => R;
            <A, B, R>(f: (a: A, b: B) => R, a: A): (b: B) => R;
            <A, B, C, R>(f: (a: A, b: B, c: C) => R, a: A): (b: B, c: C) => R;
            <A, B, C, R>(f: (a: A, b: B, c: C) => R, a: A, b: B): (c: C) => R;
            <A, B, C, R>(f: (a: A, b: B, c: C) => R, a: A, b: B, c: C): () => R;
            <R>(f: (...args: unknown[]) => R, ...fixed: unknown[]): (...more: unknown[]) => R;
          }
        `,
      },
      `(lambda (f . args)
         (lambda more (apply f (append args more))))`,
    ),
    // juxt — same args → List of results (scheme list; order lost as union).
    // type: 1–3 precise arms + catch-all (same pragmatism as curry, not compose's hard cap).
    juxt: symbol.define`juxt: Clojure — a function applying every fn to the same args, collecting the results into a list in fn order`(
      {
        input: [],
        inputRest: applicable,
        output: [z.lambda],
        type: dedent`
          {
            <A extends unknown[], R1>(f1: (...args: A) => R1): (...args: A) => List<R1>;
            <A extends unknown[], R1, R2>(f1: (...args: A) => R1, f2: (...args: A) => R2): (...args: A) => List<R1 | R2>;
            <A extends unknown[], R1, R2, R3>(f1: (...args: A) => R1, f2: (...args: A) => R2, f3: (...args: A) => R3): (...args: A) => List<R1 | R2 | R3>;
            (...fns: ((...args: unknown[]) => unknown)[]): (...args: unknown[]) => List<unknown>;
          }
        `,
      },
      `(lambda fns
         (lambda args
           (map (lambda (f) (apply f args)) fns)))`,
    ),
    // mapv / filterv — map/filter + list->vector. f/pred stay z.value (map/filter own
    // callable-or-matcher); spines z.list(); output always vector.
    // type: list-only in (contract), vector out — no vector dual.
    mapv: symbol.define`mapv: Clojure — map with a vector result instead of a list`(
      {
        input: [z.value],
        inputRest: z.list(),
        output: [z.vector()],
        type: dedent`
          {
            <T, B>(f: (x: T) => B, xs: List<T>): readonly B[];
            <A, B, R>(f: (a: A, b: B) => R, as: List<A>, bs: List<B>): readonly R[];
            <A, B, C, R>(f: (a: A, b: B, c: C) => R, as: List<A>, bs: List<B>, cs: List<C>): readonly R[];
          }
        `,
      },
      `(lambda (f . lists) (list->vector (apply map (cons f lists))))`,
    ),
    filterv: symbol.define`filterv: Clojure — filter with a vector result instead of a list`(
      {
        input: [z.value, z.list()],
        output: [z.vector()],
        type: dedent`
          {
            <T, S extends T>(p: (x: T) => x is S, xs: List<T>): readonly S[];
            <T>(p: (x: T) => unknown, xs: List<T>): readonly T[];
          }
        `,
      },
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
    // rest — cdr that tolerates non-pair → '(). type: List arm + tolerant unknown arm.
    rest: symbol.define`rest: Clojure — cdr that tolerates a non-pair (returns '()) instead of erroring`(
      {
        input: [z.value],
        output: [z.value],
        type: dedent`
          {
            <T>(xs: List<T>): List<T>;
            (xs: unknown): List<unknown>;
          }
        `,
      },
      `(lambda (xs) (if (pair? xs) (cdr xs) '()))`,
    ),
    // empty? — list/string/vector/dict. OUTPUT z.boolean: every arm is ABool (`=` boxes via applyNumeric).
    "empty?": symbol.define`empty?: Clojure — #t iff the list / string / vector / dict has no elements`(
      {
        input: [z.value],
        output: [z.boolean],
        type: dedent`
          {
            (xs: List<unknown> | readonly unknown[] | string | Record<string, unknown>): boolean;
          }
        `,
      },
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
