// ─────────────────────────────────────────────────────────────────────────────
// L02 — `first` — first element of a list (alias of `car`).
//
// Scheme semantics: (first list) → the head element of a non-empty list.
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   stdlib.ts:71 · stdlib.ts:221 · sandbox-env.ts:351
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (here `List<T>`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  first<T>(xs: List<T>): T;
}
