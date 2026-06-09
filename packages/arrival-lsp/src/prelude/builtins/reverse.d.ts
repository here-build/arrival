// ─────────────────────────────────────────────────────────────────────────────
// L — `reverse` — reverses a list.
//
// Scheme semantics: (reverse list) → a new list with elements in reverse order.
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   stdlib.ts:223
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (`List<T>`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  reverse<T>(xs: List<T>): List<T>;
}
