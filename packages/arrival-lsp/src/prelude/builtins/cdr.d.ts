// ─────────────────────────────────────────────────────────────────────────────
// L02 — `cdr` — the REST / TAIL of a list.
//
// Scheme semantics: (cdr list) → all elements of `list` after the first.
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   stdlib.ts:217 · sandbox-env.ts:194
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (`List<T>`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  cdr<T>(xs: List<T>): List<T>;
}
