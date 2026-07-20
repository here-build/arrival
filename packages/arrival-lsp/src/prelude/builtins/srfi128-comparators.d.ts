// ─────────────────────────────────────────────────────────────────────────────
// L — SRFI-128 comparators — comparator objects + the relational ops over them.
//
// Scheme semantics:
//   (make-comparator type-test equality ordering [hash])  → a comparator object
//     (the 4th `hash` arg is accepted for source-compat but IGNORED — arrival has
//      no value-hash, so comparator-hashable? is always #f)
//   (make-default-comparator) / (default-comparator)      → a total-order comparator
//   (comparator? x)                                        → #t iff x is a comparator
//   (comparator-type-test-predicate c) / -equality- / -ordering-  → extract a pred
//   (comparator-hashable? c)                               → always #f
//   (=? c a b …) / (<? c a b …) / (<=? …) / (>? …) / (>=? …)  → chain-relate via c
//
// Runtime truth — a comparator is a TAGGED LIST (the `any` impls these SHARPEN —
// do NOT import them):
//     (make-comparator tt eq ord . hash) = (list 'comparator tt eq ord)
//       → JS runtime value  ['comparator', typeTest, equality, ordering]
//     (comparator? x)  = (and (pair? x) (eq? (car x) 'comparator))
//     comparator-type-test-predicate = (cadr c)
//     comparator-equality-predicate  = (caddr c)
//     comparator-ordering-predicate  = (cadddr c)
//     comparator-hashable?           = #f always
//     (=? c a b . rest) chains the equality pred over adjacent pairs
//     (<? c a b . rest) chains the ordering pred
//     (make-default-comparator) = total order across types
//     (default-comparator)      = (make-default-comparator)
//
// Exposed to the inference env via SAFE_BUILTINS.
//
// MODELING (v1):
//   • A comparator is the literal-tagged 4-tuple
//       ['comparator', (x)=>boolean, (a,b)=>boolean, (a,b)=>boolean]
//     written INLINE (PRE forbids a top-level `Comparator<T>` alias). The tag makes
//     comparator? discriminate; the extractor accessors return the bundled predicates.
//   • The type-test/equality/ordering predicates are NOT parameterised over a shared
//     element type T in v1 — make-comparator's three preds are independent values, so
//     a precise cross-pred T-binding would over-constrain. Honest-coarse: type-test is
//     `(x: unknown)=>boolean`, equality/ordering `(a: unknown, b: unknown)=>boolean`. A
//     `Comparator<T>` brand in PRE could thread T — deferred, NOT added (a PRE-level change).
//   • default-comparator / make-default-comparator are NULLARY FUNCTIONS that RETURN a
//     comparator — typed `(): <comparator>`, NOT a value.
//   • =? / <? / … are variadic in the trailing values (chain-relate) → `...rest`.
//
// `?`/punctuation names → bracketed string keys.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  // Construct a comparator. 4th `hash` arg accepted (ignored at runtime) → optional.
  "make-comparator"(
    typeTest: (x: unknown) => boolean,
    equality: (a: unknown, b: unknown) => boolean,
    ordering: (a: unknown, b: unknown) => boolean,
    ...hash: [((x: unknown) => number)?]
  ): readonly [
    "comparator",
    (x: unknown) => boolean,
    (a: unknown, b: unknown) => boolean,
    (a: unknown, b: unknown) => boolean,
  ];

  // The default total-order comparator — both are NULLARY and RETURN a comparator.
  "make-default-comparator"(): readonly [
    "comparator",
    (x: unknown) => boolean,
    (a: unknown, b: unknown) => boolean,
    (a: unknown, b: unknown) => boolean,
  ];
  "default-comparator"(): readonly [
    "comparator",
    (x: unknown) => boolean,
    (a: unknown, b: unknown) => boolean,
    (a: unknown, b: unknown) => boolean,
  ];

  // Tag predicate — accepts any value, returns boolean.
  "comparator?"(x: unknown): boolean;

  // Extractors — pull the bundled predicate back out of a comparator tuple.
  "comparator-type-test-predicate"(
    c: readonly [
      "comparator",
      (x: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
    ],
  ): (x: unknown) => boolean;
  "comparator-equality-predicate"(
    c: readonly [
      "comparator",
      (x: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
    ],
  ): (a: unknown, b: unknown) => boolean;
  "comparator-ordering-predicate"(
    c: readonly [
      "comparator",
      (x: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
    ],
  ): (a: unknown, b: unknown) => boolean;
  // Always #f at runtime, but the signature is still a boolean-returning predicate.
  "comparator-hashable?"(
    c: readonly [
      "comparator",
      (x: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
    ],
  ): boolean;

  // Relational chain ops — (cmp, a, b, …rest) → boolean. Comparator is the FIRST arg.
  "=?"(
    c: readonly [
      "comparator",
      (x: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
    ],
    a: unknown,
    b: unknown,
    ...rest: unknown[]
  ): boolean;
  "<?"(
    c: readonly [
      "comparator",
      (x: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
    ],
    a: unknown,
    b: unknown,
    ...rest: unknown[]
  ): boolean;
  "<=?"(
    c: readonly [
      "comparator",
      (x: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
    ],
    a: unknown,
    b: unknown,
    ...rest: unknown[]
  ): boolean;
  ">?"(
    c: readonly [
      "comparator",
      (x: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
    ],
    a: unknown,
    b: unknown,
    ...rest: unknown[]
  ): boolean;
  ">=?"(
    c: readonly [
      "comparator",
      (x: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
      (a: unknown, b: unknown) => boolean,
    ],
    a: unknown,
    b: unknown,
    ...rest: unknown[]
  ): boolean;
}
