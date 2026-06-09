// ─────────────────────────────────────────────────────────────────────────────
// L02 — `cons` — prepend an element onto a list (the canonical cons).
//
// Scheme semantics: (cons head tail) → a new list with head prepended to tail.
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   stdlib.ts:210  cons: (args, E) => `[${E.lower(args[0]!)}${tail ? `, ${tail}` : ""}]`
//
// Pattern: re-declare `interface ArrShape` with this ONE member. TS merges this
// into the shared `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  cons<H, T>(head: H, tail: List<T>): List<H | T>;
}
