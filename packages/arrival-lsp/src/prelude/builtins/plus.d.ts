// ─────────────────────────────────────────────────────────────────────────────
// L<+> — `+` — variadic numeric addition.
//
// Scheme semantics: (+ n ...) → the sum of all arguments; (+ ) → 0.
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   stdlib.ts:280 · bridge.ts:527
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (`SNum`). TS merges this into the shared `__arr`
// (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// Operator name `+` is not a valid TS identifier → bracketed string key.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "+"(...n: SNum[]): SNum;
}
