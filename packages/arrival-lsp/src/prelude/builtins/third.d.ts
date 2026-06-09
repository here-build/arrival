// ─────────────────────────────────────────────────────────────────────────────
// L04 — `third` — third element of a list.
//
// Scheme semantics: (third list) → the third element of a list (index 2),
// equivalent to (car (cdr (cdr list))).
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   sandbox-env.ts:361
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (here `List<T>`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  third<T>(xs: List<T>): T;
}
