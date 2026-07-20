// ─────────────────────────────────────────────────────────────────────────────
// L — SRFI-189 Maybe & Either — the CONTAINER family.
//
// Scheme semantics (constructors/accessors/combinators over Maybe and Either):
//   (just x)              → a Just wrapping x
//   (nothing)             → the empty Maybe
//   (left x) / (right x)  → the two sides of an Either
//   just? / nothing? / maybe? / left? / right? / maybe?  → tag predicates → #t/#f
//   maybe-bind / maybe-map / either-bind / either-map     → monadic combinators
//   maybe-ref / maybe-ref/default / either-ref / …        → unwrap (precise value)
//   maybe->either / maybe->list / either->list / either-swap / list->maybe → coercions
//
// Runtime truth — Maybe/Either are TAGGED LISTS, not opaque boxes
// (the `any` impls these SHARPEN — do NOT import them):
//     (just x)    = (list 'just x)     → JS runtime value  ['just', x]
//     (nothing)   = (list 'nothing)    → ['nothing']
//     (left x)    = (list 'left x)     → ['left', x]
//     (right x)   = (list 'right x)    → ['right', x]
//     just?  m  = (and (pair? m) (eq? (car m) 'just))
//     maybe? m  = (or (just? m) (nothing? m))
//     maybe-ref m         = (car (cdr m)) on Just
//     maybe-bind m f      = (f (car (cdr m))) on Just, else m
//     maybe-map  f m      = (just (f val)) on Just, else m
//     either-bind e f     = (f val) on Right, else e
//     either-swap e       = (left x)<->(right x)
//
// Exposed to the inference env via SAFE_BUILTINS.
//
// MODELING (v1, FAITHFUL-PRECISE — the tagged-list repr is statically expressible):
//   A Maybe<T>  is the literal-tagged tuple  ['just', T] | ['nothing'].
//   An Either   is                            ['left', L] | ['right', R].
// These are EXACTLY the runtime values, so the tags discriminate and T/L/R thread
// through map/bind/ref precisely. Because PRE forbids a top-level `Maybe<T>` alias
// (declaration-merge collision), the union is written INLINE in every signature
// (verbose but honest). A shared `Maybe<T>`/`Either<L,R>` brand in PRE would
// collapse the verbosity — deferred, NOT added here (a PRE-level change).
//
// Tags are written as the runtime symbol strings ('just'/'nothing'/'left'/'right').
// `?`/`>`/`/`-bearing names → bracketed string keys.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  // ── Maybe constructors ──────────────────────────────────────────────────────
  just<T>(x: T): readonly ["just", T];
  nothing(): readonly ["nothing"];

  // ── Either constructors ─────────────────────────────────────────────────────
  left<L>(x: L): readonly ["left", L];
  right<R>(x: R): readonly ["right", R];

  // ── Tag predicates — accept any value (impl guards with pair?), return boolean ─
  // Arg typed `unknown`: these are GUARDS, valid to call on a non-Maybe (→ #f).
  "just?"(m: unknown): boolean;
  "nothing?"(m: unknown): boolean;
  "maybe?"(m: unknown): boolean;
  "left?"(e: unknown): boolean;
  "right?"(e: unknown): boolean;

  // ── Maybe combinators ───────────────────────────────────────────────────────
  // maybe-bind: Nothing short-circuits (returns the Nothing). Result unions the
  // bound function's Maybe with the passed-through Nothing — faithful to the impl.
  "maybe-bind"<T, R extends readonly ["just", unknown] | readonly ["nothing"]>(
    m: readonly ["just", T] | readonly ["nothing"],
    f: (x: T) => R,
  ): R | readonly ["nothing"];
  // maybe-map: maps the wrapped value, preserving Nothing. NOTE: impl arg order is
  // (f m) — function FIRST, unlike maybe-bind's (m f).
  "maybe-map"<T, B>(
    f: (x: T) => B,
    m: readonly ["just", T] | readonly ["nothing"],
  ): readonly ["just", B] | readonly ["nothing"];
  // maybe-ref: unwrap a Just to its value. (Nothing → calls failure thunk / errors;
  // statically the success type is the wrapped T.)
  "maybe-ref"<T>(m: readonly ["just", T] | readonly ["nothing"], ...failure: [(() => T)?]): T;
  // maybe-ref/default: Just value, else the default D — honest union.
  "maybe-ref/default"<T, D>(m: readonly ["just", T] | readonly ["nothing"], dflt: D): T | D;

  // ── Maybe ⇄ Either / List coercions ─────────────────────────────────────────
  // maybe->either: Just x → (right x); Nothing → (left no-just).
  "maybe->either"<T, N>(
    m: readonly ["just", T] | readonly ["nothing"],
    noJust: N,
  ): readonly ["right", T] | readonly ["left", N];
  // maybe->list: Just x → (x); Nothing → ().
  "maybe->list"<T>(m: readonly ["just", T] | readonly ["nothing"]): List<T>;
  // list->maybe: () → Nothing; (x …) → (just x).
  "list->maybe"<T>(lst: List<T>): readonly ["just", T] | readonly ["nothing"];

  // ── Either combinators ──────────────────────────────────────────────────────
  // either-bind: Left short-circuits. (e f) — Either FIRST.
  "either-bind"<L, R, O extends readonly ["left", unknown] | readonly ["right", unknown]>(
    e: readonly ["left", L] | readonly ["right", R],
    f: (x: R) => O,
  ): O | readonly ["left", L];
  // either-map: maps a Right, preserving Left. (f e) — function FIRST.
  "either-map"<L, R, B>(
    f: (x: R) => B,
    e: readonly ["left", L] | readonly ["right", R],
  ): readonly ["left", L] | readonly ["right", B];
  // either-ref: unwrap a Right to its value (Left → failure/error).
  "either-ref"<L, R>(e: readonly ["left", L] | readonly ["right", R], ...failure: [((l: L) => R)?]): R;
  // either-ref/default: Right value, else default D.
  "either-ref/default"<L, R, D>(e: readonly ["left", L] | readonly ["right", R], dflt: D): R | D;
  // either-swap: (left x) ⇄ (right x) — sides flip, payload types swap roles.
  "either-swap"<L, R>(e: readonly ["left", L] | readonly ["right", R]): readonly ["right", L] | readonly ["left", R];
  // either->list: Right x → (x); Left → ().
  "either->list"<L, R>(e: readonly ["left", L] | readonly ["right", R]): List<R>;
}
