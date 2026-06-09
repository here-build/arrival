// ─────────────────────────────────────────────────────────────────────────────
// L02 — `cadr` — second element (car of cdr) of a list.
//
// Scheme semantics: (cadr xs) → the second element of xs, i.e. (car (cdr xs)).
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   stdlib.ts:69  · stdlib.ts:218
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (here `List<T>`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  cadr<T>(xs: List<T>): T;
}
