// ─────────────────────────────────────────────────────────────────────────────
// L01 — `car` — the REFERENCE leaf the other 33 agents replicate.
//
// Scheme semantics: (car list) → the head element of a non-empty list.
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   stdlib.ts:214 · inference-env.ts:193
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (here `List<T>`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  car<T>(xs: List<T>): T;
}
