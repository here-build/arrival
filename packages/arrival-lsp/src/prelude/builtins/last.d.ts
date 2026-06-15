// ─────────────────────────────────────────────────────────────────────────────
// L<xx> — `last` — last element of a list.
//
// Scheme semantics: (last list) → the final element of a non-empty list.
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   inference-env.ts:352
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (here `List<T>`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  last<T>(xs: List<T>): T;
}
