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
//       ['comparator', (x)=>SBool, (a,b)=>SBool, (a,b)=>SBool]
//     written INLINE (PRE forbids a top-level `Comparator<T>` alias). The tag makes
//     comparator? discriminate; the extractor accessors return the bundled predicates.
//   • The type-test/equality/ordering predicates are NOT parameterised over a shared
//     element type T in v1 — make-comparator's three preds are independent values, so
//     a precise cross-pred T-binding would over-constrain. Honest-coarse: type-test is
//     `(x: unknown)=>SBool`, equality/ordering `(a: unknown, b: unknown)=>SBool`. A
//     `Comparator<T>` brand in PRE could thread T — flagged in the report, NOT added.
//   • default-comparator / make-default-comparator are NULLARY FUNCTIONS that RETURN a
//     comparator — typed `(): <comparator>`, NOT a value.
//   • =? / <? / … are variadic in the trailing values (chain-relate) → `...rest`.
//
// `?`/punctuation names → bracketed string keys.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  // Construct a comparator. 4th `hash` arg accepted (ignored at runtime) → optional.
  "make-comparator"(
    typeTest: (x: unknown) => SBool,
    equality: (a: unknown, b: unknown) => SBool,
    ordering: (a: unknown, b: unknown) => SBool,
    ...hash: [((x: unknown) => SNum)?]
  ): readonly [
    "comparator",
    (x: unknown) => SBool,
    (a: unknown, b: unknown) => SBool,
    (a: unknown, b: unknown) => SBool,
  ];

  // The default total-order comparator — both are NULLARY and RETURN a comparator.
  "make-default-comparator"(): readonly [
    "comparator",
    (x: unknown) => SBool,
    (a: unknown, b: unknown) => SBool,
    (a: unknown, b: unknown) => SBool,
  ];
  "default-comparator"(): readonly [
    "comparator",
    (x: unknown) => SBool,
    (a: unknown, b: unknown) => SBool,
    (a: unknown, b: unknown) => SBool,
  ];

  // Tag predicate — accepts any value, returns SBool.
  "comparator?"(x: unknown): SBool;

  // Extractors — pull the bundled predicate back out of a comparator tuple.
  "comparator-type-test-predicate"(
    c: readonly [
      "comparator",
      (x: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
    ],
  ): (x: unknown) => SBool;
  "comparator-equality-predicate"(
    c: readonly [
      "comparator",
      (x: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
    ],
  ): (a: unknown, b: unknown) => SBool;
  "comparator-ordering-predicate"(
    c: readonly [
      "comparator",
      (x: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
    ],
  ): (a: unknown, b: unknown) => SBool;
  // Always #f at runtime, but the signature is still a SBool-returning predicate.
  "comparator-hashable?"(
    c: readonly [
      "comparator",
      (x: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
    ],
  ): SBool;

  // Relational chain ops — (cmp, a, b, …rest) → SBool. Comparator is the FIRST arg.
  "=?"(
    c: readonly [
      "comparator",
      (x: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
    ],
    a: unknown,
    b: unknown,
    ...rest: unknown[]
  ): SBool;
  "<?"(
    c: readonly [
      "comparator",
      (x: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
    ],
    a: unknown,
    b: unknown,
    ...rest: unknown[]
  ): SBool;
  "<=?"(
    c: readonly [
      "comparator",
      (x: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
    ],
    a: unknown,
    b: unknown,
    ...rest: unknown[]
  ): SBool;
  ">?"(
    c: readonly [
      "comparator",
      (x: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
    ],
    a: unknown,
    b: unknown,
    ...rest: unknown[]
  ): SBool;
  ">=?"(
    c: readonly [
      "comparator",
      (x: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
      (a: unknown, b: unknown) => SBool,
    ],
    a: unknown,
    b: unknown,
    ...rest: unknown[]
  ): SBool;
}
