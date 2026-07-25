// ─────────────────────────────────────────────────────────────────────────────
// `reduce` — left fold over a list with an explicit seed.
//
// Scheme semantics: (reduce fn init list) → fold `fn` over `list`, threading the
// accumulator, seeded by `init`. Arg order is (fn, init, collection); the binary
// `fn` receives (acc, element). Polymorphic in element type A and accumulator
// type B — A may differ from B (e.g. fold a list of strings into a number).
// // ─────────────────────────────────────────────────────────────────────────────

declare function reduce<A, B>(fn: (acc: B, x: A) => B, init: B, xs: List<A>): B;
