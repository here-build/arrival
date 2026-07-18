// ─────────────────────────────────────────────────────────────────────────────
// L02 — `list` — variadic list constructor.
//
// Scheme semantics: (list x₀ x₁ … xₙ) → a proper list of the arguments.
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types. TS merges this into the shared `__arr`
// (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  list<T>(...xs: T[]): List<T>;
}
