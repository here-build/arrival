// ─────────────────────────────────────────────────────────────────────────────
// L<reduce> — `reduce` — left fold over a list with an explicit seed.
//
// Scheme semantics: (reduce fn init list) → fold `fn` over `list`, threading the
// accumulator, seeded by `init`. Arg order is (fn, init, collection); the binary
// `fn` receives (acc, element). Polymorphic in element type A and accumulator
// type B — A may differ from B (e.g. fold a list of strings into a number).
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   inference-env.ts:219  (reduce(this, fn, init, collection) → lipsReduce(fn, init, collection))
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (here `List<T>`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  reduce<A, B>(fn: (acc: B, x: A) => B, init: B, xs: List<A>): B;
}
